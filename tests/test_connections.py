"""SSH config 解析、目标列举与记住的连接（SQLite 往返、迁移、CRUD、展示名）。"""

from pathlib import Path

import pytest

from openterminal.config import TargetConfig
from openterminal.connections import (
    delete_jump_host, delete_saved_target, display_name, list_ssh_hosts,
    load_saved_targets, parse_ssh_config, parse_user_at_host,
    rename_saved_target, save_saved_targets, upsert_saved_target,
)

CONFIG = """\
Host prod-web
    HostName 10.0.0.1
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
    ProxyJump bastion

Host *
    ServerAliveInterval 30

Host dev-box user@dev-box
    HostName 10.0.0.2
"""


def test_parse_named_host(tmp_path: Path):
    f = tmp_path / "config"
    f.write_text(CONFIG, encoding="utf-8")
    hosts = parse_ssh_config(f)
    p = hosts["prod-web"]
    assert (p.hostname, p.user, p.port, p.jump) == ("10.0.0.1", "deploy", 2222, "bastion")
    assert "id_ed25519" in p.identity


def test_wildcards_and_multi_host(tmp_path: Path):
    f = tmp_path / "config"
    f.write_text(CONFIG, encoding="utf-8")
    names = list_ssh_hosts(f)
    assert "prod-web" in names
    assert "dev-box" in names
    assert "*" not in names  # 通配块不进选择器


def test_parse_user_at_host():
    assert parse_user_at_host("root@1.2.3.4") == ("1.2.3.4", "root", None)
    assert parse_user_at_host("1.2.3.4") == ("1.2.3.4", None, None)
    assert parse_user_at_host("deploy@h:2222") == ("h", "deploy", 2222)


# --- 记住的连接（~/.openterminal/connections.toml，不入 git）---


def test_display_name():
    assert display_name("h", None, None) == "h"
    assert display_name("h", "root", None) == "root@h"
    assert display_name("h", "root", 2222) == "root@h:2222"
    assert display_name("h", None, 2222) == "h:2222"


def test_saved_targets_roundtrip(tmp_path):
    path = tmp_path / "connections.db"
    save_saved_targets([
        TargetConfig(name="prod", mode="ssh", host="p.example.com",
                     user="deploy", port=None),
        TargetConfig(name="root@box:2222", mode="ssh", host="box",
                     user="root", port=2222),
    ], path)
    loaded = load_saved_targets(path)
    assert [(t.host, t.user, t.port) for t in loaded] == [
        ("p.example.com", "deploy", None), ("box", "root", 2222)]
    assert [t.name for t in loaded] == ["prod", "root@box:2222"]
    assert all(t.mode == "ssh" for t in loaded)


def test_load_missing_file_returns_empty(tmp_path):
    assert load_saved_targets(tmp_path / "nope.db") == []


def test_default_path_is_outside_repo(tmp_path, monkeypatch):
    # conftest 已把 OPENTERMINAL_HOME 指到临时目录：存储位置跟随它，
    # 即用户主目录 ~/.openterminal，而非 git 仓库内
    from openterminal.connections import saved_targets_path

    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    assert saved_targets_path() == tmp_path / "connections.db"


from openterminal.connections import (
    JumpHost, build_target_list, jump_for, load_jump_hosts, save_jump_hosts,
)


def test_jumps_roundtrip(tmp_path):
    path = tmp_path / "connections.db"
    save_jump_hosts([
        JumpHost(name="bastion01", host="10.0.0.5", user="admin", port=22),
        JumpHost(name="j2", host="10.0.0.6"),
    ], path)
    loaded = load_jump_hosts(path)
    assert [(j.name, j.host, j.user, j.port) for j in loaded] == [
        ("bastion01", "10.0.0.5", "admin", 22), ("j2", "10.0.0.6", None, None)]


def test_saved_with_jump_roundtrip(tmp_path):
    path = tmp_path / "connections.db"
    save_saved_targets([
        TargetConfig(name="web01", mode="ssh", host="10.0.0.20",
                     user="root", jump="bastion01"),
    ], path)
    loaded = load_saved_targets(path)
    assert loaded[0].jump == "bastion01"


def test_saved_and_jumps_tables_preserved(tmp_path):
    path = tmp_path / "connections.db"
    save_saved_targets([
        TargetConfig(name="web01", mode="ssh", host="10.0.0.20", user="root",
                     jump="bastion01"),
    ], path)
    save_jump_hosts([JumpHost(name="bastion01", host="10.0.0.5", user="admin")], path)
    assert len(load_saved_targets(path)) == 1
    assert len(load_jump_hosts(path)) == 1
    assert load_saved_targets(path)[0].jump == "bastion01"


