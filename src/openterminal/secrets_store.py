"""旧路径壳（阶段二 Task 11）：实现已迁至 connections/secrets.py。"""

from .connections.secrets import (  # noqa: F401
    delete_password, load_password, load_password_alias, store_password,
)
