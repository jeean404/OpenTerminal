"""WebSocket 消息协议：dataclass + 序列化（纯函数，可单测）。

单管线契约（设计文档 §5）：
- 客户端 → 服务端：JSON 文本（控制）或二进制帧（键盘字节直发）。
- 服务端 → 客户端：JSON 文本（控制/卡片事件）或二进制帧（PTY 字节直写主
  xterm，唯一显示管线）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass


@dataclass
class ClientMsg:
    type: str                      # raw(键盘字节) | decision | auth | interrupt | mode | resize | change_model | close | submit | pad | boundary_settled
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


@dataclass
class ServerMsg:
    type: str                      # ready | event | approval | ask_password | ask_host_key | status | closed | usage | cmdset
    tab_id: str = ""
    host: str = ""
    user: str = ""
    distro: str = ""
    event: dict | None = None      # 事件：task_start/ai_token/ai_think/ai_collapse/ai_card/final/denied/limit/error
    command: str = ""              # approval：待审批命令
    reasons: str = ""
    label: str = ""
    message: str = ""
    text: str = ""
    model: str = ""                # 当前模型 id（ready）
    models: list[str] | None = None   # 可切换模型列表（ready）
    prompt: str = ""               # ready：真实提示符纯文本（OSC 133 B 捕获）
    risk: str = ""                 # 审批风险级（approval）：high 红框 | normal 蓝框
    tokens_in: int = 0             # 会话累计输入 token（usage）
    tokens_out: int = 0            # 会话累计输出 token（usage）
    estimated: bool = False        # usage：当前累计为 tiktoken 估算口径（前端加 ≈）
    interactive: int = 0           # ready：hook 集成就绪（1 = AI 可用）
    state: str = ""                # cmdset:running | done
    index: int = 0                 # cmdset 当前行号（1 起；encode_server 省略 0）
    total: int = 0                 # cmdset 总行数
    auth_kind: str = ""            # ask_password：省略=主机认证；"cmdset"=命令集密码弹窗


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