def test_jump_for():
    # conftest 已把 OPENTERMINAL_HOME 指到临时目录：默认路径读写即可
    save_jump_hosts([JumpHost(name="bastion01", host="10.0.0.5", user="admin")])
    assert jump_for(TargetConfig(name="x", mode="ssh", host="h", jump="bastion01")).name == "bastion01"
    assert jump_for(TargetConfig(name="x", mode="ssh", host="h")) is None


def test_build_target_list_groups():
    saved = [
        TargetConfig(name="web01", mode="ssh", host="10.0.0.20", user="root", jump="bastion01"),
        TargetConfig(name="db01", mode="ssh", host="10.0.0.30", user="root", jump="bastion01"),
        TargetConfig(name="prod", mode="ssh", host="p.example.com"),
    ]
    jumps = [JumpHost(name="bastion01", host="10.0.0.5", user="admin")]
    tl = build_target_list(saved, jumps)
    assert [t.name for t in tl.direct] == ["prod"]
    assert len(tl.jumps) == 1 and len(tl.jumps[0].targets) == 2
    assert tl.local is True


# --- SQLite 迁移与单条 CRUD（Web 表单：添加 / 编辑 / 删除）---


def test_migrates_legacy_toml_once(tmp_path):
    db = tmp_path / "connections.db"
    toml = tmp_path / "connections.toml"
    toml.write_text(
        '[[saved]]\nname = "web01"\nhost = "10.0.0.20"\nuser = "root"\n'
        'jump = "bastion01"\n\n'
        '[[jumps]]\nname = "bastion01"\nhost = "10.0.0.5"\nuser = "admin"\nport = 22\n',
        encoding="utf-8")
    saved = load_saved_targets(db)
    assert [(t.name, t.host, t.user, t.jump) for t in saved] == [
        ("web01", "10.0.0.20", "root", "bastion01")]
    jumps = load_jump_hosts(db)
    assert [(j.name, j.host, j.port) for j in jumps] == [("bastion01", "10.0.0.5", 22)]
    # 旧文件改名留档，且不会被重复导入
    assert not toml.exists()
    assert (tmp_path / "connections.toml.migrated").exists()
    save_saved_targets([], db)  # 清空后再次 load 也不应把旧文件迁回来
    assert load_saved_targets(db) == []


def test_upsert_rename_delete_saved(tmp_path):
    db = tmp_path / "connections.db"
    upsert_saved_target(name="web01", host="10.0.0.20", user="root",
                        port=22, jump="b1", path=db)
    upsert_saved_target(name="web01", host="10.0.0.21", user="root",
                        port=22, jump="b1", path=db)  # 同名 upsert 不重复
    assert [(t.name, t.host) for t in load_saved_targets(db)] == [("web01", "10.0.0.21")]
    removed = rename_saved_target("web01", name="web02", host="10.0.0.22",
                                  user="root", port=2222, path=db)
    assert removed.name == "web01"
    t = load_saved_targets(db)[0]
    assert (t.name, t.host, t.port) == ("web02", "10.0.0.22", 2222)
    assert delete_saved_target("web02", db).host == "10.0.0.22"
    assert delete_saved_target("web02", db) is None
    assert load_saved_targets(db) == []


def test_delete_jump_nulls_target_refs(tmp_path):
    db = tmp_path / "connections.db"
    save_jump_hosts([JumpHost(name="b1", host="10.0.0.5")], db)
    upsert_saved_target(name="web01", host="10.0.0.20", jump="b1", path=db)
    removed = delete_jump_host("b1", db)
    assert removed.host == "10.0.0.5"
    assert load_saved_targets(db)[0].jump is None  # 回落直连
    assert delete_jump_host("b1", db) is None


# --- open_session 密码补存：连接已记住但凭据缺失（如经 Web 添加）---
# 回归：connections.toml 里有连接、凭据库里没密码时，首次用密码连上要补存，
# 否则每次重连都要重新输密码（_maybe_remember 对已记住连接直接 return 拦掉了回填）。


def _open_with_password(monkeypatch, *, last_password="s3cret"):
    import openterminal.secrets_store as secrets_mod

    async def fake_start(self):
        self.last_password = last_password

    monkeypatch.setattr("openterminal.ssh_pty.SshPtySession.start", fake_start)
    return secrets_mod


