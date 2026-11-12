"""SHADOWBROKER_PUBLIC_READ_ROUTES: anonymous visitors may READ public map data,
never reach the operator surface.

A public deployment sits behind a reverse proxy, so every browser arrives from
a non-loopback address and, since issue #250, is no longer an implicit local
operator. Turning bridge trust back on would also hand the internet the API-key
store, the agent shell and wormhole control. The flag opens only an explicit
allowlist of side-effect-free GETs.
"""

import importlib.util

import pytest

# routers.agent_shell imports fcntl (POSIX only); on Windows it is not mounted
# at all, so there is no route to probe.
_posix_only = pytest.mark.skipif(
    importlib.util.find_spec("fcntl") is None, reason="agent_shell router needs fcntl (POSIX)"
)

PUBLIC_READ_ROUTES = [
    "/api/layers",
    "/api/liveuamap/scraper-status",
    "/api/prediction-markets/status",
    "/api/ai/pins",
    "/api/ai/pins/geojson",
    "/api/ai/timemachine/snapshots",
    "/api/ai/timemachine/hourly-index",
    "/api/ai/timemachine/config",
    "/api/ai/layers",
]

# Must stay operator-only even with the flag on.
OPERATOR_ONLY = [
    ("get", "/api/settings/api-keys", None),
    ("put", "/api/settings/api-keys", {"env_key": "OPENSKY_CLIENT_ID", "value": "x"}),
    pytest.param("get", "/api/agent-shell/settings", None, marks=_posix_only),
    pytest.param("post", "/api/agent-shell/ws-token", {}, marks=_posix_only),
    pytest.param("put", "/api/agent-shell/settings", {}, marks=_posix_only),
    ("get", "/api/wormhole/identity", None),
    ("post", "/api/wormhole/connect", {}),
    ("get", "/api/ai/agent-actions", None),  # destructive read (drains the queue)
    ("get", "/api/settings/timemachine", None),  # archival posture (#253)
    ("get", "/api/tools/shodan/status", None),
    ("post", "/api/ai/layers", {"name": "x"}),
    ("post", "/api/layers", {"layers": {"viirs_nightlights": True}}),
    ("post", "/api/prediction-markets/opt-in", {"opted_in": True}),
    ("post", "/api/liveuamap/scraper-opt-in", {"opted_in": True}),
    ("put", "/api/ai/timemachine/config", {"preset": "paranoid"}),
    ("delete", "/api/ai/timemachine/snapshots", None),
    ("post", "/api/ai/pins", {"lat": 0, "lng": 0, "label": "x"}),
    ("delete", "/api/ai/pins", None),
]


@pytest.fixture
def public_read_on(monkeypatch):
    monkeypatch.setenv("SHADOWBROKER_PUBLIC_READ_ROUTES", "true")


@pytest.fixture
def public_read_off(monkeypatch):
    monkeypatch.delenv("SHADOWBROKER_PUBLIC_READ_ROUTES", raising=False)


def _call(client, method, path, payload):
    fn = getattr(client, method)
    return fn(path, json=payload) if payload is not None else fn(path)


@pytest.mark.parametrize("path", PUBLIC_READ_ROUTES)
def test_public_read_route_is_200_without_a_key_when_enabled(remote_client, public_read_on, path):
    assert remote_client.get(path).status_code == 200


@pytest.mark.parametrize("path", PUBLIC_READ_ROUTES)
def test_public_read_route_stays_403_when_flag_off(remote_client, public_read_off, path):
    assert remote_client.get(path).status_code == 403


def test_layers_returns_the_layer_map(remote_client, public_read_on):
    body = remote_client.get("/api/layers").json()
    assert isinstance(body.get("layers"), dict) and body["layers"]


@pytest.mark.parametrize(("method", "path", "payload"), OPERATOR_ONLY)
def test_operator_surface_stays_403_with_flag_on(remote_client, public_read_on, method, path, payload):
    assert _call(remote_client, method, path, payload).status_code == 403


@pytest.mark.parametrize("value", ["", "0", "false", "off", "no"])
def test_flag_parsing_is_default_off(monkeypatch, value):
    import auth

    monkeypatch.setenv("SHADOWBROKER_PUBLIC_READ_ROUTES", value)
    assert auth._public_read_routes_enabled() is False


def test_non_get_never_counts_as_public_read(monkeypatch):
    import auth

    monkeypatch.setenv("SHADOWBROKER_PUBLIC_READ_ROUTES", "1")

    class _Req:
        method = "POST"

    assert auth._is_public_read_request(_Req()) is False


def test_public_ai_layers_hide_operator_feed_config(remote_client, public_read_on, monkeypatch):
    import services.ai_pin_store as store

    monkeypatch.setattr(
        store,
        "get_layers",
        lambda: [
            {
                "id": "l1",
                "name": "Watch",
                "color": "#f00",
                "visible": True,
                "pin_count": 2,
                "feed_url": "https://private.example/feed?token=secret",
                "feed_interval": 300,
                "feed_last_fetched": 1.0,
            }
        ],
    )
    body = remote_client.get("/api/ai/layers").json()
    assert body["count"] == 1
    layer = body["layers"][0]
    assert layer["name"] == "Watch" and layer["pin_count"] == 2
    for field in ("feed_url", "feed_interval", "feed_last_fetched"):
        assert field not in layer
