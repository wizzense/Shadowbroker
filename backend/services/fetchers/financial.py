import logging
import math
import random
import time
import os
import urllib.request
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from services.fetchers._store import latest_data, _data_lock, _mark_fresh
from services.fetchers.retry import with_retry

logger = logging.getLogger(__name__)

_YFINANCE_REQUEST_DELAY_SECONDS = 0.5
_YFINANCE_REQUEST_JITTER_SECONDS = 0.2

TICKERS_DEFENSE = ["RTX", "LMT", "NOC", "GD", "BA", "PLTR"]
TICKERS_TECH = ["NVDA", "AMD", "TSM", "INTC", "GOOGL", "AMZN", "MSFT", "AAPL", "TSLA", "META", "NFLX", "SMCI", "ARM", "ASML"]
TICKERS_CRYPTO = [
    ("BTC", "BINANCE:BTCUSDT", "BTC-USD"),
    ("ETH", "BINANCE:ETHUSDT", "ETH-USD"),
    ("SOL", "BINANCE:SOLUSDT", "SOL-USD"),
    ("XRP", "BINANCE:XRPUSDT", "XRP-USD"),
    ("ADA", "BINANCE:ADAUSDT", "ADA-USD"),
]

# Operator watchlist: FINANCIAL_WATCHLIST="DJT,TSLA,XOM" adds symbols to the
# stock rotation. Malformed entries are dropped, duplicates collapse, and the
# list is capped so a long env value cannot multiply Yahoo/Finnhub calls.
_WATCHLIST_MAX = 40
_SYMBOL_OK = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-^=")


def parse_watchlist(raw: str | None) -> list[str]:
    out: list[str] = []
    for part in (raw or "").split(","):
        sym = part.strip().upper()
        if not sym or len(sym) > 12 or not set(sym) <= _SYMBOL_OK or sym in out:
            continue
        out.append(sym)
        if len(out) >= _WATCHLIST_MAX:
            break
    return out


def stock_symbols() -> list[str]:
    """Built-in tech + defense tickers, then the operator watchlist, deduped."""
    base = TICKERS_TECH + TICKERS_DEFENSE
    return base + [s for s in parse_watchlist(os.environ.get("FINANCIAL_WATCHLIST")) if s not in base]


# Ticker priority for high-frequency updates (we update these every tick)
PRIORITY_SYMBOLS = ["BTC", "ETH", "NVDA", "PLTR"]

# Persistence for state between short-lived scheduler ticks
_last_fetch_results = {}
_last_fetch_time = 0.0
_rotating_index = 0
_executor = ThreadPoolExecutor(max_workers=10)


def _fetch_finnhub_quote(symbol: str, api_key: str):
    """Fetch from Finnhub. Returns (symbol, data) or (symbol, None)."""
    url = f"https://finnhub.io/api/v1/quote?symbol={symbol}&token={api_key}"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            if "c" not in data or data["c"] == 0:
                return symbol, None
            current = float(data["c"])
            change_p = float(data.get("dp", 0.0) or 0.0)
            return symbol, {
                "price": round(current, 2),
                "change_percent": round(change_p, 2),
                "up": bool(change_p >= 0),
            }
    except Exception as e:
        logger.debug(f"Finnhub error for {symbol}: {e}")
        return symbol, None


def _fetch_yfinance_single(symbol: str, period: str = "2d"):
    """Fetch from yfinance. Returns (symbol, data) or (symbol, None)."""
    try:
        import yfinance as yf
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period=period)
        if len(hist) >= 1:
            current_price = hist["Close"].iloc[-1]
            prev_close = hist["Close"].iloc[0] if len(hist) > 1 else current_price
            change_percent = ((current_price - prev_close) / prev_close) * 100 if prev_close else 0
            current_price_f = float(current_price)
            change_percent_f = float(change_percent)
            if not math.isfinite(current_price_f) or not math.isfinite(change_percent_f):
                return symbol, None
            return symbol, {
                "price": round(current_price_f, 2),
                "change_percent": round(change_percent_f, 2),
                "up": bool(change_percent_f >= 0),
            }
    except Exception as e:
        logger.debug(f"Yfinance error for {symbol}: {e}")
    # yfinance's impersonating HTTP session gets connection-reset by Yahoo while
    # the public chart endpoint still answers a plain request; try that before
    # giving up on the symbol.
    return symbol, _fetch_yahoo_chart(symbol)