async def test_open_session_backfills_missing_password_for_saved_target(monkeypatch):
    import openterminal.connections as conn_mod

    save_saved_targets([
        TargetConfig(name="root@a", mode="ssh", host="a", user="root")])
    secrets_mod = _open_with_password(monkeypatch)
    seen = {}
    monkeypatch.setattr(secrets_mod, "load_password", lambda h, u, p: None)
    monkeypatch.setattr(secrets_mod, "store_password",
                        lambda h, u, p, pw: seen.update(host=h, user=u, port=p, pw=pw) or True)

    await conn_mod.open_session(
        TargetConfig(name="root@a", mode="ssh", host="a", user="root"))
    assert seen == {"host": "a", "user": "root", "port": None, "pw": "s3cret"}


async def test_open_session_no_backfill_for_unsaved_target(monkeypatch):
    # 连接未记住：不替用户做主存密码（留给 _maybe_remember 的 y/n 询问）
    import openterminal.connections as conn_mod

    secrets_mod = _open_with_password(monkeypatch)
    monkeypatch.setattr(secrets_mod, "load_password", lambda h, u, p: None)
    monkeypatch.setattr(secrets_mod, "store_password",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("未记住的连接不应存密码")))

    await conn_mod.open_session(
        TargetConfig(name="root@a", mode="ssh", host="a", user="root"))  # 不抛即通过


async def test_open_session_no_backfill_when_password_already_stored(monkeypatch):
    import openterminal.connections as conn_mod

    save_saved_targets([
        TargetConfig(name="root@a", mode="ssh", host="a", user="root")])
    secrets_mod = _open_with_password(monkeypatch)
    monkeypatch.setattr(secrets_mod, "load_password", lambda h, u, p: "stored")
    monkeypatch.setattr(secrets_mod, "store_password",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("已有凭据不应重复存")))

    await conn_mod.open_session(
        TargetConfig(name="root@a", mode="ssh", host="a", user="root"))  # 不抛即通过


async def test_open_session_no_backfill_for_key_auth(monkeypatch):
    # 密钥认证：没用密码（last_password None），不补存
    import openterminal.connections as conn_mod

    save_saved_targets([
        TargetConfig(name="root@a", mode="ssh", host="a", user="root")])
    secrets_mod = _open_with_password(monkeypatch, last_password=None)
    monkeypatch.setattr(secrets_mod, "load_password", lambda h, u, p: None)
    monkeypatch.setattr(secrets_mod, "store_password",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("密钥认证不应存密码")))

    await conn_mod.open_session(
        TargetConfig(name="root@a", mode="ssh", host="a", user="root"))  # 不抛即通过


# --- 连接后命令集:commands 列迁移与存取 ---


def _old_schema_db(path):
    """模拟升级前的库:有 saved 表但没有 commands 列。"""
    import sqlite3
    conn = sqlite3.connect(str(path))
    conn.execute("""CREATE TABLE saved(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
      port INTEGER, user TEXT, jump TEXT)""")
    conn.execute("INSERT INTO saved(name, host, user) VALUES('web01','10.0.0.20','root')")
    conn.commit()
    conn.close()


def test_migrate_adds_commands_column(tmp_path):
    db = tmp_path / "c.db"
    _old_schema_db(db)
    ts = load_saved_targets(db)
    assert [t.name for t in ts] == ["web01"]
    assert ts[0].commands == []          # 新列默认空,旧数据原样


def test_commands_roundtrip_and_keep_on_none(tmp_path):
    db = tmp_path / "c.db"
    upsert_saved_target(name="jumpbox", host="10.0.0.1", user="ops",
                        commands="ssh root@db01\n> @db01\n# 注释\n", path=db)
    ts = {t.name: t for t in load_saved_targets(db)}
    assert ts["jumpbox"].commands == ["ssh root@db01", "> @db01", "# 注释"]
    # 不带 commands(传 None)的再次保存不清空——旧客户端兼容
    upsert_saved_target(name="jumpbox", host="10.0.0.1", user="ops", path=db)
    ts = {t.name: t for t in load_saved_targets(db)}
    assert ts["jumpbox"].commands == ["ssh root@db01", "> @db01", "# 注释"]
    # 空串 = 显式清空
    upsert_saved_target(name="jumpbox", host="10.0.0.1", user="ops",
                        commands="", path=db)
    assert load_saved_targets(db)[0].commands == []
