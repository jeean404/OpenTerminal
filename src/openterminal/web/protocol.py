"""WebSocket 消息协议：dataclass + 序列化（纯函数，可单测）。

单管线契约（设计文档 §5）：
- 客户端 → 服务端：JSON 文本（控制）或二进制帧（键盘字节直发）。
- 服务端 → 客户端：JSON 文本（控制/卡片事件）或二进制帧（PTY 字节直写主
  xterm，唯一显示管线）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from ..core import ServerMsg  # noqa: F401 —— 再导出（旧 import 路径继续可用）


@dataclass
class ClientMsg:
    type: str                      # raw(键盘字节) | decision | auth | interrupt | mode | resize | change_model | close | submit | pad | boundary_settled | new_session
    text: str = ""                 # mode: "ssh" | "agent"；auth: 密码文本；submit: 前端拦截的自然语言整行
    data: bytes = b""              # raw 按键字节（二进制帧整帧直发 PTY）
    decision: dict | None = None
    auth_kind: str = ""            # password | host_key
    remember: bool = False         # auth 密码勾选「记住」→ 写入 keyring
    model: str = ""                # change_model：目标模型 id
    cols: int = 0
    rows: int = 0
    pad: int = 0                   # pad：请求 shell 打印 N 个空行（卡片占位行）
    mirror: str | None = None      # pad：前端可信的半行镜像（"" = 空半行不必收纳；
                                   # None = 镜像不可信，worker 走 \x15 丢弃旧路径）
    dirty: bool = False            # submit：半行缓冲被转义/控制键清过（历史召回
                                   # 后镜像不可信）→ worker 走 \x03 安全路径不补 \r
    accept: bool = False           # rescue：失败救援卡决策（true = 交给 AI）


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
