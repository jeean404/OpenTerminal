"""单管线核心：PTY 直通 + hook 记账 + AI 任务（自 web/worker.py 搬移，设计见 docs/superpowers/specs/2026-09-27-cli-single-pipeline-design.md）。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ServerMsg:
    type: str                      # ready | event | approval | ask_password | ask_host_key | status | closed | usage | cmdset | stage
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
