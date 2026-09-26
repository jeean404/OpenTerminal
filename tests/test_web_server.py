from fastapi.testclient import TestClient

from openterminal.config import Config, TargetConfig
from openterminal.connections import (
    JumpHost, find_saved_target, load_jump_hosts, load_saved_targets,
    save_jump_hosts, save_saved_targets,
)
from openterminal.web.server import _resolve_target_name, create_app


def test_api_targets_payload():
    save_saved_targets([
        TargetConfig(name="web01", mode="ssh", host="10.0.0.20", user="root",
                     jump="bastion01"),
        TargetConfig(name="prod", mode="ssh", host="p.example.com"),
    ])
    save_jump_hosts([JumpHost(name="bastion01", host="10.0.0.5", user="admin")])
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.get("/api/targets")
        assert r.status_code == 200
        data = r.json()
        assert data["local"] is True
        assert [t["name"] for t in data["direct"]] == ["prod"]
        assert data["jumps"][0]["jump"]["name"] == "bastion01"
        assert [t["name"] for t in data["jumps"][0]["targets"]] == ["web01"]


def test_api_saved_and_jumps_endpoints(tmp_path):
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.post("/api/saved", json={"target": "root@9.9.9.9:2222"})
        assert r.status_code == 200
        r = client.post("/api/jumps", json={"target": "admin@10.0.0.5"})
        assert r.status_code == 200
    saved = load_saved_targets()
    assert any(t.host == "9.9.9.9" for t in saved)
    jumps = load_jump_hosts()
    assert any(j.host == "10.0.0.5" for j in jumps)


def test_token_required_on_non_local_binding():
    app = create_app(Config.load(), token="secret")
    with TestClient(app) as client:
        assert client.get("/api/targets").status_code == 401
        r = client.get("/api/targets", headers={"x-ot-token": "secret"})
        assert r.status_code == 200


def test_resolve_target_name_from_saved():
    # 回归：侧栏点记住的连接/经跳板机目标时，必须保留 host/user/jump，
    # 而不是被当 user@host 重新解析丢掉连接信息
    save_saved_targets([TargetConfig(
        name="web01", mode="ssh", host="10.0.0.20", user="root",
        jump="bastion01")])
    cfg = Config.load()
    name = _resolve_target_name(cfg, "web01")
    assert name == "web01"
    t = cfg.targets["web01"]
    assert (t.host, t.user, t.jump) == ("10.0.0.20", "root", "bastion01")


# --- 表单化 CRUD（Web 添加/编辑/删除 主机与跳板机）---


def test_api_saved_crud_structured():
    app = create_app(Config.load())
    with TestClient(app) as client:
        r = client.post("/api/saved", json={
            "name": "web01", "host": "10.0.0.20", "port": 22,
            "user": "root", "jump": ""})
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
        assert client.post("/api/jumps", json={"name": "x"}).status_code == 400


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
    from openterminal import connections_db

    conn = connections_db.connect()
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(saved)")]
    finally:
        conn.close()
    assert "password" not in cols


def test_api_jumps_crud_and_rename_updates_refs():
    app = create_app(Config.load())
    with TestClient(app) as client:
        assert client.post("/api/jumps", json={
            "name": "b1", "host": "10.0.0.5", "user": "admin"}).status_code == 200
        client.post("/api/saved", json={
            "name": "web01", "host": "10.0.0.20", "user": "root", "jump": "b1"})

        r = client.put("/api/jumps/b1", json={"name": "b2", "host": "10.0.0.6"})
        assert r.status_code == 200
        assert find_saved_target("web01").jump == "b2"      # 引用跟随改名
        assert [j.name for j in load_jump_hosts()] == ["b2"]

        assert client.delete("/api/jumps/b2").status_code == 200
        assert find_saved_target("web01").jump is None      # 回落直连
        assert client.delete("/api/jumps/b2").status_code == 404


def test_api_targets_payload_includes_jump_ref():
    save_jump_hosts([JumpHost(name="b1", host="10.0.0.5")])
    save_saved_targets([TargetConfig(name="web01", mode="ssh",
                                     host="10.0.0.20", jump="b1")])
    app = create_app(Config.load())
    with TestClient(app) as client:
        data = client.get("/api/targets").json()
        assert data["jumps"][0]["targets"][0]["jump"] == "b1"


# --- 连接后命令集:commands 透传与回显 ---


def test_saved_commands_extract_and_roundtrip(monkeypatch):
    stored = {}
    monkeypatch.setattr("openterminal.cmdset.store_password",
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
    monkeypatch.setattr("openterminal.cmdset.store_password",
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
    monkeypatch.setattr("openterminal.cmdset.store_password",
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
    monkeypatch.setattr("openterminal.cmdset.store_password", lambda *a: True)
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
