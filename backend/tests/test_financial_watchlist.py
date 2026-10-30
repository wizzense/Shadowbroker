from services.fetchers import financial as f


def test_parse_watchlist_cleans_and_dedupes():
    assert f.parse_watchlist(" djt, TSLA ,tsla,,BRK.B,^GSPC ") == ["DJT", "TSLA", "BRK.B", "^GSPC"]


def test_parse_watchlist_drops_malformed():
    assert f.parse_watchlist("GOOD,bad sym,X;rm,WAYTOOLONGSYMBOL1") == ["GOOD"]
    assert f.parse_watchlist(None) == []


def test_parse_watchlist_is_capped():
    raw = ",".join(f"S{i}" for i in range(100))
    assert len(f.parse_watchlist(raw)) == f._WATCHLIST_MAX


def test_stock_symbols_appends_watchlist_without_duplicates(monkeypatch):
    monkeypatch.setenv("FINANCIAL_WATCHLIST", "DJT,NVDA,XOM")
    syms = f.stock_symbols()
    assert syms[: len(f.TICKERS_TECH)] == f.TICKERS_TECH
    assert syms.count("NVDA") == 1
    assert syms[-2:] == ["DJT", "XOM"]


def _chart(price, prev, closes):
    return {"chart": {"result": [{"meta": {"regularMarketPrice": price, "chartPreviousClose": prev},
                                  "indicators": {"quote": [{"close": closes}]}}]}}


def test_quote_from_chart_uses_meta():
    q = f._quote_from_chart(_chart(110.0, 100.0, [100.0, 110.0]))
    assert q == {"price": 110.0, "change_percent": 10.0, "up": True}


def test_quote_from_chart_falls_back_to_closes_and_skips_nulls():
    q = f._quote_from_chart(_chart(None, None, [50.0, None, 45.0]))
    assert q == {"price": 45.0, "change_percent": -10.0, "up": False}


def test_quote_from_chart_rejects_garbage():
    assert f._quote_from_chart({"chart": {"result": None}}) is None
    assert f._quote_from_chart({}) is None


def test_yfinance_failure_falls_back_to_chart(monkeypatch):
    monkeypatch.setattr(f, "_fetch_yahoo_chart", lambda s: {"price": 1.0, "change_percent": 0.0, "up": True})
    import sys, types
    boom = types.SimpleNamespace(Ticker=lambda s: (_ for _ in ()).throw(RuntimeError("reset")))
    monkeypatch.setitem(sys.modules, "yfinance", boom)
    assert f._fetch_yfinance_single("XOM") == ("XOM", {"price": 1.0, "change_percent": 0.0, "up": True})


def test_stock_symbols_default_unchanged(monkeypatch):
    monkeypatch.delenv("FINANCIAL_WATCHLIST", raising=False)
    assert f.stock_symbols() == f.TICKERS_TECH + f.TICKERS_DEFENSE
