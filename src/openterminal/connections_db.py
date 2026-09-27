"""记住的连接存储：SQLite（~/.openterminal/connections.db）。

只存元数据（主机名 / IP / 端口 / 用户名 / 命令集）；密码始终走系统
凭据库（见 secrets_store），不落库。首次访问自动从旧 connections.toml
一次性迁移，迁移后旧文件改名 connections.toml.migrated 留档。

跳板机已整体下线：旧库的 jumps 表在 connect() 时做一次收尾迁移——
逐行清系统凭据库里遗留的跳板机密码后 DROP TABLE；saved.jump 死列
尝试 DROP COLUMN（SQLite < 3.35 无此语法时留作墓碑列，SQL 不再引用）。

本模块只操作 dict 行（不 import connections.py，避免循环依赖）；
TargetConfig 的转换在 connections.py 完成。
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
  commands TEXT
);
"""


class RenameConflictError(Exception):
    """编辑连接时新名字撞上另一条既有条目（拒绝写入，数据不动）。"""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(name)


def _as_port(value) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None  # 脏值不打挂迁移/加载


def db_path() -> Path:
    """数据库位置（跟随 OPENTERMINAL_HOME，用户主目录，不在 git 仓库内）。"""
    from .config import app_dir

    return app_dir() / "connections.db"


def connect(path: Path | None = None) -> sqlite3.Connection:
    """打开（必要时创建）数据库并确保 schema + 旧库/旧 TOML 迁移已完成。"""
    path = path or db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    # 旧库升级:saved 补 commands 列(命令集文本;连接后自动执行)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(saved)")}
    if "commands" not in cols:
        conn.execute("ALTER TABLE saved ADD COLUMN commands TEXT")
    _retire_jumps(conn)
    conn.commit()
    _migrate_toml(conn, path)
    return conn


def _sweep_orphan_credentials(conn: sqlite3.Connection,
                              rows: list[tuple[str, str | None, int | None]]) -> None:
    """清理已下线跳板机的遗留凭据（尽力而为）。

    saved 表里还有同址（host/user/port）直连条目的不动——keyring 键是
    display_name 三元组，堡垒机常被同时登记为直连主机，无条件删会把
    直连记住的密码一起误删（headless 场景直接 exit 68）。
    """
    for host, user, port in rows:
        if not host:
            continue
        shared = conn.execute(
            "SELECT 1 FROM saved WHERE host=? AND user IS ? AND port IS ?",
            (host, user, port)).fetchone()
        if shared:
            continue
        try:
            from .secrets_store import delete_password

            delete_password(host, user, port)
        except Exception:  # noqa: BLE001 - 凭据库不可用不阻断下线迁移
            pass


def _retire_jumps(conn: sqlite3.Connection) -> None:
    """跳板机下线收尾（幂等）：清遗留凭据 → DROP jumps 表 → 删 saved.jump 列。

    凭据清理尽力而为（凭据库不可用时跳过该行的删除）；表/列删除失败
    （SQLite 过旧）时留作墓碑，SQL 层已不引用 jump，不影响任何读写。
    """
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    if "jumps" in tables:
        rows = [(r["host"], r["user"], r["port"]) for r in conn.execute(
            "SELECT name, host, port, user FROM jumps ORDER BY id")]
        # IF EXISTS：两个进程（ot web + ot CLI）同时首跑迁移时，
        # 后到的 DROP 不再抛 no such table 炸掉调用方
        conn.execute("DROP TABLE IF EXISTS jumps")
        _sweep_orphan_credentials(conn, rows)
    try:
        conn.execute("ALTER TABLE saved DROP COLUMN jump")
    except sqlite3.OperationalError:
        pass    # SQLite < 3.35：死列留档，SQL 不再引用


