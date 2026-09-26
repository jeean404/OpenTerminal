"""WebSocket 消息协议：dataclass + 序列化（纯函数，可单测）。

单管线契约（设计文档 §5）：
- 客户端 → 服务端：JSON 文本（控制）或二进制帧（键盘字节直发）。
- 服务端 → 客户端：JSON 文本（控制/卡片事件）或二进制帧（PTY 字节直写主
  xterm，唯一显示管线）。
"""

from __future__ import annotations

import json

from ..core import ClientMsg, ServerMsg  # noqa: F401 —— 再导出（旧 import 路径继续可用）


def parse_client(frame: bytes | str) -> ClientMsg:
    """客户端帧 → ClientMsg。二进制帧视为 raw 键盘字节（直发 PTY）。"""
    if isinstance(frame, (bytes, bytearray)):
        return ClientMsg(type="raw", data=bytes(frame))
    obj = json.loads(frame)
    return ClientMsg(
        type=obj.get("type", ""),
        text=obj.get("text", ""),
        decision=obj.get("decision"),
        auth_kind=obj.get("auth_kind", ""),
        remember=bool(obj.get("remember", False)),
        model=obj.get("model", ""),
        cols=obj.get("cols", 0),
        rows=obj.get("rows", 0),
        pad=obj.get("pad", 0),
        mirror=obj.get("mirror"),
        dirty=bool(obj.get("dirty", False)),
        accept=bool(obj.get("accept", False)),
    )


def encode_server(msg: ServerMsg) -> str:
    """序列化 ServerMsg；None/空串/0 字段一并省略，消息保持紧凑。"""
    return json.dumps(
        {k: v for k, v in msg.__dict__.items() if v not in (None, "", 0)},
        ensure_ascii=False)
