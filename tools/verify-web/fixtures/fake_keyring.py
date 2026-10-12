"""测试用 keyring 后端：落 JSON 文件，跑在隔离的 OPENTERMINAL_HOME 里。

真机验证文件面板的「自动连真实机」需要凭据库可用（adopt 只在凭据库有
该身份的密码时才试连）。默认的 null keyring 会让 adopt 永远回 401，
只能验到弹框路径。用法：服务端 env 指
``PYTHON_KEYRING_BACKEND=tools.verify-web.fixtures.fake_keyring``。

env: ``OT_FAKE_KEYRING=<json 文件路径>`` 指定存储位置。
"""

import json
import os
from pathlib import Path

from keyring.backend import KeyringBackend


def _path() -> Path:
    return Path(os.environ.get("OT_FAKE_KEYRING")
                or (os.environ.get("OPENTERMINAL_HOME") or ".") + "/keyring.json")


def _load() -> dict:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 不存在/损坏都当空库
        return {}


def _save(data: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


# keyring 按 entry point 找 Keyring 类；这里直接提供同名接口
class Keyring(KeyringBackend):
    """必须继承 KeyringBackend，否则 keyring.init_backend 直接 TypeError。"""

    priority = 10

    def get_password(self, service: str, username: str):
        return _load().get(f"{service}|{username}")

    def set_password(self, service: str, username: str, password: str) -> None:
        data = _load()
        data[f"{service}|{username}"] = password
        _save(data)

    def delete_password(self, service: str, username: str) -> None:
        data = _load()
        data.pop(f"{service}|{username}", None)
        _save(data)
