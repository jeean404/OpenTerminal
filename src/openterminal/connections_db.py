"""旧路径壳（阶段二 Task 11）：实现已迁至 connections/db.py。"""

from .connections.db import (  # noqa: F401
    RenameConflictError, connect, db_path, delete_saved, fetch_saved,
    rename_saved, replace_saved, upsert_saved,
)
