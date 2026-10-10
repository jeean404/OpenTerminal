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


def load_password_alias(host: str, user: str | None, port: int | None,
                        load=None) -> str | None:
    """读取记住的密码：无端口与 ssh 默认端口 22 视同同一键（别名互查）。

    凭据键 display_name 在端口非空时附 :port——同一密码可能落在
    ``user@host`` 或 ``user@host:22`` 任一键下（档案流按 target.port=22 存、
    嵌套 ssh 无 -p 解析出 port=None 来查），单键直查永远 miss（真机：档案
    登录成功过、嵌套 ssh 仍弹窗重讨）。先查本键，miss 且 port∈(None, 22)
    再查另一键；非默认端口（2222 等）不互查。首跳（_connect）与嵌套
    （_load_nested_password）共用此实现，消灭两处漂移。只读——写入仍按
    调用方给的原样键（不隐式写双键，删除路径才不会删一漏一）。

    load：读函数注入点（默认本模块 load_password）——core 侧把模块全局
    load_password 传进来，测试 monkeypatch（wmod 桥）语义不变。
    """
    get = load or load_password
    pw = get(host, user, port)
    if pw is not None or port not in (None, 22):
        return pw
    return get(host, user, 22 if port is None else None)


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
