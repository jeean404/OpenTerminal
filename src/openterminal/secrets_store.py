"""记住的连接密码存取：系统凭据库，经 keyring 库统一访问。

各平台落到原生存储——Windows 凭据管理器、macOS Keychain、Linux
Secret Service（GNOME Keyring/KWallet）。凭据库不可用（如无桌面的
Linux）时静默降级：读返回 None、写为空操作，CLI 回退到连接时现场
询问密码，功能不受影响。
"""

from __future__ import annotations

from .connections import display_name

_SERVICE = "openterminal"


def load_password(host: str, user: str | None, port: int | None) -> str | None:
    """取记住的密码；无条目或凭据库不可用返回 None。"""
    try:
        import keyring

        return keyring.get_password(_SERVICE, display_name(host, user, port))
    except Exception:  # noqa: BLE001 - 凭据库缺席/被锁只降级，不打挂连接
        return None


def store_password(host: str, user: str | None, port: int | None,
                   password: str) -> bool:
    """保存密码；凭据库不可用返回 False（调用方降级，不视为错误）。"""
    try:
        import keyring

        keyring.set_password(_SERVICE, display_name(host, user, port), password)
        return True
    except Exception:  # noqa: BLE001
        return False


def delete_password(host: str, user: str | None, port: int | None) -> bool:
    """删除记住的密码（删除/编辑连接时清理旧凭据）；不存在或不可用返回 False。"""
    try:
        import keyring

        keyring.delete_password(_SERVICE, display_name(host, user, port))
        return True
    except Exception:  # noqa: BLE001
        return False
