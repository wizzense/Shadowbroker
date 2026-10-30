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


def test_stock_symbols_default_unchanged(monkeypatch):
    monkeypatch.delenv("FINANCIAL_WATCHLIST", raising=False)
    assert f.stock_symbols() == f.TICKERS_TECH + f.TICKERS_DEFENSE
