"""记住的连接 / 跳板机存储：SQLite（~/.openterminal/connections.db）。

只存元数据（主机名 / IP / 端口 / 用户名 / 跳板关系）；密码始终走系统
凭据库（见 secrets_store），不落库。首次访问自动从旧 connections.toml
一次性迁移，迁移后旧文件改名 connections.toml.migrated 留档。

本模块只操作 dict 行（不 import connections.py，避免循环依赖）；
TargetConfig / JumpHost 的转换在 connections.py 完成。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS saved(
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER,
  user TEXT,
  jump TEXT,
  commands TEXT
);
CREATE TABLE IF NOT EXISTS jumps(
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER,
  user TEXT
);
"""


def db_path() -> Path:
    """数据库位置（跟随 OPENTERMINAL_HOME，用户主目录，不在 git 仓库内）。"""
    from .config import app_dir

    return app_dir() / "connections.db"


def connect(path: Path | None = None) -> sqlite3.Connection:
    """打开（必要时创建）数据库并确保 schema + 旧 TOML 迁移已完成。"""
    path = path or db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    # 旧库升级:saved 补 commands 列(命令集文本;连接后自动执行)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(saved)")}
    if "commands" not in cols:
        conn.execute("ALTER TABLE saved ADD COLUMN commands TEXT")
    conn.commit()
    _migrate_toml(conn, path)
    return conn


def _migrate_toml(conn: sqlite3.Connection, db_file: Path) -> None:
    """旧 connections.toml 一次性迁移：仅当库为空且旧文件存在时导入。"""
    toml_file = db_file.with_name("connections.toml")
    if not toml_file.exists():
        return
    has_rows = (conn.execute("SELECT COUNT(*) FROM saved").fetchone()[0]
                or conn.execute("SELECT COUNT(*) FROM jumps").fetchone()[0])
    if has_rows:
        return  # 库里已有数据：不重复导入，也不动旧文件
    import tomllib

    try:
        data = tomllib.loads(toml_file.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 旧文件损坏只跳过迁移，不打挂启动
        return
    for t in data.get("saved", []):
        host = t.get("host") or t.get("name", "")
        if not host:
            continue
        upsert_saved(conn, {
            "name": t.get("name") or host, "host": host,
            "port": int(t["port"]) if t.get("port") else None,
            "user": t.get("user"), "jump": t.get("jump"),
        })
    for j in data.get("jumps", []):
        host = j.get("host") or j.get("name", "")
        if not host:
            continue
        upsert_jump(conn, {
            "name": j.get("name") or host, "host": host,
            "port": int(j["port"]) if j.get("port") else None,
            "user": j.get("user"),
        })
    conn.commit()
    try:
        toml_file.replace(db_file.with_name("connections.toml.migrated"))
    except OSError:
        pass  # 改名失败（占用等）不影响数据：库非空后不会重复迁移


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


# --- saved 表 ---

def fetch_saved(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT name, host, port, user, jump, commands FROM saved ORDER BY id"
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def replace_saved(conn: sqlite3.Connection, rows: list[dict]) -> None:
    """整表重写（保持既有 save_saved_targets 语义与插入顺序）。"""
    conn.execute("DELETE FROM saved")
    for r in rows:
        conn.execute(
            "INSERT INTO saved(name, host, port, user, jump, commands) "
            "VALUES(?,?,?,?,?,?)",
            (r.get("name") or r.get("host", ""), r.get("host", ""),
             r.get("port"), r.get("user"), r.get("jump"),
             r.get("commands")))
    conn.commit()


def upsert_saved(conn: sqlite3.Connection, row: dict) -> None:
    """按 name 插入或更新（保留原 id 以维持列表顺序）。

    commands 传 None 保留旧值（不带该字段的旧调用方/旧客户端兼容），
    传空串显式清空——COALESCE 只兜 None，不兜空串。
    """
    conn.execute(
        "INSERT INTO saved(name, host, port, user, jump, commands) "
        "VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port, "
        "user=excluded.user, jump=excluded.jump, "
        "commands=COALESCE(excluded.commands, saved.commands)",
        (row.get("name") or row.get("host", ""), row.get("host", ""),
         row.get("port"), row.get("user"), row.get("jump"),
         row.get("commands")))
    conn.commit()


def delete_saved(conn: sqlite3.Connection, name: str) -> dict | None:
    """删除并返回被删行（供调用方清理凭据库）；不存在返回 None。"""
    row = conn.execute(
        "SELECT name, host, port, user, jump, commands FROM saved WHERE name=?",
        (name,)).fetchone()
    if row is None:
        return None
    conn.execute("DELETE FROM saved WHERE name=?", (name,))
    conn.commit()
    return _row_to_dict(row)


def rename_saved(conn: sqlite3.Connection, old: str, row: dict) -> dict | None:
    """编辑连接：删旧行、写新行（name 可能改）；返回被删的旧行。

    commands 传 None 时继承旧行值——这里是先删后插，upsert 的
    COALESCE 兜不住（没有冲突路径可走），必须显式接管。
    """
    deleted = delete_saved(conn, old)
    if deleted is not None and row.get("commands") is None:
        row = {**row, "commands": deleted.get("commands")}
    upsert_saved(conn, row)
    return deleted


# --- jumps 表 ---

def fetch_jumps(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT name, host, port, user FROM jumps ORDER BY id").fetchall()
    return [_row_to_dict(r) for r in rows]


def replace_jumps(conn: sqlite3.Connection, rows: list[dict]) -> None:
    conn.execute("DELETE FROM jumps")
    for r in rows:
        conn.execute(
            "INSERT INTO jumps(name, host, port, user) VALUES(?,?,?,?)",
            (r.get("name") or r.get("host", ""), r.get("host", ""),
             r.get("port"), r.get("user")))
    conn.commit()


def upsert_jump(conn: sqlite3.Connection, row: dict) -> None:
    conn.execute(
        "INSERT INTO jumps(name, host, port, user) VALUES(?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port, "
        "user=excluded.user",
        (row.get("name") or row.get("host", ""), row.get("host", ""),
         row.get("port"), row.get("user")))
    conn.commit()


def delete_jump(conn: sqlite3.Connection, name: str) -> dict | None:
    """删除跳板机；其下主机的 jump 引用置空（回落为直连）。"""
    row = conn.execute(
        "SELECT name, host, port, user FROM jumps WHERE name=?",
        (name,)).fetchone()
    if row is None:
        return None
    conn.execute("UPDATE saved SET jump=NULL WHERE jump=?", (name,))
    conn.execute("DELETE FROM jumps WHERE name=?", (name,))
    conn.commit()
    return _row_to_dict(row)
