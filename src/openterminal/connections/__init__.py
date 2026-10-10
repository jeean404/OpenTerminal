"""connections 域（阶段二 Task 11 重组）。

models.py——SSH config 解析、目标列表与记住的连接（会话工厂）；
db.py——记住的连接 SQLite 库；secrets.py——系统凭据库（keyring）封装。
本 __init__ 再导出旧 ``connections`` 模块全部公开名，旧 import 路径
（``from openterminal.connections import ...``）不因拆包而变。
"""

from ..config import TargetConfig  # noqa: F401 —— 旧模块命名空间原有
from .db import RenameConflictError  # noqa: F401 —— 旧模块统一再导出
from .models import (  # noqa: F401
    PW_STORE_FAIL_HINT, SshTarget, TargetList, build_target_list,
    cred_alias_eq, credential_referenced, delete_saved_target,
    display_name, find_saved_target, list_ssh_hosts, load_saved_targets,
    open_session, parse_ssh_config, parse_user_at_host, rename_saved_target,
    save_saved_targets, saved_targets_path, upsert_saved_target,
)
from .secrets import (  # noqa: F401
    delete_password, load_password, load_password_alias, store_password,
)
