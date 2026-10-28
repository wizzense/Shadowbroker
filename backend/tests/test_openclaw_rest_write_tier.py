"""REST writes under /api/ai/* follow the same access tier as the command channel.

A restricted-tier OpenClaw agent cannot place_pin / create_layer / inject_data
over the channel; before this check it could do the same through
POST /api/ai/pins, /api/ai/layers and /api/ai/inject. Local-operator and
admin-key callers are unaffected, and reads stay open to every tier.
"""

import hashlib
import hmac as hmac_mod
import json
import secrets
import time

import pytest

HMAC_SECRET = "test-rest-write-tier-secret"


def _sign(method: str, path: str, body: bytes = b"") -> dict[str, str]:
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    message = f"{method.upper()}|{path}|{ts}|{nonce}|{hashlib.sha256(body).hexdigest()}"
    sig = hmac_mod.new(HMAC_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()
    return {"X-SB-Timestamp": ts, "X-SB-Nonce": nonce, "X-SB-Signature": sig}


def _signed(rc, method: str, path: str, payload: dict | None = None):
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode() if payload is not None else b""
    headers = _sign(method, path.split("?", 1)[0], body)
    if payload is not None:
        headers["Content-Type"] = "application/json"
    return getattr(rc, method.lower())(path, content=body, headers=headers) if payload is not None \
        else getattr(rc, method.lower())(path, headers=headers)


@pytest.fixture(autouse=True)
def _openclaw(monkeypatch):
    import auth
    from services import ai_pin_store

    monkeypatch.setattr(auth, "_openclaw_hmac_secret", lambda: HMAC_SECRET)
    auth._openclaw_nonce_cache.clear()
    monkeypatch.setattr(auth, "_OPENCLAW_STARTUP_TIME", time.time() - 300)
    monkeypatch.setattr(ai_pin_store, "_save_to_disk", lambda: None)
    saved_layers, saved_pins = list(ai_pin_store._layers), list(ai_pin_store._pins)
    yield
    ai_pin_store._layers[:] = saved_layers
    ai_pin_store._pins[:] = saved_pins


def _tier(monkeypatch, tier: str):
    import auth

    monkeypatch.setattr(auth, "_openclaw_access_tier", lambda: tier)


PIN = {"lat": 39.1, "lng": -84.5, "label": "tier test"}
LAYER = {"name": "tier test layer"}
BAD_INJECT = {"layer": "not_an_injectable_layer", "items": []}


@pytest.mark.parametrize(
    "method,path,payload",
    [
        ("POST", "/api/ai/pins", PIN),
        ("POST", "/api/ai/layers", LAYER),
        ("POST", "/api/ai/inject", BAD_INJECT),
        ("POST", "/api/ai/pins/batch", {"pins": [PIN]}),
        ("DELETE", "/api/ai/pins/nonexistent", None),
        ("DELETE", "/api/ai/layers/nonexistent", None),
        ("DELETE", "/api/ai/inject?layer=ships", None),
    ],
)
def test_restricted_agent_cannot_write(remote_client, monkeypatch, method, path, payload):
    _tier(monkeypatch, "restricted")
    r = _signed(remote_client, method, path, payload)
    assert r.status_code == 403, r.text
    assert "full OpenClaw access tier" in r.json()["detail"]


def test_full_tier_agent_can_write(remote_client, monkeypatch):
    from services import ai_pin_store

    _tier(monkeypatch, "full")
    pin = _signed(remote_client, "POST", "/api/ai/pins", PIN)
    assert pin.status_code == 200, pin.text
    assert any(p["id"] == pin.json()["pin"]["id"] for p in ai_pin_store._pins)

    layer = _signed(remote_client, "POST", "/api/ai/layers", LAYER)
    assert layer.status_code == 200, layer.text

    # Past the tier check, inject validates its payload: 400, not 403.
    inject = _signed(remote_client, "POST", "/api/ai/inject", BAD_INJECT)
    assert inject.status_code == 400, inject.text


def test_restricted_agent_can_still_read(remote_client, monkeypatch):
    _tier(monkeypatch, "restricted")
    assert _signed(remote_client, "GET", "/api/ai/pins").status_code == 200
    assert _signed(remote_client, "GET", "/api/ai/layers").status_code == 200
    assert _signed(remote_client, "GET", "/api/ai/pins/geojson").status_code == 200


def test_local_operator_writes_regardless_of_tier(client, monkeypatch):
    _tier(monkeypatch, "restricted")
    r = client.post("/api/ai/pins", json=PIN)
    assert r.status_code == 200, r.text


def test_unsigned_remote_write_is_still_refused(remote_client, monkeypatch):
    _tier(monkeypatch, "full")
    r = remote_client.post("/api/ai/pins", json=PIN)
    assert r.status_code == 403


def test_tier_lookup_fails_closed(monkeypatch):
    import auth

    def boom():
        raise RuntimeError("settings unavailable")

    monkeypatch.setattr(auth, "get_settings", boom)
    assert auth._openclaw_access_tier() == "restricted"
