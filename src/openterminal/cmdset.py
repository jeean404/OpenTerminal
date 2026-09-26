"""连接后命令集:内联密码抽取与 @引用解析(纯函数,可单测)。

密码永不明文落库:表单里写 `> @名称=密码`,保存时抽取入系统凭据库
(keyring,键 `cmdset:名称`),落库文本只留 `> @名称` 引用。凭据库
不可用时静默降级——行照改写、密码丢弃,由 API 层上报 warning。
"""
from __future__ import annotations

import re

from .connections import find_saved_target
from .secrets_store import load_password, store_password

_CMDSET_KEY_PREFIX = "cmdset:"
# `> @名称=密码`:名称限字母数字_.-,避免把 `> @a b=c` 之类误当引用
_INLINE_SECRET_RE = re.compile(r"^>\s*@([A-Za-z0-9_.\-]+)\s*=(.*)$")


def extract_inline_secrets(text: str) -> tuple[str, list[str]]:
    """抽取内联密码入 keyring 并改写为引用,返回 (改写文本, 写失败的引用名)。

    CRLF/CR 归一为 LF(Windows 表单粘贴);密码为空串视为纯引用不写库。
    """
    out: list[str] = []
    failed: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        m = _INLINE_SECRET_RE.match(line.strip())
        if m is None:
            out.append(line)
            continue
        name, secret = m.group(1), m.group(2).strip()
        if secret and not store_password(f"{_CMDSET_KEY_PREFIX}{name}",
                                         None, None, secret):
            failed.append(name)     # 凭据库缺席:丢弃密码,行照改写
        out.append(f"> @{name}")
    return "\n".join(out), failed


def resolve_answer(name: str) -> str | None:
    """@引用 → 应答内容:先命令集命名空间,再已保存主机的记住密码。"""
    pw = load_password(f"{_CMDSET_KEY_PREFIX}{name}", None, None)
    if pw:
        return pw
    t = find_saved_target(name)
    if t is not None:
        pw = load_password(t.host or t.name, t.user, t.port)
        if pw:
            return pw
    return None
