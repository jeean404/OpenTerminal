from fastapi.testclient import TestClient

from openterminal.config import Config, TargetConfig
from openterminal.connections import (
    find_saved_target, load_saved_targets, save_saved_targets,
)
from openterminal.web.server import _resolve_target_name, create_app


def test_api_targets_payload():
    save_saved_targets([
        TargetConfig(name="web01", mode="ssh", host="10.0.0.20", user="root"),
        TargetConfig(name="prod", mode="ssh", host="p.example.com"),
    ])
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.get("/api/targets")
        assert r.status_code == 200
        data = r.json()
        assert data["local"] is True
        assert [t["name"] for t in data["direct"]] == ["web01", "prod"]
        assert "jumps" not in data


def test_model_profile_crud_and_activation(monkeypatch, tmp_path):
    import openterminal.model_profiles as profiles
    import openterminal.web.server as web_server

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    keys = {}
    monkeypatch.setattr(
        profiles, "store_model_api_key",
        lambda profile_id, key: keys.__setitem__(profile_id, key) or True)
    monkeypatch.setattr(profiles, "load_model_api_key",
                        lambda profile_id: keys.get(profile_id))
    monkeypatch.setattr(profiles, "delete_model_api_key",
                        lambda profile_id: keys.pop(profile_id, None) is not None)
    created_tabs = []

    class FakeWorker:
        tab_id = "fake-tab"

        def __init__(self, cfg, target):
            created_tabs.append((cfg, target))

        async def close(self):
            pass

    monkeypatch.setattr(web_server, "TabWorker", FakeWorker)
    app = create_app(Config.load())
    with TestClient(app) as client:
        created = client.post("/api/model-profiles", json={
            "name": "本地 Anthropic", "provider": "anthropic",
            "base_url": "http://localhost:15721", "model": "claude-sonnet-4-6",
            "api_key": "secret-value",
        })
        assert created.status_code == 200
        profile = created.json()
        assert profile["has_api_key"] is True
        assert "secret-value" not in created.text

        listed = client.get("/api/model-profiles").json()
        assert listed == {"profiles": [profile], "active_id": None}
        assert client.post(
            f"/api/model-profiles/{profile['id']}/activate"
        ).status_code == 200

        updated = client.put(f"/api/model-profiles/{profile['id']}", json={
            "name": "本地 OpenAI", "provider": "openai", "base_url": "",
            "model": "gpt-4.1", "api_key": "",
        })
        assert updated.status_code == 200
        assert keys[profile["id"]] == "secret-value"

        from openterminal.model_profiles import active_model_config

        active = active_model_config(Config.load().model)
        assert (active.provider, active.base_url, active.model, active.api_key) == (
            "openai", "", "gpt-4.1", "secret-value")
        assert active.api_key_env == ""
        tab = client.post("/api/tabs", json={"target": "local"})
        assert tab.status_code == 200 and tab.json()["tab_id"] == "fake-tab"
        assert created_tabs[0][0].model.model == "gpt-4.1"
        assert client.put("/api/model-profiles/missing", json={
            "name": "missing", "provider": "openai", "model": "gpt-4.1",
        }).status_code == 404
        cleared = client.put(f"/api/model-profiles/{profile['id']}", json={
            "name": "本地 OpenAI", "provider": "openai", "base_url": "",
            "model": "gpt-4.1", "clear_api_key": True,
        })
        assert cleared.status_code == 200
        assert cleared.json()["has_api_key"] is False

        assert client.delete(
            f"/api/model-profiles/{profile['id']}"
        ).status_code == 200
        assert keys == {}
        assert client.get("/api/model-profiles").json()["active_id"] is None