def _migrate_toml(conn: sqlite3.Connection, db_file: Path) -> None:
    """旧 connections.toml 一次性迁移：仅当库为空且旧文件存在时导入。

    旧文件里的 [[jumps]] 与 saved.jump 一并忽略（跳板机已下线），但
    jumps 对应的遗留 keyring 凭据顺手清掉（同址直连条目仍在的不动）。"""
    toml_file = db_file.with_name("connections.toml")
    if not toml_file.exists():
        return
    import tomllib

    try:
        data = tomllib.loads(toml_file.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 旧文件损坏只跳过迁移，不打挂启动
        return
    jump_rows = [(j.get("host") or "", j.get("user"), _as_port(j.get("port")))
                 for j in data.get("jumps", [])]
    if conn.execute("SELECT COUNT(*) FROM saved").fetchone()[0]:
        # 库里已有数据：不重复导入，也不动旧文件；仅做凭据卫生
        _sweep_orphan_credentials(conn, jump_rows)
        return
    for t in data.get("saved", []):
        host = t.get("host") or t.get("name", "")
        if not host:
            continue
        upsert_saved(conn, {
            "name": t.get("name") or host, "host": host,
            "port": _as_port(t.get("port")),
            "user": t.get("user"),
        })
    conn.commit()
    _sweep_orphan_credentials(conn, jump_rows)
    try:
        toml_file.replace(db_file.with_name("connections.toml.migrated"))
    except OSError:
        pass  # 改名失败（占用等）不影响数据：库非空后不会重复迁移


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


# --- saved 表 ---

def fetch_saved(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT name, host, port, user, commands FROM saved ORDER BY id"
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def replace_saved(conn: sqlite3.Connection, rows: list[dict]) -> None:
    """整表重写（保持既有 save_saved_targets 语义与插入顺序）。"""
    conn.execute("DELETE FROM saved")
    for r in rows:
        conn.execute(
            "INSERT INTO saved(name, host, port, user, commands) "
            "VALUES(?,?,?,?,?)",
            (r.get("name") or r.get("host", ""), r.get("host", ""),
             r.get("port"), r.get("user"), r.get("commands")))
    conn.commit()


def upsert_saved(conn: sqlite3.Connection, row: dict) -> None:
    """按 name 插入或更新（保留原 id 以维持列表顺序）。

    commands 传 None 保留旧值（不带该字段的旧调用方/旧客户端兼容），
    传空串显式清空——COALESCE 只兜 None，不兜空串。
    """
    conn.execute(
        "INSERT INTO saved(name, host, port, user, commands) "
        "VALUES(?,?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port, "
        "user=excluded.user, "
        "commands=COALESCE(excluded.commands, saved.commands)",
        (row.get("name") or row.get("host", ""), row.get("host", ""),
         row.get("port"), row.get("user"), row.get("commands")))
    conn.commit()


def delete_saved(conn: sqlite3.Connection, name: str) -> dict | None:
    """删除并返回被删行（供调用方清理凭据库）；不存在返回 None。"""
    row = conn.execute(
        "SELECT name, host, port, user, commands FROM saved WHERE name=?",
        (name,)).fetchone()
    if row is None:
        return None
    conn.execute("DELETE FROM saved WHERE name=?", (name,))
    conn.commit()
    return _row_to_dict(row)


def rename_saved(conn: sqlite3.Connection, old: str, row: dict) -> dict | None:
    """编辑连接：删旧行、插新行（name 可能改），单事务；返回被删的旧行。

    - 旧行不存在 → 返回 None，**不写入任何行**（不再凭空建条目）；
    - 新名字撞上另一条既有条目 → 抛 RenameConflictError，库不动
      （不再静默合并覆盖别人的条目）；
    - commands 传 None 时继承旧行值——这里是先删后插，upsert 的
      COALESCE 兜不住（没有冲突路径可走），必须显式接管；
    - DELETE+INSERT 包在同一事务里，中途失败回滚，不留半截状态。
    """
    r = conn.execute(
        "SELECT name, host, port, user, commands FROM saved WHERE name=?",
        (old,)).fetchone()
    if r is None:
        return None
    deleted = _row_to_dict(r)
    new_name = row.get("name") or row.get("host", "")
    if new_name != old and conn.execute(
            "SELECT 1 FROM saved WHERE name=?", (new_name,)).fetchone():
        raise RenameConflictError(new_name)
    if row.get("commands") is None:
        row = {**row, "commands": deleted.get("commands")}
    try:
        conn.execute("DELETE FROM saved WHERE name=?", (old,))
        conn.execute(
            "INSERT INTO saved(name, host, port, user, commands) "
            "VALUES(?,?,?,?,?)",
            (new_name, row.get("host", ""), row.get("port"),
             row.get("user"), row.get("commands")))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return deleted