def _quote_from_chart(payload: dict):
    """Build a quote from a Yahoo v8 chart payload, or None."""
    try:
        result = payload["chart"]["result"][0]
        closes = [c for c in result["indicators"]["quote"][0]["close"] if c is not None]
        meta = result.get("meta") or {}
        price = float(meta.get("regularMarketPrice") or closes[-1])
        prev = float(meta.get("chartPreviousClose") or (closes[0] if len(closes) > 1 else price))
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    change = ((price - prev) / prev) * 100 if prev else 0.0
    if not math.isfinite(price) or not math.isfinite(change):
        return None
    return {"price": round(price, 2), "change_percent": round(change, 2), "up": bool(change >= 0)}


def _fetch_yahoo_chart(symbol: str):
    from urllib.parse import quote

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?range=2d&interval=1d"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return _quote_from_chart(json.loads(resp.read().decode("utf-8")))
    except Exception as e:
        logger.debug(f"Yahoo chart error for {symbol}: {e}")
        return None


@with_retry(max_retries=1, base_delay=1)
def financial_fetch_enabled() -> bool:
    """Return True only when the operator explicitly opts into financial pulls.

    Either ``FINANCIAL_ENABLED=true`` or the presence of ``FINNHUB_API_KEY``
    counts as an explicit opt-in. Without either, the default yfinance path
    is disabled to avoid silent outbound calls to finance.yahoo.com.
    """
    if os.getenv("FINNHUB_API_KEY", "").strip():
        return True
    return str(os.environ.get("FINANCIAL_ENABLED", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def fetch_financial_markets():
    """Fetches full market list with smart throttling (3s for Finnhub, 60s for yfinance)."""
    global _last_fetch_time, _last_fetch_results, _rotating_index

    if not financial_fetch_enabled():
        logger.debug(
            "Financial fetch skipped; set FINANCIAL_ENABLED=true or supply "
            "FINNHUB_API_KEY to opt in"
        )
        with _data_lock:
            latest_data["financial"] = {}
        _mark_fresh("financial")
        return

    finnhub_key = os.getenv("FINNHUB_API_KEY", "").strip()
    use_finnhub = bool(finnhub_key)
    
    now = time.time()
    # Throttle logic: 3s for Finnhub, 60s for yfinance fallback
    throttle_s = 3.0 if use_finnhub else 60.0
    
    if now - _last_fetch_time < throttle_s and _last_fetch_results:
        return # Skip if too frequent

    _last_fetch_time = now
    
    # Prepare symbol lists
    all_crypto = {label: (f_sym, y_sym) for label, f_sym, y_sym in TICKERS_CRYPTO}
    all_stocks = stock_symbols()
    
    subset_to_fetch = []
    
    if use_finnhub:
        # Finnhub Free Limit: 60/min. 
        # Ticking every 3s = 20 ticks/min. 
        # To stay safe, we fetch only ~3 items per tick.
        # Priority items (BTC, ETH) + 1 rotating item.
        subset_to_fetch = ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"]
        
        # Determine rotating ticker
        all_other_symbols = []
        for sym in all_stocks:
            all_other_symbols.append(sym)
        for label, (f_sym, y_sym) in all_crypto.items():
            if label not in ["BTC", "ETH"]:
                all_other_symbols.append(f_sym)
        
        if all_other_symbols:
            rotated = all_other_symbols[_rotating_index % len(all_other_symbols)]
            subset_to_fetch.append(rotated)
            _rotating_index += 1
            
        # Concurrently fetch
        futures = [_executor.submit(_fetch_finnhub_quote, s, finnhub_key) for s in subset_to_fetch]
        for f in futures:
            sym, data = f.result()
            if data:
                # Map back to readable label if it was crypto
                label = sym
                for l, (fs, ys) in all_crypto.items():
                    if fs == sym:
                        label = l
                        break
                _last_fetch_results[label] = data
    else:
        # Yahoo Finance Fallback - fetch all (once per minute)
        logger.info("Finnhub key missing, using Yahoo Finance 60s update cycle.")
        to_fetch = all_stocks + [y_sym for l, (fs, y_sym) in all_crypto.items()]
        futures = [_executor.submit(_fetch_yfinance_single, s) for s in to_fetch]
        for f in futures:
            sym, data = f.result()
            if data:
                # Map back to readable label if it was crypto
                label = sym
                for l, (fs, ys) in all_crypto.items():
                    if ys == sym:
                        label = l
                        break
                _last_fetch_results[label] = data

    if not _last_fetch_results:
        return
        
    with _data_lock:
        latest_data["stocks"] = dict(_last_fetch_results)
        latest_data["financial_source"] = "finnhub" if use_finnhub else "yfinance"
    _mark_fresh("stocks")
