import ast
from pathlib import Path

MAIN = Path(__file__).resolve().parents[1] / "main.py"


def _flag_fn():
    tree = ast.parse(MAIN.read_text(encoding="utf-8"))
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
              and n.name == "_mesh_agent_channel_enabled")
    ns = {"os": __import__("os")}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(MAIN), "exec"), ns)
    return ns["_mesh_agent_channel_enabled"]


def test_flag_default_off(monkeypatch):
    monkeypatch.delenv("MESH_AGENT_CHANNEL", raising=False)
    assert _flag_fn()() is False


def test_flag_on_values(monkeypatch):
    for v in ("1", "true", "YES"):
        monkeypatch.setenv("MESH_AGENT_CHANNEL", v)
        assert _flag_fn()() is True
    monkeypatch.setenv("MESH_AGENT_CHANNEL", "no")
    assert _flag_fn()() is False


def test_mesh_only_branch_uses_flag_for_ai_intel():
    src = MAIN.read_text(encoding="utf-8")
    block = src.split("if _MESH_ONLY:\n    # Empty routers", 1)[1].split("\nelse:", 1)[0]
    assert "_mesh_agent_channel_enabled()" in block
    assert '_load_optional_router("routers.ai_intel")' in block
