"""history_db：连接级命令历史长期记忆（SQLite 后端）。

每个 target 的用户命令与 AI 工具命令按序落库（append-only），重连/换设备
时由 worker 取最近 N 条注入远端 shell 历史——`history` 与 ↑ 键由 shell
原生支持，前端零改动。库位置跟随 OPENTERMINAL_HOME（用户主目录，不入
git 仓库），WAL 模式允许多进程（Web worker + CLI）并发读写。
"""

import sqlite3
import time

_SCHEMA = """
CREATE TABLE IF NOT EXISTS history(
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  target  TEXT NOT NULL,
  ts      REAL NOT NULL,
  source  TEXT NOT NULL,          -- user | agent
  command TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_target ON history(target, id);
"""

MAX_COMMAND_LEN = 4096
#: 重连/换设备时回灌远端 shell 历史的条数上限
HISTORY_RECALL_LIMIT = 1000


def db_path(path=None):
    """默认库位置（跟随 OPENTERMINAL_HOME）；显式传入 path 则原样返回。"""
    if path is not None:
        return path
    from .config import app_dir

    return app_dir() / "history.db"


def _connect(path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.DatabaseError:
        pass
    conn.executescript(_SCHEMA)
    return conn


def record(target: str, source: str, command: str, *, path=None) -> None:
    """追加一条命令；空命令丢弃，超长截断。任何异常静默（历史不能打死主流程）。"""
    command = (command or "").strip()
    if not command:
        return
    command = command[:MAX_COMMAND_LEN]
    try:
        conn = _connect(db_path(path))
        try:
            conn.execute(
                "INSERT INTO history(target, ts, source, command) "
                "VALUES (?, ?, ?, ?)",
                (target, time.time(), source, command))
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 记历史失败不影响命令执行
        pass


def recent(target: str, limit: int = 1000, *, path=None) -> list[dict]:
    """某 target 最近 limit 条命令，旧→新升序。"""
    conn = _connect(db_path(path))
    try:
        rows = conn.execute(
            "SELECT ts, source, command FROM history "
            "WHERE target = ? ORDER BY id DESC LIMIT ?",
            (target, limit)).fetchall()
    finally:
        conn.close()
    return [{"ts": r[0], "source": r[1], "command": r[2]}
            for r in reversed(rows)]
