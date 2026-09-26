"""history_db：连接级命令历史长期记忆（SQLite）单元测试。"""

from openterminal.history_db import record, recent


def test_record_and_recent_roundtrip(tmp_path):
    db = tmp_path / "history.db"
    record("web01", "user", "ls -la", path=db)
    record("web01", "agent", "df -h", path=db)
    rows = recent("web01", 100, path=db)
    assert [(r["source"], r["command"]) for r in rows] == \
        [("user", "ls -la"), ("agent", "df -h")]
    assert rows[0]["ts"] <= rows[1]["ts"]


def test_recent_per_target_isolated(tmp_path):
    db = tmp_path / "history.db"
    record("web01", "user", "ls", path=db)
    record("web02", "user", "pwd", path=db)
    assert [r["command"] for r in recent("web01", 10, path=db)] == ["ls"]
    assert [r["command"] for r in recent("web02", 10, path=db)] == ["pwd"]


def test_recent_limit_returns_latest_ascending(tmp_path):
    db = tmp_path / "history.db"
    for i in range(5):
        record("t", "user", f"cmd{i}", path=db)
    rows = recent("t", 2, path=db)
    assert [r["command"] for r in rows] == ["cmd3", "cmd4"]


def test_record_skips_blank_and_truncates_long(tmp_path):
    db = tmp_path / "history.db"
    record("t", "user", "   ", path=db)
    record("t", "user", "", path=db)
    record("t", "user", "x" * 5000, path=db)
    rows = recent("t", 10, path=db)
    assert len(rows) == 1
    assert len(rows[0]["command"]) == 4096


def test_record_creates_missing_parent_dirs(tmp_path):
    db = tmp_path / "sub" / "dir" / "history.db"
    record("t", "user", "ls", path=db)
    assert [r["command"] for r in recent("t", 10, path=db)] == ["ls"]