def test_model_profile_validation_and_token(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    app = create_app(Config.load(), token="secret")
    with TestClient(app) as client:
        assert client.get("/api/model-profiles").status_code == 401
        response = client.post("/api/model-profiles", headers={
            "x-ot-token": "secret",
        }, json={"name": "missing", "provider": "invalid", "model": ""})
        assert response.status_code == 400


def test_api_saved_endpoint(tmp_path):
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.post("/api/saved", json={"target": "root@9.9.9.9:2222"})
        assert r.status_code == 200
        assert client.post("/api/jumps",
                           json={"target": "admin@10.0.0.5"}).status_code == 404
    saved = load_saved_targets()
    assert any(t.host == "9.9.9.9" for t in saved)


def test_token_required_on_non_local_binding():
    app = create_app(Config.load(), token="secret")
    with TestClient(app) as client:
        assert client.get("/api/targets").status_code == 401
        r = client.get("/api/targets", headers={"x-ot-token": "secret"})
        assert r.status_code == 200


def test_resolve_target_name_from_saved():
    # 回归：侧栏点记住的连接时，必须保留 host/user，
    # 而不是被当 user@host 重新解析丢掉连接信息
    save_saved_targets([TargetConfig(
        name="web01", mode="ssh", host="10.0.0.20", user="root")])
    cfg = Config.load()
    name = _resolve_target_name(cfg, "web01")
    assert name == "web01"
    t = cfg.targets["web01"]
    assert (t.host, t.user) == ("10.0.0.20", "root")


# --- 表单化 CRUD（Web 添加/编辑/删除 主机）---


def test_api_saved_crud_structured():
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.post("/api/saved", json={
            "name": "web01", "host": "10.0.0.20", "port": 22,
            "user": "root"})
        assert r.status_code == 200 and r.json()["name"] == "web01"
        assert find_saved_target("web01").host == "10.0.0.20"

        r = client.put("/api/saved/web01", json={
            "name": "web01", "host": "10.0.0.21", "port": 2222, "user": "root"})
        assert r.status_code == 200
        t = find_saved_target("web01")
        assert (t.host, t.port) == ("10.0.0.21", 2222)

        assert client.put("/api/saved/nope", json={"host": "h"}).status_code == 404
        assert client.delete("/api/saved/web01").status_code == 200
        assert find_saved_target("web01") is None
        assert client.delete("/api/saved/web01").status_code == 404


def test_api_saved_requires_host():
    app = create_app(Config.load())
    with TestClient(app) as client:
        assert client.post("/api/saved", json={"name": "x"}).status_code == 400


def test_api_saved_rename_conflict_409():
    """编辑时改名撞上另一条既有条目：409，两行都原样不动
    （修复：曾静默删旧插新，UNIQUE 冲突把被编辑条目整个弄丢）。"""
    app = create_app(Config.load())
    with TestClient(app) as client:
        client.post("/api/saved", json={"name": "a", "host": "1.1.1.1"})
        client.post("/api/saved", json={"name": "b", "host": "2.2.2.2"})
        r = client.put("/api/saved/a", json={"name": "b", "host": "3.3.3.3"})
        assert r.status_code == 409
        assert "已被" in r.json()["detail"]
        assert find_saved_target("a").host == "1.1.1.1"   # 旧行未动
        assert find_saved_target("b").host == "2.2.2.2"   # 未被覆盖


def test_api_saved_default_name_from_host():
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.post("/api/saved", json={"host": "1.2.3.4", "user": "root"})
        assert r.json()["name"] == "root@1.2.3.4"
        assert find_saved_target("root@1.2.3.4").host == "1.2.3.4"


def test_api_saved_stores_password_not_in_db(monkeypatch):
    seen = {}
    monkeypatch.setattr("openterminal.web.server.store_password",
                        lambda h, u, p, pw: seen.update(h=h, u=u, p=p, pw=pw))
    app = create_app(Config.load())
    with TestClient(app) as client:
        client.post("/api/saved", json={
            "name": "pw1", "host": "1.2.3.4", "user": "root", "port": 22,
            "password": "s3cret"})
    assert seen == {"h": "1.2.3.4", "u": "root", "p": 22, "pw": "s3cret"}
    # 密码不落 SQLite：库里只有元数据列
    from openterminal.connections import db as connections_db

    conn = connections_db.connect()
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(saved)")]
    finally:
        conn.close()
    assert "password" not in cols


# --- 连接后命令集:commands 透传与回显 ---


def test_saved_commands_extract_and_roundtrip(monkeypatch):
    stored = {}
    monkeypatch.setattr("openterminal.shell.cmdset.store_password",
                        lambda key, u, p, pw: stored.__setitem__(key, pw) or True)
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.post("/api/saved", json={
            "name": "jumpbox", "host": "10.0.0.1", "user": "ops",
            "commands": "ssh root@db01\r\n> @db01=s3cret\n"})
        assert r.status_code == 200
        assert r.json()["commands"] == "ssh root@db01\n> @db01\n"   # 改写后回传(尾随换行保真)
        assert stored == {"cmdset:db01": "s3cret"}                # 明文只进 keyring
        r = client.get("/api/targets")
        entry = next(x for x in r.json()["direct"] if x["name"] == "jumpbox")
        assert entry["commands"] == "ssh root@db01\n> @db01"


def test_saved_commands_absent_keeps_old(monkeypatch):
    monkeypatch.setattr("openterminal.shell.cmdset.store_password",
                        lambda *a: True)
    app = create_app(Config.load())
    with TestClient(app) as client:
        client.post("/api/saved", json={
            "name": "jumpbox", "host": "10.0.0.1",
            "commands": "ssh root@db01\n> @db01=s3cret\n"})
        # 不带 commands 字段的编辑(旧客户端)不清空命令集
        r = client.put("/api/saved/jumpbox",
                       json={"host": "10.0.0.2"})
        assert "commands" not in r.json()
        entry = next(x for x in client.get("/api/targets").json()["direct"]
                     if x["name"] == "jumpbox")
        assert entry["commands"] == "ssh root@db01\n> @db01"


def test_saved_commands_keyring_failure_warns(monkeypatch):
    monkeypatch.setattr("openterminal.shell.cmdset.store_password",
                        lambda *a: False)
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.post("/api/saved", json={
            "name": "jumpbox", "host": "10.0.0.1",
            "commands": "> @db01=s3cret\n"})
        body = r.json()
        assert body["commands"] == "> @db01\n"       # 明文绝不落库(尾随换行保真)(尾随换行保真)
        assert "warning" in body and "db01" in body["warning"]


def test_saved_edit_invalidates_cached_target(monkeypatch):
    # 编辑已保存主机必须失效内存缓存:cfg.targets 里缓存旧配置(含命令集),
    # 不弹出的话下次连接仍用旧命令集(真机:改了命令集连了却没生效)
    monkeypatch.setattr("openterminal.shell.cmdset.store_password", lambda *a: True)
    cfg = Config.load()
    app = create_app(cfg)
    with TestClient(app) as client:
        client.post("/api/saved", json={
            "name": "jumpbox", "host": "10.0.0.1", "commands": "echo v1\n"})
        # 模拟一次连接注册:cfg.targets 里进缓存
        assert _resolve_target_name(cfg, "jumpbox") == "jumpbox"
        assert cfg.targets["jumpbox"].commands == ["echo v1"]
        # 编辑命令集 → 内存缓存必须失效,下次连接拿到新命令集
        client.put("/api/saved/jumpbox", json={
            "host": "10.0.0.1", "commands": "echo v2\n"})
        assert "jumpbox" not in cfg.targets
        assert _resolve_target_name(cfg, "jumpbox") == "jumpbox"
        assert cfg.targets["jumpbox"].commands == ["echo v2"]


# --- 共享凭据防误删 + 「留空不修改」（P0-2 回归，任务书 P2-6）---


def _patch_secret_ops(monkeypatch):
    """keyring 读写清全部打桩留痕（web/server 的模块级名字）。"""
    import openterminal.web.server as wmod

    deleted, stored = [], []
    monkeypatch.setattr(wmod, "delete_password",
                        lambda h, u, p: deleted.append((h, u, p)) or True)
    monkeypatch.setattr(wmod, "store_password",
                        lambda h, u, p, pw: stored.append((h, u, p, pw)) or True)
    return deleted, stored


def test_remove_saved_keeps_credential_shared_with_siblings(monkeypatch):
    # 三条连接共享同一凭据键（跳板形态 pe@跳板）：删其一不清凭据，
    # 删到无引用才清（旧实现删一毁三，其余条目全部重弹密码）
    deleted, _ = _patch_secret_ops(monkeypatch)
    save_saved_targets([
        TargetConfig(name="a", mode="ssh", host="10.0.0.5", user="pe"),
        TargetConfig(name="b", mode="ssh", host="10.0.0.5", user="pe"),
        TargetConfig(name="c", mode="ssh", host="10.0.0.5", user="pe"),
    ])
    app = create_app(Config.load())
    with TestClient(app) as client:
        assert client.delete("/api/saved/a").status_code == 200
        assert deleted == []          # 仍有 b/c 共享：凭据不许误删
        assert client.delete("/api/saved/b").status_code == 200
        assert deleted == []
        assert client.delete("/api/saved/c").status_code == 200
        assert deleted == [("10.0.0.5", "pe", None)]   # 无引用才清


def test_remove_saved_shared_credential_port_alias(monkeypatch):
    # 共享判定按别名语义：port None 与 22 视同同一凭据键
    deleted, _ = _patch_secret_ops(monkeypatch)
    save_saved_targets([
        TargetConfig(name="a", mode="ssh", host="10.0.0.5", user="pe", port=22),
        TargetConfig(name="b", mode="ssh", host="10.0.0.5", user="pe"),
    ])
    app = create_app(Config.load())
    with TestClient(app) as client:
        assert client.delete("/api/saved/a").status_code == 200
        assert deleted == []          # b（port=None）与 a 的 :22 键互为别名


def test_edit_saved_address_change_empty_password_keeps_credential(monkeypatch):
    # 改地址 + 表单密码留空：「留空不修改」——旧凭据原样保留
    # （旧实现删了不写，静默丢；任务书 P0-2-2 选定语义）
    deleted, stored = _patch_secret_ops(monkeypatch)
    save_saved_targets([
        TargetConfig(name="a", mode="ssh", host="10.0.0.5", user="pe"),
    ])
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.put("/api/saved/a", json={
            "name": "a", "host": "10.0.0.9", "user": "pe"})
        assert r.status_code == 200
    assert deleted == []              # 旧凭据不删
    assert stored == []               # 留空不写新


def test_edit_saved_address_change_with_password_cleans_unreferenced(monkeypatch):
    # 改地址 + 带新密码：旧键无其他引用才清，新键按新地址写
    deleted, stored = _patch_secret_ops(monkeypatch)
    save_saved_targets([
        TargetConfig(name="a", mode="ssh", host="10.0.0.5", user="pe"),
    ])
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.put("/api/saved/a", json={
            "name": "a", "host": "10.0.0.9", "user": "pe", "password": "np"})
        assert r.status_code == 200
    assert deleted == [("10.0.0.5", "pe", None)]
    assert stored == [("10.0.0.9", "pe", None, "np")]


def test_edit_saved_shared_credential_survives_address_change(monkeypatch):
    # 改地址 + 带新密码，但旧键仍被兄弟条目共享：旧键不删，只写新键
    deleted, stored = _patch_secret_ops(monkeypatch)
    save_saved_targets([
        TargetConfig(name="a", mode="ssh", host="10.0.0.5", user="pe"),
        TargetConfig(name="b", mode="ssh", host="10.0.0.5", user="pe"),
    ])
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.put("/api/saved/a", json={
            "name": "a", "host": "10.0.0.9", "user": "pe", "password": "np"})
        assert r.status_code == 200
    assert deleted == []              # b 还在用旧键
    assert stored == [("10.0.0.9", "pe", None, "np")]


def test_edit_saved_port_alias_is_not_address_change(monkeypatch):
    # port 22→None 只是端口写法变化（凭据键别名）：不算改地址，不删旧凭据
    deleted, stored = _patch_secret_ops(monkeypatch)
    save_saved_targets([
        TargetConfig(name="a", mode="ssh", host="10.0.0.5", user="pe", port=22),
    ])
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.put("/api/saved/a", json={
            "name": "a", "host": "10.0.0.5", "user": "pe"})
        assert r.status_code == 200
    assert deleted == []
    assert stored == []
