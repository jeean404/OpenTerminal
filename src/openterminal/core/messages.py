"""编排层协议消息与交互式 AI 工具通道（Task 1 自 core.py 原样搬入）。

搬移规则：函数体逐字节不变。_ANSI_RE 原模块有两处定义、后处覆盖前处——
运行时生效的是连接后命令集段的富版正则，这里只保留富版（行为等价）。
InteractiveRunner 经 worker 回指 PipelineCore（鸭子类型，无 import 环）。
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass

from ..shell.integration import agent_exec_line
from ..session.base import CommandResult

_OT_DBG = bool(os.environ.get("OT_WEB_DEBUG"))
_OT_T0 = time.monotonic()   # _dbg 相对时间戳基准（轨迹排障用时差分析）


def _dbg(*a) -> None:
    """OT_WEB_DEBUG=1 时打印交互式状态机轨迹（排障用，默认静默）。"""
    if _OT_DBG:
        print(f"[otdbg +{time.monotonic() - _OT_T0:7.3f}s]", *a, flush=True)


# CSI / OSC / 字符集切换等转义:提示符重绘、PSReadLine 上色都会带上,剥掉才
# 判得出「提示符在行尾」(见 PipelineCore._cs_text)
_ANSI_RE = re.compile(
    r"\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|"
    r"\x1b[()#][0-9A-Za-z]|\x1b[=>78M]")



def _ansi_free(s: str) -> str:
    return _ANSI_RE.sub("", s)


class PasswordCancelled(ConnectionError):
    """终端内联密码输入的 Ctrl+C：用户主动中止连接尝试（区别于连接意外
    关闭——_run 捕获后向前端发「连接已取消」而非「连接失败：…」）。"""


_PROBE_TIMEOUT = 1.5
#: 工具执行通道不可用的退出码（hook 不在位 / 远端 shell 已退出）
CHANNEL_DEAD_EC = 126
#: 通道不可用时随 CommandResult 回给工具卡的可读文案
CHANNEL_DEAD_MSG = ("远端 shell 已退出或无 AI 集成通道，命令未执行；"
                    "请重新登录（或回到可集成的 shell）后重试")



@dataclass
class ServerMsg:
    type: str                      # ready | event | approval | ask_password | ask_password_dismiss | ask_host_key | status | closed | usage | cmdset | stage
    tab_id: str = ""
    host: str = ""
    user: str = ""
    distro: str = ""
    event: dict | None = None      # 事件：task_start/ai_token/ai_think/ai_collapse/ai_tool/ai_card/final/denied/limit/error；
                                  # term_open/term_close = 命令执行边界括号（输出归属，见 core/exec_events.py）
    command: str = ""              # approval：待审批命令
    reasons: str = ""
    label: str = ""
    message: str = ""
    text: str = ""
    model: str = ""                # 当前模型 id（ready）
    models: list[str] | None = None   # 可切换模型列表（ready）
    prompt: str = ""               # ready：真实提示符纯文本（OSC 133 B 捕获）
    risk: str = ""                 # 审批风险级（approval）：high 红框 | normal 蓝框
    id: int = 0                    # approval：关联命令卡 id（ai_tool start 同 id，无卡=0）
    tokens_in: int = 0             # 会话累计输入 token（usage）
    tokens_out: int = 0            # 会话累计输出 token（usage）
    estimated: bool = False        # usage：当前累计为 tiktoken 估算口径（前端加 ≈）
    interactive: int = 0           # ready：hook 集成就绪（1 = AI 可用）
    state: str = ""                # cmdset:running | done
    cmd: str = ""                  # cmdset:running 当前命令原文(应答行为空,防泄密)
    index: int = 0                 # cmdset 当前行号（1 起；encode_server 省略 0）
    total: int = 0                 # cmdset 总行数
    auth_kind: str = ""            # ask_password：省略=主机认证；"cmdset"=命令集密码弹窗


@dataclass
class ClientMsg:
    type: str                      # raw(键盘字节) | decision | auth | interrupt | mode | resize | change_model | close | submit | pad | boundary_settled | new_session
    text: str = ""                 # mode: "ssh" | "agent"；auth: 密码文本；submit: 前端拦截的自然语言整行
    data: bytes = b""              # raw 按键字节（二进制帧整帧直发 PTY）
    decision: dict | None = None
    auth_kind: str = ""            # password | password_remember | password_cancel
                                   # | nested_password(_cancel) | remember_yes/no
                                   # | host_key | cmdset
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


class InteractiveRunner:
    """交互式模式的 AI 工具通道：为 PtyShellBackend 鸭子类型 ShellSession。

    工具命令经 ``__ot_exec__ `` 通道注入同一个 PTY（与用户共享 shell 状态：
    cd/环境变量/别名全部生效）；Ctrl+U / Ctrl+Y 括号保护用户已输入的半行。
    输出由泵按 EXEC 相位字节捕获并直写主 xterm，OSC 133 C…D 标记界定结束
    与退出码。超时发 Ctrl+C 中断再宽限 3s，仍无 D 标记则按 130 返回。
    """

    def __init__(self, worker: "PipelineCore") -> None:
        self.w = worker
        self.cwd = ""

    async def run(self, command: str, *, timeout: int | None = None,
                  on_output=None) -> CommandResult:
        # on_output：backend.run 的兼容参数。单管线后命令输出由 exec 状态机
        # 直写主 xterm，不再经回调旁路转发，这里仅接受不使用。
        w = self.w
        to = timeout or w.cfg.shell.timeout_default
        async with w._runner_lock:
            if not await w.ai._wait_exec_idle(to):
                return CommandResult(
                    output="[ot] 目标 shell 正忙（命令或 AI 执行中），请稍后重试",
                    exit_code=124, truncated=False, cwd=self.cwd)
            if not await self._hook_channel_ready():
                # hook 不在位（TMOUT 登出 / 换壳 / 陈旧）：盲注入会把
                # __ot_exec__、\x03、__ot_pad 全落进裸壳——command not found
                # 刷屏，命令本体还被裸壳拆段照常执行（真机截图）。重注入救不
                # 回就快速失败，工具卡显示可读原因而不是注垃圾进终端后超时 130
                return CommandResult(
                    output=CHANNEL_DEAD_MSG, exit_code=CHANNEL_DEAD_EC,
                    truncated=False, cwd=self.cwd)
            w._exec_buf = bytearray()
            w._exec_truncated = False
            fut = asyncio.get_running_loop().create_future()
            w._exec_future = fut
            try:
                # 不吞回显：注入行的 tty 回显必须原样进 xterm——Windows ConPTY
                # 按自己的缓冲区模型发绝对光标定位重绘，吞字节会让 xterm 光标
                # 与 ConPTY 失步（实测提示符叠印/内容覆盖的根因）
                await w.session.send_raw(b"\x15")     # 收纳用户半行输入
                await w.session.send_raw(
                    agent_exec_line(w._shell_kind, command, w._b64flag))
                try:
                    res = await asyncio.wait_for(asyncio.shield(fut), to)
                except asyncio.TimeoutError:
                    if w.hook._hook_ok():
                        # hook 不在位时 \x03 也是落进裸壳的垃圾（P2-5）
                        await w.session.send_raw(b"\x03")  # 中断工具命令
                    try:
                        res = await asyncio.wait_for(asyncio.shield(fut), 3.0)
                    except asyncio.TimeoutError:
                        res = CommandResult(
                            output=bytes(w._exec_buf).decode("utf-8", "replace"),
                            exit_code=130, truncated=False, cwd=self.cwd)
            finally:
                w._exec_future = None
                # \x19 接回 \x15 收走的半行：hook 已把 ^Y 重绑为「恢复注入前
                # 半行」（存档非空才接回，空行零副作用，不经 kill ring）——
                # 任务期用户打字与注入交错时打字内容原样接回行首（真机「任务
                # 跑着打字只剩尾巴」根因）。原生 ^Y 会复活 kill ring 旧内容，
                # hook 不在位（su - 重置）时不发，保持旧的原生丢弃语义。
                if w.hook._hook_ok():
                    await w.session.send_raw(b"\x19")
            if res.cwd:
                self.cwd = res.cwd
            return res

    async def _hook_channel_ready(self) -> bool:
        """工具注入前的 hook 活性门禁：不在位先试一次重注入自愈。

        须在 _runner_lock 内调用（run 已持有）——_ensure_integrated_locked
        不取锁，避免与 run / _shell_pad 的注入序列重入死锁。
        结构性不可集成（_hook_gone＝探测判定换了壳/旧版 shell）不空转注入，
        保证该路径下 PTY 输入流一个字节都不发。
        """
        w = self.w
        if w.hook._hook_ok():
            w._hook_seen = True
            return True
        if w._hook_gone:
            return False
        try:
            await w.hook._ensure_integrated_locked()
        except Exception:  # noqa: BLE001 - 重注入失败即通道不可用
            return False
        return w.hook._hook_ok()

