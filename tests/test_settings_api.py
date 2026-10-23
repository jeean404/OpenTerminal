"""设置页 REST 面：/api/skills* 与 /api/mcp-servers*。"""

from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from openterminal.config import Config
from openterminal.skills.store import user_skill_dir
from openterminal.web.server import create_app


def _client(monkeypatch, token: str = "") -> TestClient:
    import openterminal.web.server as web_server

    class FakeWorker:
        tab_id = "fake-tab"

        def __init__(self, cfg, target):
            pass

        async def close(self):
            pass

    monkeypatch.setattr(web_server, "TabWorker", FakeWorker)
    return TestClient(create_app(Config.load(), token=token))


def _skill_md(name: str, description: str = "测试技能") -> bytes:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n正文\n".encode()


# --- 技能 ---

def test_skill_list_create_toggle_delete(monkeypatch):
    client = _client(monkeypatch)
    listed = client.get("/api/skills").json()
    assert any(s["name"] == "markdown-tables" for s in listed["skills"])

    created = client.post("/api/skills", json={
        "name": "web-made", "description": "接口建的技能", "body": "正文",
    })
    assert created.status_code == 200
    assert created.json()["builtin"] is False

    toggled = client.post("/api/skills/web-made/enabled", json={"enabled": False})
    assert toggled.status_code == 200
    entry = {s["name"]: s for s in client.get("/api/skills").json()["skills"]}
    assert entry["web-made"]["enabled"] is False

    removed = client.delete("/api/skills/web-made")
    assert removed.status_code == 200
    assert removed.json()["deleted"] is True


def test_skill_upload_md_and_import_dir(monkeypatch, tmp_path):
    client = _client(monkeypatch)
    up = client.post("/api/skills/upload", json={
        "filename": "up.md",
        "data": base64.b64encode(_skill_md("uploaded")).decode(),
    })
    assert up.status_code == 200
    assert [s["name"] for s in up.json()["installed"]] == ["uploaded"]

    source = tmp_path / "local-skill"
    source.mkdir()
    (source / "SKILL.md").write_text(
        _skill_md("local-import").decode(), encoding="utf-8")
    imp = client.post("/api/skills/import", json={"path": str(source)})
    assert imp.status_code == 200
    assert imp.json()["name"] == "local-import"
    assert (user_skill_dir("local-import") / "SKILL.md").is_file()


def test_skill_delete_builtin_rejected_and_bad_payload_400(monkeypatch):
    client = _client(monkeypatch)
    assert client.delete("/api/skills/markdown-tables").status_code == 400
    assert client.get("/api/skills/nope").status_code == 404
    bad = client.post("/api/skills", json={"name": "Bad Name", "description": "x"})
    assert bad.status_code == 400
    assert client.post("/api/skills/upload", json={"data": "!!not-base64!!"
                       }).status_code == 400


# --- MCP 服务器 ---

def test_mcp_crud_toggle_and_probe(monkeypatch):
    client = _client(monkeypatch)
    created = client.post("/api/mcp-servers", json={
        "name": "文件系统", "transport": "stdio",
        "command": "npx", "args": ["-y", "pkg"],
    })
    assert created.status_code == 200
    server_id = created.json()["id"]

    assert client.get("/api/mcp-servers").json()["servers"][0]["name"] == "文件系统"
    assert client.put(f"/api/mcp-servers/{server_id}", json={
        "name": "文件系统2", "transport": "stdio",
        "command": "ot-definitely-missing-binary",
    }).status_code == 200

    assert client.post(f"/api/mcp-servers/{server_id}/enabled",
                       json={"enabled": False}).status_code == 200

    # 连接测试：起不来的命令要回 ok=false + 具体原因，而不是 5xx
    probed = client.post(f"/api/mcp-servers/{server_id}/probe")
    assert probed.status_code == 200
    body = probed.json()
    assert body["ok"] is False
    assert body["error"], "连接失败必须说清楚原因"

    assert client.delete(f"/api/mcp-servers/{server_id}").status_code == 200
    assert client.delete(f"/api/mcp-servers/{server_id}").status_code == 404


def test_mcp_validation_errors_are_400(monkeypatch):
    client = _client(monkeypatch)
    assert client.post("/api/mcp-servers", json={
        "name": "x", "transport": "stdio",
    }).status_code == 400
    assert client.post("/api/mcp-servers", json={
        "name": "y", "transport": "streamable_http", "url": "ftp://nope",
    }).status_code == 400
    assert client.post("/api/mcp-servers/missing/enabled",
                       json={"enabled": True}).status_code == 404
    assert client.put("/api/mcp-servers/missing", json={
        "name": "z", "transport": "stdio", "command": "x",
    }).status_code == 404


def test_settings_routes_require_token(monkeypatch):
    client = _client(monkeypatch, token="secret")
    for method, url in (("get", "/api/skills"), ("get", "/api/mcp-servers")):
        assert getattr(client, method)(url).status_code == 401, url
    # POST 带 body 才进 handler（FastAPI 先做 body 校验，与 model-profiles 同）
    for url in ("/api/skills", "/api/mcp-servers"):
        assert client.post(url, json={}).status_code == 401, url

    ok = client.get("/api/skills", headers={"x-ot-token": "secret"})
    assert ok.status_code == 200
