"""单管线核心：PTY 直通 + hook 记账 + AI 任务（自 web/worker.py 搬移，设计见 docs/superpowers/specs/2026-09-27-cli-single-pipeline-design.md）。

显示模型：PTY 字节是唯一显示管线——核心除需吞除/记账的字节外，把
live/exec 相位文本原样转发给前端出口；不做任何显示路由（无
term_open/commit/command_done、无直通活块、无嵌套 shell 状态机、无写死
提示符）。核心只做三件事：

1. 记账：OSC 133（A/B/C/D 相位）+ OSC 6337（CMD/AI/EXEC 行报告）的
   StreamRouter 监听——history_db、退出码、AI 上下文；
2. AI：agent（自然语言任务）+ ``__ot_exec__`` 工具命令注入通道，输出经
   ai_token/ai_think/ai_collapse/ai_card/final 事件驱动前端卡片层；
3. 非显示事件：approval/ask_password/ask_host_key/usage 等。

执行上下文从 10 种瘦身到 3 种（§5.2）：``agent``（AI 工具执行中）、
``probe``（隐藏探测）、``silent``（模式开关注入）；用户命令不进栈，仅记账。
"""

from __future__ import annotations

import asyncio
import getpass
import os
import re
import time
import uuid
from collections import deque
from dataclasses import dataclass, replace

_OT_DBG = bool(os.environ.get("OT_WEB_DEBUG"))

_OFFLINE_CAP = 500   # 断线期缓存的 JSON 控制帧上限（防长期断线涨内存）


def _dbg(*a) -> None:
    """OT_WEB_DEBUG=1 时打印交互式状态机轨迹（排障用，默认静默）。"""
    if _OT_DBG:
        print("[otdbg]", *a, flush=True)

from . import cmdset
from . import history_db
from .config import Config, TargetConfig, app_dir
from .connections import open_session, parse_user_at_host
from .history_db import HISTORY_RECALL_LIMIT
from .policy import Policy

# 健康路径兜底：补发 \r 后等 hook AI 上报的最长时限（超时改走外部启动）
SUBMIT_FALLBACK_DELAY = 1.2
# 嵌套密码验证窗口：密码打进 PTY 后 hold 前端输入的时长上限（auth 结果输出
# 到达即提前结束）；超时视为已resolved，防输入被永久 hold
_PW_VERIFY_TIMEOUT = 3.0
# hold 释放防抖：auth 结果输出后稍等再放——隧道合包可能把 deny 与重讨提示符
# 拆成两块，即放会让抢跑命令打进新密码位
_PW_HOLD_RELEASE = 0.25
# AI 僵尸任务静默上限：_ai_task 存活但长时间零产出（无 ai_token/think/tool、
# 无非遇抑 echo）→ 按僵尸回收。触发场景：任务卡在某个等不住的 await 上一直
# 不归 None，使提示符幕帘在每次 prompt_start 重新关帘（见 _curtain_close），
# shell 重绘的新提示符永被扣住 → 底行目录冻结「像写死」。回收后 finally 自动
# 清 _ai_task 并开帘，提示符即刻恢复。取长值防空转思考被误杀。
_AI_ZOMBIE_T = 180.0
_PW_MODAL_DISMISS = 0.5   # 密码提示符被消费后陈旧模态的代关防抖

# 换壳探测（_probe_shell_kind）：等 __OTPROBE__ 输出的最长时限
_PROBE_TIMEOUT = 1.5
#: 工具执行通道不可用的退出码（hook 不在位 / 远端 shell 已退出）
CHANNEL_DEAD_EC = 126
#: 通道不可用时随 CommandResult 回给工具卡的可读文案
CHANNEL_DEAD_MSG = ("远端 shell 已退出或无 AI 集成通道，命令未执行；"
                    "请重新登录（或回到可集成的 shell）后重试")
# shell 自行退出的文字特征（bash TMOUT 自动登出 / ssh 客户端断链）。
# 认「视觉行」而不是字节行：真机告别语紧跟提示符重画落进流里，前缀是
# ESC[?2004l + CR + BEL，字节行首锚点跨不过那个 CR，一律漏检（真机审批期
# TMOUT 后 __ot_pad 连环 command not found 的根因）。故先按 CR/LF 切出视觉
# 行、剥掉转义与控制符，再整行全文匹配——告别语前只允许一段提示符宽度的
# 普通字符（bash 是紧贴已打出的提示符写的），后面只许空白；命令输出里恰好
# 含这些词的长行（grep 日志、带时间戳的行）撑不进这个宽度或后面还拖着正文，
# 不误判。裸 logout 只在挂起窗口认（见 _shell_exit_window）。
# （模块后段另有一个喂 str 的 _ANSI_RE，字节流这里必须另起名字，否则被覆盖）
_EXIT_ANSI_RE = re.compile(
    rb"\x1b\[[0-9;?]*[ -/]*[@-~]"               # CSI：颜色/光标/模式
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"      # OSC：标题 / 133 标记
    rb"|\x1b[@-_]"                               # 其余单字符转义
)
_EXIT_CTRL_RE = re.compile(rb"[\x00-\x1f\x7f]")
#: 强特征：任意提示符位置都认（空闲提示符上的 TMOUT 最常见），但整行须是
#: 「≤48 字符前缀 + 告别语 + 行尾空白」这一形状
_SHELL_EXIT_RULES = (
    (re.compile(rb".{0,48}timed out waiting for input: auto-logout\s*",
                re.IGNORECASE), "timed out waiting for input: auto-logout"),
    (re.compile(rb"Connection to .*?\b(?:closed|dropped)\b.*",
                re.IGNORECASE), "Connection closed"),
)
#: 弱特征：整行就是一个裸 logout——仅审批挂起窗口认
_SHELL_EXIT_WEAK_RULES = (
    (re.compile(rb"logout\s*", re.IGNORECASE), "logout"),
)
# 回车看门狗时限：健康路径补发 \r 后，集成壳必在 PROMPT_COMMAND 里回 OSC 标记
# （133;D + 133;A/B）。到点只收到纯文本、一个标记都没有 = 承接这个回车的根本
# 不是集成壳（嵌套 shell 被 TMOUT/exit 收走后落回的裸壳）——此时健康路径的裸
# \r 会把整行自然语言交给它当命令执行（真机 -bash: 执行: command not found）
_HOOK_LIVENESS = 1.0


def _looks_ai(text: str) -> bool:
    """自然语言粗判（外部分类触发链）。与 shell hook 的分类语义对齐：只有
    「首词明显不是命令」才拦去模型，含 CJK 参数的命令（如 grep 错误 app.log）
    仍走终端执行。英文自然语言不在前端拦截范围，仍由 hook 的 type -t 分类。"""
    t = text.strip()
    if t.startswith("?"):
        return True
    parts = t.split()
    if not parts:
        return False
    first = parts[0]
    for ch in ";|&()":
        first = first.split(ch, 1)[0]
    if any("一" <= c <= "鿿" or "぀" <= c <= "ヿ"
           or "가" <= c <= "힯" for c in first):
        return True
    # 首词不像命令名（引号、波浪号、空格切分出的奇怪 token）→ 交给模型
    return not all(
        c.isalnum() or c in "./@%+:=_,-" for c in first)
from .secrets_store import load_password, store_password
from .shell_integration import (
    StreamRouter, agent_exec_line, history_inject_line, history_quiet_line,
    injection_lines, is_internal_line,
    parse_probe, probe_command, toggle_line,
)
from .shell_session import (
    _PASSWORD_PROMPT_RE, CommandResult, _needs_password_prompt)
from .sysprobe import (
    LOCAL_PROFILE, MANUAL_PRESETS, load_host_cache, probe_profile,
    save_host_cache,
)
from .transcript import open_transcript


# AI 栈（deepagents/langchain/anthropic，导入约 4s——启动耗时实测大头）与
# CLI 启动/建连/纯 shell 路径解耦：下面两个名字延迟到首个 AI 任务
# （_ensure_agent→_build_agent_now）时由 _load_agent_stack 惰性填充。保留为
# 模块级占位（初值 None）有两个硬约束：
#   ① web/worker.py 的 `from ..core import build_agent` 再导出 + _PatchBridge
#      转发要求 hasattr(core, "build_agent") 为真；
#   ② test_term_frontend / test_web_worker 靠
#      monkeypatch.setattr(cmod/wmod, "build_agent", fake) 打桩——一旦被覆盖
#      就非 None，_load_agent_stack 跳过真导入直接用桩。
build_agent = None
build_chat_model = None


def _load_agent_stack() -> None:
    """把 AI 栈入口惰性载入模块级 build_agent/build_chat_model。已被测试
    monkeypatch 覆盖（非 None）的名字原样保留，不触发 deepagents 真导入。"""
    global build_agent, build_chat_model
    if build_agent is None:
        from .agent import build_agent as _build_agent
        build_agent = _build_agent
    if build_chat_model is None:
        from .agent import build_chat_model as _build_chat_model
        build_chat_model = _build_chat_model


@dataclass
class ServerMsg:
    type: str                      # ready | event | approval | ask_password | ask_password_dismiss | ask_host_key | status | closed | usage | cmdset | stage
    tab_id: str = ""
    host: str = ""
    user: str = ""
    distro: str = ""
    event: dict | None = None      # 事件：task_start/ai_token/ai_think/ai_collapse/ai_tool/ai_card/final/denied/limit/error
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
            if not await w._wait_exec_idle(to):
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
                    if w._hook_ok():
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
                if w._hook_ok():
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
        if w._hook_ok():
            w._hook_seen = True
            return True
        if w._hook_gone:
            return False
        try:
            await w._ensure_integrated_locked()
        except Exception:  # noqa: BLE001 - 重注入失败即通道不可用
            return False
        return w._hook_ok()


# --- 连接后命令集时序(模块级便于测试 monkeypatch 调小)---
CMDSET_ECHO_TIMEOUT = 2.0     # 等命令回显封顶(秒)
CMDSET_QUIET = 0.3            # 输出静默判定窗口(秒)
CMDSET_PROMPT_TIMEOUT = 10.0  # 等交互提示封顶(秒);超时跳过该应答行
CMDSET_RESUME_QUIET = 1.2     # 暂停等输入:提示消失后再静默此时长才继续(秒)
# 静默≠跑完:ssh/sudo 类握手期会静默数秒才吐交互提示(password:),静默判定把
# 这段空档当「命令跑完」,下一条命令就抢跑进它的 stdin。密码类命令静默后按
# CMDSET_PROMPT_TIMEOUT 继续观察:见交互提示即停下等应答、见新 shell 提示符
# 即判定跑完,两者都到才放行。非密码类命令不观察(不引入额外延迟)。
_CMDSET_PROMPT_RE = re.compile(
    r"(password|passphrase|密码|口令)\s*[:：]\s*$|\[sudo\]|yes/no|verification code",
    re.IGNORECASE)
# 密码类与确认类提示分开:@引用是密码,只能应答密码类——确认类(yes/no)
# 会回显输入,密码打上去就明文漏进终端(真机:跳转时 host key 确认先弹)。
# 明文应答(如 yes/y)两类都应答。
_CMDSET_SECRET_RE = re.compile(
    r"(password|passphrase|密码|口令)\s*[:：]\s*$|\[sudo\]", re.IGNORECASE)
_CMDSET_CONFIRM_RE = re.compile(r"yes/no|verification code", re.IGNORECASE)
# 新 shell 提示符 = 命令真跑完(含嵌套 ssh/su - 登录后的新提示符)。
# 密码类提示不以 $/#/%/> 结尾,故与 _CMDSET_PROMPT_RE 互斥,不会互相误判。
_CMDSET_DONE_RE = re.compile(r"[$#%>]\s*$")
# CSI / OSC / 字符集切换等转义:提示符重绘、PSReadLine 上色都会带上,剥掉才
# 判得出「提示符在行尾」(见 PipelineCore._cs_text)
_ANSI_RE = re.compile(
    r"\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|"
    r"\x1b[()#][0-9A-Za-z]|\x1b[=>78M]")


class PipelineCore:
    def __init__(self, cfg: Config, target_name: str, *,
                 policy: Policy | None = None) -> None:
        self.cfg = cfg
        self.target_name = target_name
        self.tab_id = uuid.uuid4().hex[:8]
        self.policy = policy or Policy(
            mode=cfg.policy.mode,
            auto_extra=cfg.policy.auto_extra,
            approve_extra=cfg.policy.approve_extra,
            deny_extra=cfg.policy.deny_extra,
        )
        # 模型与用量（Web 状态栏展示 / 切换）
        self._model = cfg.model                 # 当前 ModelConfig（可运行时切换）
        models = list(getattr(cfg.model, "models", [])) or [cfg.model.model]
        if cfg.model.model not in models:
            models.insert(0, cfg.model.model)
        self._models = models
        self._tokens_in = 0
        self._tokens_out = 0
        self.transcript = open_transcript(self.tab_id)
        self.session = None
        self.profile = None
        self.agent = None
        self.allowed: set[str] = set()
        self.backend = None
        self.connected = asyncio.Event()
        self._sink = None
        self._hb = None                # 应用层心跳任务（attach 起、close 自然退）
        self._pad_reinject_at = 0.0    # _shell_pad hook 补注入节流阀（monotonic）
        self._hook_seen = False        # hook 曾在位（掉线才补注入；结构性无则不试）
        self._outbox: asyncio.Queue = asyncio.Queue()
        self._inbox: asyncio.Queue = asyncio.Queue()
        self._pws: asyncio.Queue = asyncio.Queue()      # 密码应答
        self._hks: asyncio.Queue = asyncio.Queue()      # 主机密钥应答
        self._decisions: asyncio.Queue = asyncio.Queue()  # 审批决策
        # 未决审批记账：审批帧只发一次，WS 断隙/刷新即丢，core 会永久等决策
        # （= 任务假死，真机 2026-10-06）；attach 重挂时据此补发
        self._pending_approval: ServerMsg | None = None
        # 断线期攒下的 JSON 控制帧（终局/用量/状态…）：PTY 字节帧照旧丢，
        # 控制帧丢了前端就永久收不到任务收尾（真机「AI 正在思考」不收）
        self._offline: list = []
        self._boundary_ack = asyncio.Event()  # 前端阶段结账完成（ai_boundary 门闩）
        self._pad_task: asyncio.Task | None = None  # 在途 pad 打字任务（门闩排序用）
        self._task: asyncio.Task | None = None
        self._target: TargetConfig | None = None   # _connect 时持有(命令集等读取)
        self._cs_tail: bytearray | None = None     # 命令集监听的输出滚动缓冲
        self._cs_pw_pending = False   # 上一条命令是密码类:发下条前先确认未停在提示
        self._cs_task: asyncio.Task | None = None
        self._cs_resume = asyncio.Event()          # 「继续」按钮强制放行
        self._target_host = ""       # _connect 时填充
        self._target_user = ""
        self._sender: asyncio.Task | None = None
        self._pump: asyncio.Task | None = None
        self._closed = False
        self._closed_sent = False  # closed 消息已入 outbox（sender 退出门闩）
        # 泵 EOF（_pump_eof）置位：断线后首个键经 _on_keys 触发 _revive_session
        self._session_dead = False
        # 模型上下文轮次：/clear 自增 → TaskRunner 换新 thread_id，langgraph
        # MemorySaver 按 thread 存历史，旧上下文不再进新任务的提示词（省 token，
        # 语义同 CLI /clear 换 session_id）
        self._ctx_epoch = 0
        # --- 交互式 shell 集成（单管线真终端）---
        self._interactive = False    # hook 集成就绪；False = 纯终端直通（无 AI）
        self._display = "agent"      # agent = hook 集成 / ssh = 纯透传（Shell 模式）
        self._router: StreamRouter | None = None
        self._shell_kind: str | None = None   # bash | zsh | powershell
        self._b64flag = "-d"
        # su - / 嵌套 shell 探测：当前提示符后面的真实 shell 族不再是外层
        # 会话的 _shell_kind。_ensure_integrated 探测不到可集成的 shell
        # （bash 3.2 / 其他族 / 前台占用）时置 _hook_gone——标记流不足以
        # 证明 hook 在位（zsh 版 PS1 落进 bash 照样发 OSC 133 标记，函数
        # 却一个都没定义出来），pad/健康路径/兜底必须按 hook 不在位降级。
        # 嵌套 shell 退出（_open_cmds 清空）后复位，外层 hook 自然恢复。
        self._hook_gone = False
        # 「hook 陈旧」= 带 hook 的那个 shell 整体消失了（TMOUT 自动登出 /
        # exit / logout）。bash 退出不发任何告别标记，_hook_gone 的两个入口都
        # 够不着：探测没跑过；而它唯一的复位路径「_open_cmds 清空」在跳板机
        # 拓扑下永不发生（外层 `ssh 跳板机` 帧整段会话开着）。死壳留下的
        # _last_mark_at 会让 _inner_ssh_prompt_live 继续放行健康路径，补发的
        # 裸 \r 把整行自然语言送进落回来的裸壳执行（用户报障本体）。
        # 由回车看门狗置位；任一 OSC 标记到达即撤销（外层集成壳重新画出提示符
        # = 自愈），重注入落地亦作废。
        self._hook_stale = False
        self._hook_watch = None         # 回车看门狗任务（_HOOK_LIVENESS）
        self._hook_watch_text = False   # 看门狗窗口内收到过纯文本
        self._probe_buf: bytearray | None = None  # 探测行输出收集（_probe_shell_kind）
        # 嵌套密码提示符状态机：ssh/sudo/scp/rsync 在 PTY 前台讨密码时
        # （典型：预置命令 `ssh 跳板机` 后的登录），①自然语言拦截链必须
        # 透传回车（密码被误判成自然语言 = 登录被 ^C 掉）；②可弹模态收
        # 密码并按目标主机写入凭据库，下次自动填充
        self._pw_tail = bytearray()     # 输出滚动尾窗（提示符匹配）
        self._exit_tail = bytearray()   # 登出特征滚动窗（_detect_shell_exit）
        self._pw_prompt_seen = False    # 尾窗以密码提示符结尾（已触发应答）
        self._nested_pw_attempts = 0    # 当前嵌套命令已应答次数（0 允许自动填充）
        self._nested_pw_ctx: tuple[str | None, str | None, int | None] | None = None
        # 验证窗口（密码已打进 PTY、auth 结果输出未到）：期间前端输入全部
        # hold（抢跑命令落进 ssh 输入队列会被当下一条密码吃掉，真机连排
        # Permission denied）；hold 项 ("raw", bytes) / ("submit", text, dirty)
        self._pw_verifying = False
        self._pw_verify_at = 0.0
        self._pw_verify_timer = None   # 验证窗口强制到期(不依赖输出驱动)
        self._pw_hold: list[tuple] = []
        self._pw_hold_timer = None     # hold 释放防抖任务（_PW_HOLD_RELEASE）
        self._pw_at_end = False        # 上一 pump 块尾窗是否以密码提示符结尾
        self._pw_modal_open = False    # 嵌套密码模态在屏等应答（提示符被消费即代关）
        self._pw_dismiss_timer = None  # 模态代关防抖任务（_PW_MODAL_DISMISS）
        # 降级路径 \x03 后 readline 的 ^C 回显吞除：只吞 "^C" 两字节（跨块
        # 悬置），\r\n 与提示符重画照常透传——光标随后被 \r\n 重新锚定，不
        # 失步（旧「整窗吞」造成回显拼行的教训不适用：这里不吞提示符段）。
        # zsh/zle 不回显 ^C，窗口自然过期零副作用
        self._intr_swallow_until = 0.0
        self._intr_pending = b""        # 悬置的块尾 "^"（等跨块 C）
        self._cur_prompt = ""        # 最近一次 B 标记捕获的提示符纯文本
        self._pending_report = None  # C 标记前最近的行报告 (inst, kind, line)
        self._open_cmds: dict[int, str] = {}  # 用户命令记账 inst -> line（退出码）
        self._open_cmd_at: dict[int, float] = {}  # 用户命令帧开帧时刻（内层 ssh 提示符活性判定）
        # 执行上下文栈：仅 agent（AI 工具执行中）/ probe（隐藏探测）/
        # silent（模式开关注入）；用户命令不进栈
        self._exec_stack: list[dict] = []
        self._exec_future = None     # InteractiveRunner 等待 D 标记的 future
        self._hidden_exec = False    # 隐藏探测在途（ctx=probe，输出只捕获不转发）
        self._exec_buf = bytearray() # AI 工具命令输出捕获
        self._exec_truncated = False
        self._suppress_live = False  # 注入窗口吞 live 字节（注入行回显不外显）
        self._suppressed_echo = False  # 窗口内吞过回显：exec 开始时补 \r\n 收束行
        self._pending_agent_cmds: "deque[str]" = deque()  # 已登记未执行的 AI 工具命令
        self._agent_open_cmd: str | None = None  # 已开 ai_collapse、尚未收束的命令
        self._task_cmd_started = False  # 本任务是否已发 ai_collapse（首个工具命令）
        # 工具卡 id 必须全会话唯一：TaskRunner 的 tool index 每个任务从 1 重新
        # 计数，直接透传会让多个任务的卡都叫 "tool1"——前端 slot/feed root 按
        # id 迁移互抢宿主（每帧重挂 = 卡片闪烁），store 还会堆同 id 卡
        self._tool_card_seq = 0
        self._tool_idx_map: dict[int, int] = {}   # runner 局部 index → 全局卡 id
        self._ai_task: asyncio.Task | None = None
        self._ai_ping_at = 0.0  # AI 任务最近一次有产出（_live）的时间戳，僵尸判据
        self._ai_queue: list = []           # AI 忙时排队 (line, hooked)
        # --- 外部触发链的 hook 存活判定（Workbench 蓝色回显路径）---
        # hook 的 OSC 标记由 PROMPT_COMMAND/PS1 产生：su - 等 login shell 重置
        # hook 后 PTY 只有裸文本、标记绝迹。比较「最近标记 vs 最近纯文本」的
        # 时间戳即可无成本判定：标记不落后于文本 = 标记仍在产出 = hook 在位。
        self._last_mark_at = 0.0    # 最近一次 OSC 标记事件（A/B/D/report/exec）
        self._last_live_at = 0.0    # 最近一次未被吞除的纯文本输出
        self._hook_report_pending: str | None = None   # 补发 \r 后等待 AI 上报的行
        self._suppress_ai_report: str | None = None    # 兜底已启动后迟到的重复上报
        self._fallback_task: asyncio.Task | None = None  # _submit_fallback 句柄（测试/关闭可取消）
        # --- 失败救援（分类判 CMD 就直接执行；失败即信号，一键交 AI）---
        self._user_out = bytearray()  # 当前用户命令输出捕获（救援上下文，尾部截断）
        self._rescue_open = False     # 救援卡待决策（同时最多一张，防连败刷屏）
        self._rescue_ctx: tuple | None = None   # (line, ec, output)：决策时的任务上下文
        self._runner: InteractiveRunner | None = None
        self._runner_lock = asyncio.Lock()
        self._ev_prompt = asyncio.Event()    # 模式切换：等提示符重画
        # 任意流字节（live/exec 回显）到达信号：重注入分片逐片等回显做应答
        # （固定短间隔会在 shell 执行间隙把分片堆进 canonical 缓冲溢出丢块）
        self._ev_stream = asyncio.Event()
        self._pump_phase = "read"   # 排障：泵当前所处 stage（心跳打出）
        # pad 每块等提示符重画的上限（可测化注入；超时容忍——前端按缓冲
        # 实测记账，应答不作为凭据）
        self._pad_prompt_timeout = 2.0
        self._ev_exec_end = asyncio.Event()  # 模式切换：等 toggle 的 D 标记
        # 提示符幕帘：任务运行期扣住 shell 的提示符重绘字节（A 标记起的
        # live 文本），让流式卡期间底部不出现空提示符——任务结束/下一次
        # 注入才放行（用户诉求：对话完全结束才显示命令提示符）。任何对
        # PTY 的写入（命令/pad/口令注入）都会先开帘放行旧字节再注入，
        # 字节序不变，只是提示符段的可见时机后移。
        self._curtain = False
        self._curtain_parts: list[str] = []   # 扣住的 live 文本（按序）
        self._curtain_at = 0.0                # 关帘时刻（防呆：超时自动放行）

    # --- Agent 输入框斜杠命令 ---
    def _is_pwsh(self) -> bool:
        return self.profile is not None and \
            "powershell" in (self.profile.shell or "").lower()

    # --- 提示符幕帘（任务期扣住提示符重绘，注入/收尾放行）---
    def _install_curtain_gate(self) -> None:
        """把 session.send_raw 包上开帘闸：任务幕帘关着时，任何 PTY 写入
        （命令/pad/口令/镜像注入，含 runner 直写）先放行扣住的字节再写入——
        字节序不变，唯一的可见性变化是提示符段整体后移。实例属性遮蔽方法，
        对持有同一 session 的 runner/backend 全部生效。"""
        if self.session is None:
            return
        raw_send = self.session.send_raw

        async def _gated(data: bytes, _raw=raw_send):
            if self._curtain:
                await self._curtain_open()
            await _raw(data)

        try:
            self.session.send_raw = _gated   # type: ignore[method-assign]
        except Exception:                    # noqa: BLE001 - 只读会话对象则退化为无幕帘
            pass

    async def _curtain_open(self) -> None:
        """开帘：把扣住的 live 文本按原序放行（无扣留则空操作）。"""
        if not self._curtain:
            return
        self._curtain = False
        parts, self._curtain_parts = self._curtain_parts, []
        if parts:
            await self.emit_bytes("".join(parts).encode("utf-8", "replace"))

    def _curtain_close(self) -> None:
        if self._ai_task is None:
            return
        self._curtain = True
        self._curtain_parts = []
        self._curtain_at = time.monotonic()

    # --- 模型兜底分类（cli 共用形态；web 侧行分类由 hook 完成）---
    async def _llm_classify(self, text: str) -> str:
        from .agent import message_text

        _load_agent_stack()
        model = build_chat_model(self._model)
        resp = await model.ainvoke([
            ("system", "判断用户输入是 shell 命令还是自然语言任务，"
                       "只回答一个词：command 或 task。"),
            ("user", text),
        ])
        answer = message_text(resp).strip().lower()
        return "command" if answer.startswith("command") else "task"

    # --- sink / 消息入口 ---
    def attach(self, sink) -> None:
        self._sink = sink
        if self._sender is None:
            self._sender = asyncio.create_task(self._sender_loop())
        if self._task is None:
            self._task = asyncio.create_task(self._run())
        if self._hb is None:
            self._hb = asyncio.create_task(self._heartbeat())
        self._flush_offline()
        if self._pending_approval is not None:
            # 重连/刷新重挂：补发未决审批（首挂时必为 None，不会重复投）
            self._emit_nowait(self._pending_approval)

    async def _heartbeat(self) -> None:
        """应用层心跳：10s 一个 ping，给前端看门狗当「服务端还活着」基线。
        sender 卡死/sink 僵尸时 ping 与回显会同时断——前端据此判定连接无响应
        并重连，把「假活连接永久卡死」降级成一次秒级抖动（真机 2026-10-07）。"""
        while not self._closed:
            await asyncio.sleep(10)
            if self._closed:
                break
            self._emit_nowait(ServerMsg(type="ping"))
            await self._reap_zombie_ai()

    async def _reap_zombie_ai(self) -> None:
        """僵尸任务自愈：``_ai_task`` 存活却长时间零产出且 shell 空闲 → 回收。

        兜底缓解「底行提示符冻结」一类：任务卡在某个等不住的 await 上一直不
        归 None，``_curtain_close`` 便会在每次 prompt_start 重新关帘，shell 重绘的新
        提示符（cd 后就该变目录）永被幕帘扣住。回收走
        ``_maybe_cancel_ai`` → ``_ai_flow`` 的 finally 自动清 ``_ai_task``
        并开帘，提示符即刻恢复；同时放 status 知会前端/用户。"""
        t = self._ai_task
        if t is None or t.done():
            return
        if t.get_coro() is asyncio.current_task():
            return    # 自己不能收自己
        if time.monotonic() - self._ai_ping_at < _AI_ZOMBIE_T:
            return
        _dbg("ai zombie reap: ai_task 静默 >", _AI_ZOMBIE_T, "s")
        await self._maybe_cancel_ai()
        await self.emit_msg(ServerMsg(
            type="status",
            text="AI 任务长时间无响应，已自动停止；提示符已恢复。如需继续请重发。"))

    def _flush_offline(self) -> None:
        """补发断线期攒下的控制帧：插到 outbox 队头，保证先于重挂后新帧。

        全程无 await：drain + 回填在同一事件循环步内完成，不会与并发生产者
        交错乱序。"""
        if not self._offline:
            return
        buf, self._offline = self._offline, []
        pending = []
        while True:
            try:
                pending.append(self._outbox.get_nowait())
            except asyncio.QueueEmpty:
                break
        for item in buf:
            self._outbox.put_nowait(item)
        for item in pending:
            self._outbox.put_nowait(item)

    def detach(self, sink) -> None:
        if self._sink is sink:
            self._sink = None

    async def feed_input(self, data: bytes) -> None:
        """前端 → 核心键盘字节（CLI 输入泵 / web 二进制帧同一入口）。

        等价 ClientMsg(type="raw")；必须走 _inbox → _dispatch → _on_keys
        保持 web 既有顺序语义（直调 _on_keys 会插队到已排队的
        resize/mode/close 之前）。"""
        await self.feed_msg(ClientMsg(type="raw", data=data))

    async def feed_msg(self, msg: ClientMsg) -> None:
        """前端 → 核心结构化上行（原 web handle_client）。"""
        if msg.type == "decision" and msg.decision is not None:
            await self._decisions.put(msg.decision)
        elif msg.type == "auth":
            if msg.auth_kind == "password":
                await self._pws.put(msg.text)
                if msg.remember:
                    self._store_auth_password(msg.text)
            elif msg.auth_kind == "nested_password":
                # 嵌套 ssh/sudo 密码提示符的模态代答：打进 PTY 而非认证队列
                await self._on_nested_password(msg.text, msg.remember)
            elif msg.auth_kind == "nested_password_cancel":
                # 模态取消/点遮罩：用户改终端手输密码，立即退出验证窗口
                # （否则手输的密码被 hold 到 _PW_VERIFY_TIMEOUT 才放行）；
                # 已 hold 的抢跑输入不丢，仍等 auth 结果输出后依序释放
                self._end_pw_verify()
                self._pw_modal_open = False
            elif msg.auth_kind == "host_key":
                await self._hks.put(msg.text == "true")
            elif msg.auth_kind == "cmdset":
                # 命令集密码弹窗回填:只回填等待队列;存储由 runner 按
                # cmdset:<引用名> 键负责,不能走 _store_auth_password
                # (那会把内网机密码错存到目标主机键下)
                await self._pws.put(msg.text)
        elif msg.type == "cmdset_resume":
            # 前端「继续」按钮:命令集暂停等输入时强制放行
            self._cs_resume.set()
        elif msg.type == "interrupt":
            # ⏹/Ctrl+C：直接给 PTY 发 Ctrl+C（不经过 _inbox——命令执行期间
            # 消息会排队到命令结束才处理）；shell 空闲时顺带取消 AI 任务。
            if self._interactive:
                await self._maybe_cancel_ai()
            if self.session is not None:
                await self.session.send_raw(b"\x03")
        elif msg.type == "pad":
            # 卡片占位行：让 shell 打印 N 个空行（占位行必须在 shell 输出流
            # 里，ConPTY 的缓冲区模型才认账；前端自行 write 的行会被重绘覆盖）
            # 挂链式任务而**不 inline await**：泵还要收 boundary_settled（门闩
            # ack），堵在 pad 上会让门闩永远等不到 ack 走超时兜底；且超时后
            # 注入不排在 pad 之后 = 回显抢进未打完的空白区（真机 cover 根因）
            if self._interactive and self.session is not None:
                prev = self._pad_task

                async def _run_pad(p=prev, n=max(1, msg.pad), mr=msg.mirror):
                    if p is not None:
                        try:
                            await p
                        except Exception:
                            pass
                    await self._shell_pad(n, mr)

                self._pad_task = asyncio.create_task(_run_pad())
        elif msg.type == "boundary_settled":
            # 前端流底卡结账垫满：放行等待中的命令注入（见 _boundary_gate）
            self._boundary_ack.set()
        elif msg.type == "submit":
            # 外部触发链：前端拦截的自然语言整行（不再经 shell hook 分类，
            # su - 等 login shell 重置 hook 后依然可用）
            if self.session is not None and msg.text:
                await self._on_frontend_line(msg.text, msg.dirty)
        elif msg.type == "rescue":
            # 失败救援卡决策（accept = 交给 AI）
            await self._on_rescue_decision(msg.accept)
        else:
            await self._inbox.put(msg)

    async def _boundary_gate(self) -> None:
        """命令注入前等前端把流底分析卡结账垫满（backend.on_boundary 门闩）。

        回显字节一旦先于 pad 空行进入 PTY 流，卡的连续空白预留区就被打断、
        永久盖帽截断（真机分析卡末行被切）。旧序 ai_collapse 在 exec_start
        才发、回显早已进区；这里把结账提前到注入前：发 ai_boundary → 前端
        flush token 批 + settle 垫满 → 回 boundary_settled → 才放命令进去。
        超时/前端无活卡立即放行：命令响应速度优先于占位美观（同审批 600ms 兜底）。
        """
        self._boundary_ack.clear()
        await self.emit_msg(ServerMsg(
            type="event", event={"kind": "ai_boundary"}))
        try:
            await asyncio.wait_for(self._boundary_ack.wait(), 0.7)
        except asyncio.TimeoutError:
            pass
        # 服务端排序兜底：前端 ack 走超时兜底时（高延迟真机 pad 往返 >0.7s）
        # 在途 pad 可能还没打完——命令注入必须排在它后面，否则回显写进未打完
        # 的空白区、把连续预留区打断 = 永久盖帽（真机审批卡压回显根因）。
        # shield：门闩超时只放弃等，不能 cancel 掉 pad 任务本身。
        task = self._pad_task
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), 2.0)
            except asyncio.TimeoutError:
                pass

    async def _shell_pad(self, rows: int, mirror: str | None = None) -> None:
        """注入 ``__ot_pad N``：hook 打印 N 个空行并清掉自身回显。
        等提示符重画完成（空行已落终端缓冲）再应答前端挂卡。
        与 InteractiveRunner 注入共用 _runner_lock：两者都往 PTY 输入
        缓冲送 \x15…\r 注入序列，交错会污染彼此的半行收纳。
        单次注入限 50 行（hook 的 seq 上限），超高分块循环打满——
        总结卡可达上百行占位，截断会让卡片悬在缓冲区外盖住提示符。

        hook 在位时半行保护走 shell 侧存档/接回原语（^U 存 __ot_saved、^Y
        接回，空行零副作用，任务期打字与注入交错也能原样接回）。hook 不在位
        （su - 换壳探测失败等）直接 ack 返回：没有 __ot_pad 通道，旧降级往
        提示符敲 ``__ot_pad N`` 只会连环 command not found + 提示符连排，
        前置 \x15 还连环吞用户输入（真机「打字不显示」根因之一）。宁藏不盖：
        不垫空行，卡由显隐/夹紧逻辑兜底。"""
        async with self._runner_lock:
            if self._hook_ok():
                self._hook_seen = True
            elif (self._hook_seen and
                    time.monotonic() - self._pad_reinject_at > 60):
                # hook 中途掉线（su -/exec/脚本重置 PROMPT_COMMAND）时 pad 会
                # 秒应答零空行＝卡出生即夹紧截断（真机「总结卡底部被切」）。
                # 任务起手已补注入一次，这里做 60s 节流的兜底重试：能救回就
                # 照正常路径垫行，救不回再走宁藏不盖的降级。_hook_seen 门卫：
                # 从未在位＝结构上不可集成（非掉线），不空转注入
                self._pad_reinject_at = time.monotonic()
                try:
                    # 已持 _runner_lock：走无锁实现（经 _ensure_integrated
                    # 取锁会重入死锁）
                    await self._ensure_integrated_locked()
                except Exception:  # noqa: BLE001 - 补注入失败不碍降级
                    pass
                if self._hook_ok():
                    self._hook_seen = True
            if not self._hook_ok():
                await self.emit_msg(ServerMsg(
                    type="event", event={"kind": "padded", "rows": rows}))
                return
            remaining = max(1, rows)
            first = True
            hook = self._hook_ok()
            while remaining > 0:
                n = min(50, remaining)
                remaining -= n
                self._ev_prompt.clear()
                if hook or mirror is None or (first and mirror):
                    await self.session.send_raw(b"\x15")   # 收纳用户半行输入
                # mirror == ""（hook 不在位）：半行为空，不收纳（\x15 会误杀
                # 历史召回等残影）
                await self.session.send_raw(f"__ot_pad {n}\r".encode())
                if hook:
                    # 接回存档半行：shell 侧 ^Y 原语（存档非空才接回）
                    await self.session.send_raw(b"\x19")
                first = False
                # hook 不在位时不补 \x19（原生 yank 会把 kill ring 里刚提交
                # 的自然语言行复活回提示符行，此后每块 pad 再 kill 再 yank，
                # 死循环挂在输入行上——降级走 mirror 原样重打）
                try:
                    await asyncio.wait_for(self._ev_prompt.wait(),
                                           self._pad_prompt_timeout)
                except asyncio.TimeoutError:
                    pass
            if not hook and mirror:
                # 复原收纳的半行：等价用户原样敲入（不发 \r，不触发执行）
                await self.session.send_raw(mirror.encode())
        await self.emit_msg(ServerMsg(
            type="event", event={"kind": "padded", "rows": rows}))

    def _reinject_inst_base(self) -> int:
        """换壳重注入的实例号基址：每次重注入分配一个新的大号段。

        嵌套 shell（su - / ssh 跳板机）里的 hook 实例号从基址起算，与外层
        会话的帧号空间完全隔离——外层 hook 的用户命令帧（如第一条 `ssh
        跳板机` = inst 1）在嵌套会话存续期间始终开着，若嵌套 hook 也从 1
        起算，首个工具命令的 C/D 标记就会撞掉外层帧（误触救援、_hook_gone
        提前复位）。setup 连接注入仍从 1 起（彼时无任何帧，计数器即本会话）。"""
        self._reinject_seq = getattr(self, "_reinject_seq", 0) + 1
        return 100000 * self._reinject_seq

    # --- 嵌套密码提示符（ssh/sudo 前台讨密码）---

    def _detect_password_prompt(self, data: bytes) -> None:
        """在输出滚动尾窗上做密码提示符检测（每 pump 块一次）。

        触发条件足够收敛，避免命令输出里的字面 "password:" 误触：
        ① 尾窗**结尾**（±4 字符容差）命中 _PASSWORD_PROMPT_RE——讨密码时
        提示符就是屏幕上最后的东西；提示符被后续输出冲走即重新武装；
        ② 当前最内层未闭合的用户命令帧是 ssh/sudo/scp/rsync 类（
        _needs_password_prompt）——grep 密码文件等输出再像也不触发。
        上升沿触发一次应答：优先凭据库自动填充（每条命令只试一次），
        失败或无凭据弹 ask_password 模态。结尾判定取**最后一个**匹配：
        首次应答后旧提示符仍躺在尾窗里，search 首匹配会让 at_end 恒 False
        ——ssh 输错重讨（deny+prompt 常被隧道合包成一块）时上升沿永不复现、
        模态不再弹（真机根因）。模态在屏等应答期间尾窗不再以提示符结尾
        （提示符被终端手输消费）时防抖代关陈旧模态（_pw_dismiss_release）。"""
        self._pw_tail.extend(data)
        if len(self._pw_tail) > 4096:
            del self._pw_tail[:-2048]
        tail = bytes(self._pw_tail)
        last = None
        for m in _PASSWORD_PROMPT_RE.finditer(tail):
            last = m
        at_end = last is not None and last.end() >= len(tail) - 4
        self._pw_at_end = at_end
        if self._pw_modal_open:
            if at_end:
                self._cancel_pw_dismiss()   # 重讨：模态仍有用，保住
            else:
                self._schedule_pw_dismiss()
        if self._pw_hold:
            if at_end:
                self._cancel_pw_hold_release()   # 重新讨密码：继续 hold
            else:
                self._schedule_pw_hold_release()
        if self._pw_verifying and (
                not at_end
                or time.monotonic() - self._pw_verify_at > _PW_VERIFY_TIMEOUT):
            self._end_pw_verify()   # auth 结果已出（或超时）：不再 hold 新输入
            if not at_end and self._innermost_ssh_frame() is not None:
                # 嵌套 ssh 登录成功：后台主动注入 hook——首条自然语言到达时
                # hook 已在位走健康路径，免当场探测+分片注入的秒级代价
                asyncio.get_running_loop().create_task(self._proactive_reinject())
        if not at_end:
            self._pw_prompt_seen = False
            return
        if self._pw_prompt_seen or self.session is None:
            return
        if not self._pw_armed():
            return
        self._pw_prompt_seen = True
        asyncio.get_running_loop().create_task(self._on_nested_password_prompt())

    # --- 验证窗口输入 hold 与释放 ---

    def _begin_pw_verify(self) -> None:
        """密码打进 PTY：进入验证窗口（_on_keys/_on_frontend_line 开始 hold）。

        同时复位 _pw_prompt_seen：本提示符已应答，ssh 重讨时上升沿必须复现
        模态（否则 deny+prompt 合包到达时会被 seen 闸挡住）。"""
        self._pw_prompt_seen = False
        self._pw_verifying = True
        self._pw_verify_at = time.monotonic()
        self._schedule_pw_verify_expiry()

    def _end_pw_verify(self) -> None:
        """退出验证窗口并撤销强制到期定时器。"""
        self._pw_verifying = False
        t = getattr(self, "_pw_verify_timer", None)
        if t is not None:
            t.cancel()
            self._pw_verify_timer = None

    def _schedule_pw_verify_expiry(self) -> None:
        t = getattr(self, "_pw_verify_timer", None)
        if t is not None:
            t.cancel()
        self._pw_verify_timer = asyncio.get_running_loop().create_task(
            self._pw_verify_expiry())

    async def _pw_verify_expiry(self) -> None:
        """验证窗口强制到期：输出驱动的超时判定在 shell 无输出时永远跑不到
        （_detect_password_prompt 只在 pump 收到字节时被调用），验证窗口就此
        永久开启、前端输入被永久 hold（真机「终端命令行无法输入任何文字」）。
        这里用独立定时器兜底：到点即放行，已 hold 的输入依序释放。"""
        try:
            await asyncio.sleep(_PW_VERIFY_TIMEOUT)
        except asyncio.CancelledError:
            raise
        finally:
            self._pw_verify_timer = None
        if not self._pw_verifying:
            return
        self._pw_verifying = False
        _dbg("pw verify expiry -> release hold", len(self._pw_hold))
        if self._pw_hold:
            self._schedule_pw_hold_release()

    def _schedule_pw_hold_release(self) -> None:
        if self._pw_hold_timer is None:
            self._pw_hold_timer = asyncio.get_running_loop().create_task(
                self._pw_hold_release())

    def _cancel_pw_hold_release(self) -> None:
        if self._pw_hold_timer is not None:
            self._pw_hold_timer.cancel()
            self._pw_hold_timer = None

    async def _pw_hold_release(self) -> None:
        """hold 释放防抖：不以提示符结尾的 auth 结果输出（登录成功 / ssh 退出）
        稍等才释放——隧道合包可能把 deny 与重讨提示符拆成两块到达，即放会
        把抢跑命令打进新密码位。"""
        try:
            await asyncio.sleep(_PW_HOLD_RELEASE)
        except asyncio.CancelledError:
            raise
        finally:
            self._pw_hold_timer = None
        if not self._pw_hold or self._pw_at_end:
            return
        await self._flush_pw_hold()

    async def _flush_pw_hold(self) -> None:
        """验证结束：按原序释放 hold 的输入——抢跑命令落在登录后的 shell 上
        （用户预期「连接后命令」）；自然语言行按「尚未键入」重走 submit 链
        （字符当时被 hold，不在 shell buffer 里）。"""
        hold, self._pw_hold = self._pw_hold, []
        for item in hold:
            if self.session is None:
                return
            if item[0] == "raw":
                await self.session.send_raw(item[1])
            else:
                await self._on_frontend_line(item[1], item[2], typed=False)

    # --- 陈旧密码模态代关 ---

    def _schedule_pw_dismiss(self) -> None:
        if self._pw_dismiss_timer is None:
            self._pw_dismiss_timer = asyncio.get_running_loop().create_task(
                self._pw_dismiss_release())

    def _cancel_pw_dismiss(self) -> None:
        if self._pw_dismiss_timer is not None:
            self._pw_dismiss_timer.cancel()
            self._pw_dismiss_timer = None

    async def _pw_dismiss_release(self) -> None:
        """模态代关防抖：密码提示符被终端手输消费（登录横幅/目标提示符把提示
        符冲出尾窗结尾）时模态没有自己的关闭路径——不代关则用户登录成功后
        仍面对讨密码的陈旧模态（真机：ssh 早已成功、模态悬在 root 提示符上）。
        防抖一拍：期间重讨（at_end 回 True）取消代关、模态继续等应答。"""
        try:
            await asyncio.sleep(_PW_MODAL_DISMISS)
        except asyncio.CancelledError:
            raise
        finally:
            self._pw_dismiss_timer = None
        if not self._pw_modal_open or self._pw_at_end or self._closed:
            return
        self._pw_modal_open = False
        await self.emit_msg(ServerMsg(type="ask_password_dismiss"))

    # --- \x03 后 ^C 回显吞除（降级重注入的视觉残迹）---

    def _arm_intr_swallow(self) -> None:
        self._intr_swallow_until = time.monotonic() + 1.0
        self._intr_pending = b""

    def _strip_intr_echo(self, data: bytes) -> bytes:
        """吞掉自动 \x03 后 readline 回显的 "^C" 两字节（真机 bash 讨中断时
        在用户已回显的半行尾补打 ^C——用户视角的「奇怪符号+c」）。

        只吞这两字节：随后的 \r\n 与提示符重画照常透传，光标被 \r\n 重新
        锚定，无失步。"^" 可跨块到达：悬置到下一块，非 C 开头或窗口过期
        时原样放回（不丢用户内容的字面 ^）。"""
        now = time.monotonic()
        if now >= self._intr_swallow_until:
            self._intr_swallow_until = 0.0
            pending, self._intr_pending = self._intr_pending, b""
            return pending + data
        if self._intr_pending:
            self._intr_pending = b""
            if data[:1] == b"C":
                self._intr_swallow_until = 0.0
                data = data[1:]
            else:
                return b"^" + data   # ^ 后面不是 C：非回显，原样放回
        idx = data.find(b"^C")
        if idx != -1:
            self._intr_swallow_until = 0.0
            return data[:idx] + data[idx + 2:]
        if data.endswith(b"^"):
            self._intr_pending = b"^"
            return data[:-1]
        return data

    def _pw_prompt_host(self) -> tuple[str | None, str | None]:
        """从尾窗的密码提示符行里提取 OpenSSH 自带的 user@host。

        OpenSSH 两种提示格式：``(user@host) Password:``（新版）与
        ``user@host's password:``（旧版）。提示符自带主机 = 凭据归属的
        最强凭据（sudo 在嵌套会话内讨密码时不会错用外层 ssh 主机的
        凭据）；无主机信息返回 (None, None)。"""
        m = re.search(
            rb"\(([^()\r\n@]+)@([^()\r\n@]+)\)\s*password"
            rb"|([^\s@)\r\n]+)@([^\s@)\r\n']+)'s password",
            bytes(self._pw_tail), re.IGNORECASE)
        if m is None:
            return None, None
        user = (m.group(1) or m.group(3) or b"").decode("utf-8", "replace")
        host = (m.group(2) or m.group(4) or b"").decode("utf-8", "replace")
        return (host or None), (user or None)

    def _pw_armed(self) -> bool:
        """最内层未闭合用户命令是否 ssh/sudo 类（提示符检测的触发门槛）。"""
        for frame in reversed(self._exec_stack):
            line = frame.get("line") or ""
            if line and not is_internal_line(line):
                return _needs_password_prompt(line)
        for line in reversed(list(self._open_cmds.values())):
            return _needs_password_prompt(line)
        return False

    def _innermost_ssh_frame(self) -> int | None:
        """最内层未闭合用户帧若是 ssh 类返回其 inst（嵌套会话存续判定）。"""
        if not self._open_cmds:
            return None
        inst = next(reversed(self._open_cmds))
        line = (self._open_cmds[inst] or "").strip()
        if not line or is_internal_line(line):
            return None
        if os.path.basename(line.split()[0]) not in ("ssh", "scp", "rsync", "sftp"):
            return None
        return inst

    def _inner_ssh_prompt_live(self) -> bool:
        """最内层未闭合用户帧是 ssh 类且开帧后出现过提示符标记（= 内层 hook
        活在 readline 提示符上）：嵌套会话的自然语言放行健康路径。

        _open_cmds 门闩本防 \\r 落进前台命令 stdin（su - 整段会话），但 ssh
        跳板机帧同样整段开着——一刀切会让嵌套会话里每次自然语言都走降级
        （\\x03 + 0.4s + 探测 + 分片重注入，秒级，真机「等几秒才出分析卡」
        根因之一）。su - 帧非 ssh 族仍锁；内层前台命令（top/mysql）会开自己
        的帧，最内层非 ssh 族亦仍锁；外族 PS1 假标记只随 su - 出现，进不来。"""
        inst = self._innermost_ssh_frame()
        if inst is None:
            return False
        return self._last_mark_at > self._open_cmd_at.get(inst, 0.0) + 0.05

    def _nested_ssh_target(self) -> tuple[str | None, str | None, int | None]:
        """从**最内层**未闭合用户命令行解析 ssh 类命令的目标 (host, user, port)。

        只认最内层帧：嵌套会话里外层 `ssh 跳板机` 帧始终开着，若它兜底
        吸收了内层 sudo 的密码提示，就会把跳板机的凭据错填给 sudo。
        解析不出（sudo、ssh 目标是别名走 ~/.ssh/config 等）返回 (None,...)
        ——密码仍可弹窗代答，只是「记住」没有可靠的键。"""
        import shlex

        for line in reversed(list(self._open_cmds.values())):
            try:
                parts = shlex.split(line)
            except ValueError:
                parts = line.split()
            if not parts:
                continue
            cmd = os.path.basename(parts[0])
            if cmd not in ("ssh", "scp", "rsync", "sftp"):
                return None, None, None   # 最内层不是 ssh 类：不解析
            val_opts = {"b", "c", "D", "e", "F", "i", "J", "l", "L", "m",
                        "o", "p", "P", "R", "S", "W"}
            argv = parts[1:]
            host = user = None
            port = None
            i = 0
            dest = None
            bare_args: list[str] = []
            while i < len(argv):
                a = argv[i]
                if a == "--":
                    i += 1
                    if i < len(argv):
                        bare_args.append(argv[i])
                    break
                if a.startswith("-") and len(a) > 1:
                    if a[1] in val_opts and len(a) == 2:
                        i += 2   # 带值短选项：连值一起跳过
                    else:
                        i += 1   # 无值开关（-t/-A/-4…）或合写带值（-oVal）
                    continue
                bare_args.append(a)
                i += 1
            if cmd in ("scp", "rsync"):
                # 源/目的都可能带远端路径：挑带 @ 的（user@host:path），
                # 其次带 : 的（host:path）；纯本地路径跳过
                remote = [a for a in bare_args if "@" in a] or \
                    [a for a in bare_args if ":" in a]
                dest = remote[0] if remote else None
            else:
                dest = bare_args[0] if bare_args else None
            if dest is None:
                continue
            if cmd in ("scp", "rsync") and ":" in dest:
                dest = dest.rsplit(":", 1)[0]   # 去掉远端路径
            host, user, port = parse_user_at_host(dest)
            if port is None:
                # ssh -p/--port 端口在选项里
                for j, a in enumerate(argv):
                    if a == "-p" and j + 1 < len(argv) and argv[j + 1].isdigit():
                        port = int(argv[j + 1])
                    elif a.startswith("--port=") and a[7:].isdigit():
                        port = int(a[7:])
                    elif a == "-P" and j + 1 < len(argv) and argv[j + 1].isdigit():
                        port = int(argv[j + 1])
            if host:
                return host, user, port
        return None, None, None

    @staticmethod
    def _load_nested_password(host: str, user: str | None,
                              port: int | None) -> str | None:
        """嵌套凭据读取：无端口与 ssh 默认端口 22 视同同一键。

        凭据键 display_name 在端口非空时附 :port——记住的连接档案流按
        target.port=22 存 ``user@host:22``，嵌套 ssh 命令无 -p 解析出
        port=None 查 ``user@host``：同一密码两个键、自动填充永远 miss
        （真机：档案登录成功过、嵌套 ssh 仍弹窗重讨）。两键互为别名，
        已落在任一键下的旧条目都读得到。"""
        pw = load_password(host, user, port)
        if pw is not None or port not in (None, 22):
            return pw
        return load_password(host, user, 22 if port is None else None)

    async def _on_nested_password_prompt(self) -> None:
        """密码提示符上升沿：自动填充或弹窗。

        凭据键优先取提示符自带的 user@host（_pw_prompt_host，归属最强）；
        提示符无主机信息时回退最内层 ssh 帧解析（_nested_ssh_target）。
        自动填充每条命令只试一次：密码错误时 ssh 会重新讨，第二次起一律
        弹窗，避免凭据过期时连环静默失败。"""
        if self._closed or self.session is None:
            return
        attempt = self._nested_pw_attempts
        self._nested_pw_attempts += 1
        host, user, port = (None, None, None)
        phost, puser = self._pw_prompt_host()
        if phost is not None:
            host, user = phost, puser
            thost, tuser, tport = self._nested_ssh_target()
            if thost == host:   # 提示符主机与命令一致：补全端口
                port, user = tport, (tuser or user)
        else:
            host, user, port = self._nested_ssh_target()
        self._nested_pw_ctx = (host, user, port)
        if host is not None and attempt == 0:
            pw = self._load_nested_password(host, user, port)
            if pw:
                await self.session.send_raw(pw.encode() + b"\r")
                self._begin_pw_verify()
                await self.emit_msg(ServerMsg(
                    type="status",
                    text=f"已用记住的密码自动填充 {user + '@' if user else ''}"
                         f"{host}"))
                return
        label = f"{user + '@' if user else ''}{host or ''} 密码: " \
            if host else "密码: "
        self._pw_modal_open = True
        await self.emit_msg(ServerMsg(type="ask_password", label=label,
                                      auth_kind="nested_password"))

    async def _on_nested_password(self, pw: str, remember: bool) -> None:
        """模态提交的嵌套密码：整行打进 PTY（远端 echo 关闭，不回显）。"""
        self._pw_modal_open = False
        self._cancel_pw_dismiss()
        if self.session is not None and pw:
            await self.session.send_raw(pw.encode() + b"\r")
            self._begin_pw_verify()
        if remember:
            host, user, port = self._nested_pw_ctx or (None, None, None)
            if host is not None:
                try:
                    store_password(host, user, port, pw)
                except Exception:
                    pass    # 凭据库缺席不阻断本次登录

    async def _proactive_reinject(self) -> None:
        """嵌套 ssh 登录成功后后台补注入：把首条自然语言的探测+分片注入成本
        摊进登录后的空闲期（真机「等几秒才出分析卡」根因之一）。幂等：已在
        位的 hook 只重定义同名函数；与 submit 降级路径并发时由 _runner_lock
        串行。失败静默——首条 submit 仍会走降级自愈。

        空闲门闩：_ensure_integrated 前置 \\x15 会收纳半行——用户登录后已在
        目标提示符敲字时主动注入会销毁其输入。settle 后确认无 live 字节
        （readline 回显 = 半行在场的凭据）才动手。"""
        if not self._interactive or self.session is None or self._closed:
            return
        await asyncio.sleep(0.6)
        if time.monotonic() - self._last_live_at < 0.4:
            return   # 目标提示符上有回显（用户敲字中）：放弃主动注入
        try:
            await self._ensure_integrated()
        except Exception:  # noqa: BLE001 - 主动注入失败不阻断，submit 降级自愈
            pass

    async def _ensure_integrated(self) -> bool:
        """su - / sudo su - 等 login shell 会重置 PROMPT_COMMAND、函数与 Enter
        绑定，丢掉 OSC 133:D 提示符标记与 __ot_exec__/__ot_pad 通道，导致自然语言
        任务挂起。任务启动前重发分片注入脚本：幂等（healthy shell 只重定义同名函数/
        重设同款提示符，无副作用；su - 后则恢复全部集成）。回显经 _suppress_live 吞掉，
        等 OSC:D 提示符标记确认注入落地。

        注入前先探测提示符后面的真实 shell 族（su - 换壳）：外层会话的
        _shell_kind 是连接时探测的（如 zsh），而 macOS root = /bin/sh =
        bash 3.2——把 zsh 脚本打进 bash 定义不出任何函数，且 zsh 版 PS1 在
        bash 里照样发 OSC 133 标记，_hook_ok 由此假阳性（真机 su - 后
        __ot_pad 连环 command not found、自然语言整行被 root shell 当命令
        执行、\x15 连环吞输入）。探测不到可集成 shell 时置 _hook_gone 转
        降级，本次任务外部启动。"""
        if not self._interactive or self.session is None:
            return False
        async with self._runner_lock:
            return await self._ensure_integrated_locked()

    async def _ensure_integrated_locked(self) -> bool:
        """重注入本体：调用方必须已持有 _runner_lock。

        拆出来是因为 InteractiveRunner.run（P0-1 门禁）与 _shell_pad 的 60s
        兜底补注入自己就持着这把锁，再经 _ensure_integrated 取一次就是重入
        死锁（asyncio.Lock 不可重入）——旧代码 _shell_pad 那条路径正踩着。
        """
        self._ev_prompt.clear()
        self._suppress_live = True
        try:
            # 前置 \x15 收纳半行但不补 \x19 恢复：任务启动即丢弃该半行
            #（若 yank 回 kill ring 里的旧文本，会在提示符行复活污染输入）。
            # 探测行必须敲在干净提示符上——半行没清，探测行会拼在用户
            # 已敲文本后面整行执行。
            await self.session.send_raw(b"\x15")
            if self._shell_kind != "powershell":
                # 静默窗口先行：hook 不在位（su - 换壳）时探测行/分片行
                # 靠前导空格 + ignorespace 原生跳过入史；hook 在位时本行
                # 被 widget 按内部行（__ot_hc= 前缀）静默处理
                await self.session.send_raw(history_quiet_line())
            shell, flag = await self._probe_shell_kind()
            if shell is None:
                if not self._hook_gone and not self._hook_stale:
                    # 首次判定不可集成：明确告知前端，别让每个任务静默失败。
                    # _hook_stale（壳已自行退出）时不发：根因已由
                    # _note_shell_dead 报过，再发一句「bash 3.2 / 前台占用」
                    # 是互相打架的误导
                    await self.emit_msg(ServerMsg(
                        type="status",
                        text="当前 shell 无法集成（bash 3.2 等旧壳 / 前台占用），"
                             "AI 工具执行不可用；请换可集成的 shell 后重试"))
                self._hook_gone = True
                return False
            self._hook_gone = False
            self._hook_stale = False   # 重注入落地：陈旧判定作废
            self._cancel_hook_watch()
            if shell != self._shell_kind:
                self._shell_kind = shell
                self._b64flag = flag
            for _ci, line in enumerate(
                    injection_lines(self._shell_kind,
                                    self._reinject_inst_base(),
                                    self._b64flag)):
                self._ev_stream.clear()
                await self.session.send_raw(line)
                # 逐片等本片回显到达再发下一片：固定短间隔会让分片堆进
                # shell 执行间隙的 canonical 缓冲（4096 溢出丢块，真机实测
                # 0.03s 间隔 md5 不复现）。回显即 readline 已读入本片的凭据；
                # 回显绝迹（裸模式残影）时退回实测安全的 0.12s 间隔。
                # 嵌套 ssh 隧道（跳板机）里 ZLE 对赋值行不回显——回显等待
                # 总是超时、分片全速连发被 ssh 通道合并成大包，远端 pty
                # 输入队列溢出**静默丢字节**，恰好丢掉末行 eval → 注入整链
                # 无声失败。因此无条件再垫 0.04s 最小间隔，保证远端逐片
                # 消化、批次不合并。
                try:
                    await asyncio.wait_for(self._ev_stream.wait(), 0.12)
                except asyncio.TimeoutError:
                    pass
                await asyncio.sleep(0.04)
            try:
                await asyncio.wait_for(self._ev_prompt.wait(), 2.0)
                # zsh POSTEDIT 重绘可能落在 A 标记之后：抑制窗口多留 80ms
                # 把它一并吞掉，否则每任务注入的重绘行泄漏进主屏（§5.5）
                await asyncio.sleep(0.08)
                return True
            except asyncio.TimeoutError:
                return False
        finally:
            self._suppress_live = False
            self._suppressed_echo = False

    async def _probe_shell_kind(self) -> tuple[str | None, str]:
        """在当前提示符敲一行能力探测，识别 su - / 嵌套 shell 后的真实 shell 族。

        复用 probe_command + parse_probe（bash>=4 门槛与 base64 参数判定与
        连接时探测同一套）；行首加 ``_ot_inj=`` 前缀使 is_internal_line 成立
        ——hook 恰好在位时该行按内部行静默记账，不入历史、不占用户命令帧；
        再加一个前导空格——hook 不在位时靠 _ensure_integrated 先发的静默行
        （ignorespace/hist_ignore_space）原生跳过入史。
        输出经 _probe_buf 收集（_on_stream_event 的 live/exec 分支塞入），
        回显与输出由调用方持有的 _suppress_live 窗口吞掉，不外显。

        返回 (shell|None, b64flag)：超时 / 无标记（前台占用吃掉探测行、
        其他 shell 族、bash 3.2）→ (None, "-d")。Windows 无 su - 语义，
        维持连接时探测的原判。"""
        if self.session is None:
            return None, "-d"
        if self.profile is not None and self.profile.os_family == "windows":
            return self._shell_kind, self._b64flag
        self._probe_buf = bytearray()
        try:
            await self.session.send_raw(
                (' _ot_inj=""; ' + probe_command(self.profile.os_family)
                 ).encode() + b"\r")
            deadline = time.monotonic() + _PROBE_TIMEOUT
            while time.monotonic() < deadline:
                shell, flag = parse_probe(
                    self._probe_buf.decode("utf-8", "replace"))
                if shell is not None:
                    return shell, flag
                await asyncio.sleep(0.05)
            return None, "-d"
        finally:
            self._probe_buf = None

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._curtain = False   # 关闭即弃：扣留的提示符字节随会话消失
        self._curtain_parts = []
        if self._ai_task is not None:
            self._ai_queue.clear()
            self._ai_task.cancel()
        if self._cs_task is not None:
            self._cs_task.cancel()
        # 密码 hold/验证窗口的定时器一并撤掉：不然会话关了它们还空转到点
        self._cancel_pw_hold_release()
        self._cancel_hook_watch()
        t = getattr(self, "_pw_verify_timer", None)
        if t is not None:
            t.cancel()
            self._pw_verify_timer = None
        # 解阻塞挂起的认证/审批等待（ask_* 收到 None 视为已关闭）
        for q in (self._pws, self._hks, self._decisions):
            q.put_nowait(None)
        # 先等泵真正退出再关 session：只 cancel 不等的话，泵可能正压在
        # _read_some 上，fd 被关掉后抛 ValueError 成为未取回异常
        await self._stop_pump()
        if self.session is not None:
            await self.session.close()
        await self.emit_msg(ServerMsg(type="closed", text="已关闭"))
        self._closed_sent = True   # 排空 backlog 后 sender 才允许退出
        # 唤醒 _run 的 inbox 等待（若 close 来自外部调用）；dispatch 到 close 幂等返回
        self._inbox.put_nowait(ClientMsg(type="close"))
        # _run/_sender 各自在 _closed 后自然退出（见 _run / _sender_loop），
        # 不 cancel 当前任务——close 常在 _run 内部被调用，cancel 会打断自己

    # --- 认证回调（供 SshPtySession 注入）---
    async def ask_password(self, label: str, auth_kind: str = "") -> str:
        await self.emit_msg(ServerMsg(
            type="ask_password", label=label, auth_kind=auth_kind))
        val = await self._pws.get()
        if val is None:
            raise ConnectionError("连接已关闭")
        return val

    async def ask_host_key(self, message: str) -> bool:
        await self.emit_msg(ServerMsg(type="ask_host_key", message=message))
        val = await self._hks.get()
        if val is None:
            raise ConnectionError("连接已关闭")
        return val

    def _store_auth_password(self, password: str) -> None:
        """认证弹窗勾选「记住」→ 密码写入 keyring（与重连时 load_password 同一键）。"""
        target = self.cfg.targets.get(self.target_name, self.cfg.targets["default"])
        if target.mode != "ssh" or not target.host:
            return
        try:
            store_password(target.host, target.user, target.port, password)
        except Exception:
            # 记住失败不阻断本次连接（密码已进 _pws 继续认证）
            pass

    # 审批理由中属「无害」的白名单：仅命中这些 → normal（蓝框），其余高危（红框）
    _BENIGN_APPROVE_REASONS = frozenset({"重定向覆盖文件", "用户 approve_extra 规则"})

    def _approval_risk(self, command: str) -> str:
        """审批风险级：删除/提权/写改/无法判定等 → high；仅无害理由 → normal。"""
        reasons = set(self.policy.classify(command).reasons)
        return "normal" if reasons and reasons <= self._BENIGN_APPROVE_REASONS else "high"

    async def ask_approval(self, command: str, reasons: str, host: str,
                           risk: str = "high") -> dict:
        msg = ServerMsg(
            type="approval", command=command, reasons=reasons, host=host,
            risk=risk)
        self._pending_approval = msg
        try:
            await self.emit_msg(msg)
            val = await self._decisions.get()
        finally:
            self._pending_approval = None
        if val is None:
            raise ConnectionError("连接已关闭")
        return val

    # --- 前端抽象出口：子类覆写（web=TabWorker 进 outbox；CLI=CliCore 进渲染队列）---
    async def emit_msg(self, msg: "ServerMsg") -> None:
        raise NotImplementedError

    async def emit_bytes(self, data: bytes) -> None:
        raise NotImplementedError

    def _emit_nowait(self, msg: "ServerMsg") -> None:
        raise NotImplementedError

    # --- 输出：全部经 outbox 串行（保持顺序）---
    def _buffer_offline(self, kind, payload) -> None:
        """断线隙的 JSON 控制帧攒住等重挂补发。

        字节帧丢——重放会与前端已有缓冲重复画屏。控制帧（final/审批收尾/
        closed…）丢了前端就永远收不到收束，真机表现为「AI 正在思考」不收。"""
        if kind == "bytes":
            return
        self._offline.append((kind, payload))
        if len(self._offline) > _OFFLINE_CAP:
            del self._offline[:-_OFFLINE_CAP]

    async def _sender_loop(self) -> None:
        while True:
            kind, payload = await self._outbox.get()
            sink = self._sink
            if sink is None:
                self._buffer_offline(kind, payload)
            else:
                try:
                    if kind == "bytes":
                        await sink.send_bytes(payload)
                    else:
                        await sink.send_text(payload)
                except Exception:
                    # sink 已死但 detach 尚未回来（网络刚断的那几毫秒）：帧必须
                    # 攒住，否则断线瞬间发出的收束帧就永久丢了（旧实现 continue
                    # 直接丢弃）。顺手摘掉死 sink，后续帧不再逐条撞异常。
                    if self._sink is sink:
                        self._sink = None
                    self._buffer_offline(kind, payload)
            # 关闭后把剩余消息发完（含 closed）再退出，避免协程泄漏。
            # 只看 _closed 不够：close 会先置 _closed 再入队 closed，若此刻
            # backlog 未排空，sender 会在 closed 入队前按 empty 提前退出
            if self._closed and self._closed_sent and self._outbox.empty():
                break

    # --- 主流程 ---
    async def _run(self) -> None:
        try:
            await self._connect()
        except Exception as e:  # noqa: BLE001 - 连接失败通知前端
            await self.emit_msg(ServerMsg(
                type="closed", text=f"连接失败：{type(e).__name__}: {e}"))
            self._closed = True  # sender 据此排空后退出，避免协程泄漏
            self._closed_sent = True
            return
        self.connected.set()
        await self.emit_msg(ServerMsg(
            type="ready", tab_id=self.tab_id,
            host=self._target_host, user=self._target_user,
            distro=self.profile.distro or "",
            prompt=self._cur_prompt,
            model=self._model.model, models=self._models,
            interactive=1 if self._interactive else 0))
        if self._interactive:
            hint = ("shell 集成已就绪：按键直达终端（Tab 补全 / ↑ 历史 / Ctrl+R 搜索"
                    "原生可用）；命令直接执行，自然语言交给 AI；? 前缀强制 AI，"
                    "! 前缀强制执行命令。")
        else:
            hint = "纯终端直通（未检测到可集成的 shell）：按键直达终端。"
        await self.emit_msg(ServerMsg(
            type="status",
            text=f"已连接 {self._target_host}"
                 f"（{self.profile.distro or self.profile.os_family}）。{hint}"))
        self._pump = asyncio.create_task(self._pump_guard())
        if self._interactive:
            # 注入期的提示符字节被 setup 消化掉了：Ctrl+L 让 shell 重画提示符
            #（ready 已先入 outbox，顺序有保证）
            await self.session.send_raw(b"\x0c")
        if self._target is not None and self._target.commands:
            self._spawn_cmdset()
        while not self._closed:
            msg = await self._inbox.get()
            try:
                await self._dispatch(msg)
            except Exception as e:  # noqa: BLE001 - 单条消息出错不能让 tab 变僵尸
                await self.emit_msg(ServerMsg(
                    type="status", text=f"处理出错：{type(e).__name__}: {e}"))

    async def _connect(self) -> None:
        target = self.cfg.targets.get(self.target_name, self.cfg.targets["default"])
        self._target = target
        host = target.host or ("local" if target.mode == "local" else target.name)
        self._target_host = host
        stored_pw = (load_password(target.host, target.user, target.port)
                     if target.mode == "ssh" and target.host else None)
        self.session = await open_session(
            target,
            password=stored_pw,
            default_timeout=self.cfg.shell.timeout_default,
            max_output_bytes=self.cfg.shell.max_output_bytes,
            password_prompt=self.ask_password,
            host_key_prompt=self.ask_host_key,
        )
        # 断线自动重连成功后把历史命令重新灌进新 shell（裸 shell 阶段，
        # 回调内不可走 run()——彼时 _runner_lock 被恢复流程持有）
        self.session.on_reconnect = self._on_session_reconnect
        # 阶段上报：建连（PTY/SSH+shell 启动）已完成，进入 agent 初始化
        # （shell 能力探测 + 集成脚本注入，秒级），前端浮层据此换文案
        await self.emit_msg(ServerMsg(
            type="stage", text="agent_init"))
        self._install_curtain_gate()
        # 画像选择与 CLI switch_target 一致：local 不跑探针（POSIX 探针语句
        # 在 PowerShell 下无哨兵输出，run 会挂满超时 → ready 永不到达）
        if target.mode == "local":
            self.profile = replace(LOCAL_PROFILE, host=host)
        else:
            cache = load_host_cache(app_dir() / "hosts.toml")
            if host in cache:
                self.profile = replace(cache[host], host=host)
            else:
                self.profile = await probe_profile(self.session, host)
                save_host_cache(app_dir() / "hosts.toml", host, self.profile)
        if target.mode == "local":
            self._target_user = getpass.getuser()
        else:
            self._target_user = (target.user
                                 or getattr(self.session, "username", None)
                                 or "")
        await self._setup_interactive()
        # Agent（deepagents/langchain/anthropic 栈）不在建连期构建——延迟到
        # 首个 AI 任务的 _ensure_agent()。这样 `ot list`/`ot connect`/纯 shell
        # 使用完全不付 ~4s 的 AI 栈导入与建图成本（启动瓶颈实测在 deepagents）。

    def _agent_session(self):
        """agent 工具执行用的会话：交互式 = InteractiveRunner（同 PTY 注入），
        否则原始 session（哨兵批处理，仅记账，无 AI 输入通道）。"""
        return self._runner if self._interactive else self.session

    def _build_agent_now(self) -> None:
        """立即构建/重建 agent。AI 栈经 _load_agent_stack 惰性载入模块级名字
        （deepagents/langchain 约 4s 导入由此与启动路径解耦）；测试 monkeypatch
        的 build_agent 桩在此生效（非 None 即跳过真导入）。"""
        _load_agent_stack()
        self.agent, self.allowed, self.backend = build_agent(
            self.profile, self._agent_session(), self.cfg, self.policy,
            model=build_chat_model(self._model))

    def _ensure_agent(self) -> None:
        """首个 AI 任务时构建 agent，已建则复用。self.agent/backend 从 None
        变就绪的唯一入口（建连不再预建）。"""
        if self.agent is None:
            self._build_agent_now()

    async def _prewarm_agent(self) -> None:
        """后台预热 AI 栈导入（只导入不构建：构建依赖 profile/model，留主
        线程）。建连完成即跑，首条自然语言的 task_start 不再等秒级 import；
        失败静默——首任务回退按需导入。"""
        def _import_stack() -> None:
            _load_agent_stack()
            from . import agent  # noqa: F401 - 预导入模块本体，_run_task
            # 调用点 `from .agent import TaskRunner` 命中 sys.modules 零成本
        try:
            await asyncio.to_thread(_import_stack)
        except Exception:  # noqa: BLE001 - 预热失败不阻断，首任务按需导入
            pass

    # --- 命令历史长期记忆（SQLite）---
    def _record_history(self, source: str, command: str) -> None:
        """落一条命令进历史库；失败静默（历史不能打死主流程）。

        注入管线内部行（_ot_inj 分片、__ot_exec__/__ot_pad）不入史：每次
        任务重注入都记 ~8 条 ~700B 垃圾，回灌单行超 tty 缓冲会死锁黑屏。
        """
        if command and self._target_host and not is_internal_line(command):
            history_db.record(self._target_host, source, command)

    async def _inject_shell_history(self, shell: str | None,
                                    flag: str = "-d") -> None:
        """把该 target 近期命令灌进远端 shell 历史（history / ↑ 原生可见）。

        必须在集成脚本注入前（裸 shell 阶段）发送；批处理回退下注入行的
        回显会闪现一次，可接受。失败静默降级。
        """
        if not shell or self.session is None or not self._target_host:
            return
        try:
            rows = history_db.recent(self._target_host, HISTORY_RECALL_LIMIT)
            cmds = [r["command"] for r in rows
                    if not is_internal_line(r["command"])]
            # 单行注入受 tty canonical 缓冲约束（macOS ~1KB）：超限从最旧丢起。
            # 截断会让 shell 卡在续行态，后续写入 EAGAIN 自旋死锁（黑屏）。
            line = b""
            while cmds:
                cand = history_inject_line(shell, cmds, flag)
                if len(cand) < 900:
                    line = cand
                    break
                cmds = cmds[1:]
            if line:
                await self.session.send_raw(line)
        except Exception:  # noqa: BLE001 - 会话关闭竞态等
            pass

    async def _drain_quiet(self, quiet: float = 0.12,
                           router: "StreamRouter | None" = None) -> str | None:
        """排空输出直到静默；喂 router 时返回其间出现的提示符（无则 None）。

        setup 注入期专用：泵未启动，必须主动读，否则 zle 回显塞满输出队列
        会导致 shell 停读输入、写入端 EAGAIN 自旋死锁（Task 注入排障结论）。
        """
        prompt = None
        while True:
            try:
                chunk = await self.session._read_some(quiet)
            except asyncio.TimeoutError:
                return prompt
            except (ConnectionError, EOFError):
                return prompt
            if not chunk:
                return prompt
            _dbg("drain raw=", repr(chunk[:60]))
            if router is not None:
                for ev in router.feed(chunk):
                    if ev[0] == "prompt" and prompt is None:
                        prompt = ev[1]

    async def _on_session_reconnect(self) -> None:
        # 重连后的新 shell 是裸的（集成脚本已随旧会话消失），用记住的
        # shell 种类重新灌历史；种类未知（探测失败过的批处理）跳过
        await self._inject_shell_history(self._shell_kind, self._b64flag)
        if self._target is not None and self._target.commands:
            self._spawn_cmdset()

    def _spawn_cmdset(self) -> None:
        # 重复触发(重连/就绪)先取消在跑的旧 runner:否则双 runner 交错写
        # PTY、同抢 _pws 队列(密码会随机路由给其中一个等待者)
        if self._cs_task is not None and not self._cs_task.done():
            self._cs_task.cancel()
        self._cs_task = asyncio.create_task(self._run_command_set())

    # --- 连接后命令集(spec 2026-09-24):免交互串行执行 ---
    def _cs_text(self) -> str:
        """尾窗文本(剥 ANSI / 归一换行)——只喂正则判定,不用于显示。

        不剥就判不出 shell 提示符回来了:PowerShell/ConPTY 的提示符后面跟着
        光标显隐、颜色复位等转义序列,行尾判提示符的正则永远匹配不上,命令集每条
        都要白等 CMDSET_PROMPT_TIMEOUT 才放行(真机浏览器复现:提示符 3.1s
        就回来了,第 2 条命令 13.2s 才发出去;真机「要按 Enter 才刷新状态」
        的迟滞感同源)。回显判定同理:PSReadLine 会把命令分词上色。
        """
        raw = bytes(self._cs_tail or b"").decode("utf-8", "replace")
        return _ANSI_RE.sub("", raw).replace("\r\n", "\n").replace("\r", "\n")

    def _cs_lastline(self) -> str:
        return self._cs_text().rsplit("\n", 1)[-1]

    async def _cs_pause_for_input(self) -> None:
        """命令执行后终端停在交互提示、又没有应答行接管 → 暂停等用户输入。

        用户直接在终端输(密码不回显),见到 shell 提示符后自动继续;前端
        「继续」按钮(cmdset_resume)随时强制放行。输错密码导致提示重现时
        保持暂停。

        收束信号只能是 shell 提示符,不能是「提示文本消失了」——ssh/sudo
        读完密码先回一个裸 CRLF(尾行空、提示正则不匹配),auth 还没出结果、
        TTY 仍关回显,此刻放行下一条命令就射进无回显窗口:字符进 tty 排队、
        登录后被执行,但一条回显都没有(真机:sudo su - / cd /root 从没上屏,
        界面要按 Enter 才见到提示符)。
        """
        if self._cs_pw_pending:
            await self._cs_watch_prompt()
            self._cs_pw_pending = False
        if not _CMDSET_PROMPT_RE.search(self._cs_lastline()):
            return
        self._cs_resume.clear()
        paused = False
        gone_at = None
        while not self._closed:
            line = self._cs_lastline()
            if _CMDSET_PROMPT_RE.search(line):
                gone_at = None
                if not paused:
                    paused = True
                    await self.emit_msg(ServerMsg(
                        type="cmdset", state="paused"))
                try:
                    await asyncio.wait_for(self._cs_resume.wait(), 0.2)
                    return                    # 提示未消失也放行:用户明示继续
                except asyncio.TimeoutError:
                    pass
                continue
            if _CMDSET_DONE_RE.search(line):
                return                        # shell 提示符回来:命令真跑完
            if gone_at is None:
                gone_at = time.monotonic()
            try:
                await asyncio.wait_for(self._cs_resume.wait(), 0.1)
                return                        # 用户点继续:强制放行
            except asyncio.TimeoutError:
                pass
            if time.monotonic() - gone_at > CMDSET_PROMPT_TIMEOUT:
                return                        # 超时兜底:不再卡住命令集

    async def _run_command_set(self) -> None:
        lines = [l for l in (self._target.commands if self._target else [])
                 if l.strip() and not l.lstrip().startswith("#")]
        total = len(lines)
        try:
            for i, line in enumerate(lines, 1):
                if self._closed:
                    return
                await self.emit_msg(ServerMsg(
                    type="cmdset", state="running", index=i, total=total,
                    cmd="" if line.lstrip().startswith(">")
                         else line.strip()))
                if line.lstrip().startswith(">"):
                    await self._cs_answer(line.strip()[1:].strip())
                else:
                    await self._cs_pause_for_input()
                    await self._cs_command(line.strip())
            # 末条命令可能停在交互提示上(如最后一条是 ssh):先按待输入暂停,
            # 否则状态栏报「完成」而终端还卡在密码提示
            await self._cs_pause_for_input()
            await self.emit_msg(ServerMsg(
                type="cmdset", state="done", index=total, total=total))
        except asyncio.CancelledError:
            raise
        except ConnectionError:
            return  # 弹窗等待期间连接关闭:静默退出,close 流程已接管
        finally:
            self._cs_tail = None   # runner 退出即停缓冲(pump 钩子归零)
            self._cs_pw_pending = False

    async def _cs_command(self, cmd: str) -> None:
        """命令行:写入 PTY,等回显再等输出静默(自回显起封顶 ECHO_TIMEOUT)。

        不在结束时清 tail:密码提示常与命令回显同批到达(快网络),
        后续应答行要能继承这段输出继续匹配。
        """
        await self._cs_wait_pw_verify()
        self._cs_tail = bytearray()
        await self.session.send_raw((cmd + "\r").encode())
        deadline = time.monotonic() + CMDSET_ECHO_TIMEOUT
        while time.monotonic() < deadline and cmd not in self._cs_text():
            await asyncio.sleep(0.02)
        if cmd not in self._cs_text():
            # 回显始终没到(TTY 还在无回显窗口/被吞):补画命令行,否则用户
            # 根本看不到这条执行了什么(真机「只显示第 1 条命令的执行记录」)
            await self.emit_bytes(cmd.encode() + bytes([13, 10]))
        quiet_deadline = time.monotonic() + CMDSET_ECHO_TIMEOUT
        last = -1
        while time.monotonic() < quiet_deadline:
            if len(self._cs_tail) != last:
                last = len(self._cs_tail)
                await asyncio.sleep(CMDSET_QUIET)   # 有新字节:再等一个静默窗
            else:
                break                               # 静默期满:命令可能跑完
        # 静默≠跑完:记下这条是不是密码类,交给 _cs_pause_for_input 在发下一条
        # 前确认它没停在交互提示上(见 _cs_watch_prompt)
        self._cs_pw_pending = _needs_password_prompt(cmd)

    async def _cs_wait_pw_verify(self) -> None:
        """密码验证窗内不注入命令:TTY 关着回显,射进去的命令被执行却不上屏。

        与用户按键(_on_keys)同一道闸,只是这里等而不是排队——命令集是自动
        推进的,排进 _pw_hold 会和「先看提示再发」的时序打架。
        """
        deadline = time.monotonic() + _PW_VERIFY_TIMEOUT
        while self._pw_verifying and not self._closed:
            if time.monotonic() > deadline:
                return
            await asyncio.sleep(0.05)

    async def _cs_watch_prompt(self) -> None:
        """上一条是密码类命令时,发下一条前先确认它没停在交互提示上。

        ssh/sudo 类握手期会静默数秒才吐 password:,静默判定把这段空档当成
        「命令跑完」,下一条命令就抢跑进它的 stdin 被当下一条密码吃掉(真机:
        ssh 该阻塞等密码,sudo su - / cd /root 却已回显,登录后又排队执行)。

        见交互提示即返回(交 _cs_pause_for_input 暂停等应答);见新 shell 提示符
        = 命令已结束(含 ssh/su - 登录后的新提示符)立即返回,零额外延迟。
        """
        if not self._cs_tail:
            return                        # 无输出证据可判:不做无谓等待
        deadline = time.monotonic() + CMDSET_PROMPT_TIMEOUT
        while time.monotonic() < deadline:
            line = self._cs_lastline()
            if _CMDSET_PROMPT_RE.search(line):
                return                    # 交互提示在前台:停下等应答
            if _CMDSET_DONE_RE.search(line):
                return                    # 新 shell 提示符:命令已结束
            await asyncio.sleep(0.05)

    async def _cs_answer(self, ref: str) -> None:
        """应答行:等密码类提示出现后自动输入;10s 等不到则跳过(容错)。

        @引用在密钥库缺失时首次学习:弹窗询问一次(必定记住,存
        cmdset:<引用名>),本次立即用,之后连接自动取。
        """
        if ref.startswith("@"):
            name = ref[1:].strip()
            answer = cmdset.resolve_answer(name)
            pat = _CMDSET_SECRET_RE   # 密码应答只认密码类提示(确认类会回显)
            if answer is None:
                answer = await self.ask_password(
                    f"命令集：{name} 的密码（记住后下次自动填充）",
                    auth_kind="cmdset")
                if not answer:      # 用户空提交:放弃该应答行
                    await self.emit_msg(ServerMsg(
                        type="status",
                        text=f"命令集：@{name} 未输入密码，已跳过自动应答"))
                    return
                store_password(f"cmdset:{name}", None, None, answer)
        else:
            answer = ref
            pat = _CMDSET_PROMPT_RE
        if self._cs_tail is None:
            # 命令集以应答行开头(前面没有命令阶段)才新建缓冲;否则继承
            # 命令阶段的输出——提示很可能已在那里等着
            self._cs_tail = bytearray()
        try:
            deadline = time.monotonic() + CMDSET_PROMPT_TIMEOUT
            while time.monotonic() < deadline:
                if self._closed:
                    return
                if pat.search(self._cs_text()):
                    await self.session.send_raw((answer + "\r").encode())
                    # 应答是静默的(密码不回显):旧提示符还挂在尾窗里,尾窗
                    # 重置成「应答之后的输出」,下一条才判得出 shell 提示符
                    # 何时回来;并记账发下一条前先等它回来,否则抢跑进仍在关
                    # 回显的 auth 窗口(真机:sudo su - / cd /root 不上屏)
                    self._cs_tail = bytearray()
                    self._cs_pw_pending = True
                    await asyncio.sleep(CMDSET_QUIET)   # 密码不回显,静默即稳
                    return
                await asyncio.sleep(0.05)
            await self.emit_msg(ServerMsg(
                type="status", text="命令集：未检测到交互提示，已跳过自动应答"))
        finally:
            # 不在这清 _cs_tail:应答后下一条要靠它判 shell 提示符何时回来,
            # 清掉就无证据、_cs_watch_prompt 直接放行→抢跑进无回显窗口。
            # 归零由 _cs_command 开头与 runner 退出时的 finally 负责。
            pass

    async def _setup_interactive(self) -> None:
        """探测 shell 能力并注入集成脚本（单管线）。

        成功：_interactive=True——PTY 字节直写前端主 xterm，命令/AI 由
        OSC 133 标记与行报告记账。失败（旧 shell、探测超时、注入后无标记
        回显）静默回退纯终端直通，AI 不可用（interactive=0）。
        """
        self._interactive = False
        self._router = None
        self._exec_stack = []
        self._pending_report = None
        self._ai_queue = []
        if self.session is None or self.profile is None:
            return
        try:
            r = await self.session.run(
                probe_command(self.profile.os_family), timeout=10)
            shell, flag = parse_probe(r.output or "")
            _dbg("setup probe out=", repr((r.output or "")[:120]),
                 "exit=", r.exit_code)
            if not shell:
                _dbg("setup: probe 未识别 shell → 纯终端直通")
                return
            # 历史静默窗口（POSIX）：此后所有注入行带前导空格，ignorespace/
            # hist_ignore_space 让原生入史整体跳过；脚本尾部按快照还原并
            # 清掉旧版本已落盘的垃圾（用户报障「↑ 全是 __ot_inj 分片」）
            if shell != "powershell":
                await self.session.send_raw(history_quiet_line())
            # 历史注入须在集成脚本之前（裸 shell 阶段执行 history -r / fc -R）
            await self._inject_shell_history(shell, flag)
            router = StreamRouter()
            _dbg("setup: inject shell=", shell, "flag=", flag,
                 "chunks=", len(injection_lines(shell, 1, flag)))
            # 分片注入：单片超 tty canonical 缓冲（macOS 本地 ~1KB）会被
            # 静默截断；片间写+读交替——此阶段泵未启动，若只写不读，zle 的
            # 回显会塞满输出队列 → zle 停读 → 输入队列满 → 写入自旋死锁。
            # 回显喂给 router（SWALLOW 相位只解析标记，echo 不外发）。
            # _write_sink：注入写入 EAGAIN 停顿期间由 _write_raw 边写边读
            # 输出喂 router，双向队列互满时不再死锁。
            def _sink(chunk: bytes) -> None:
                nonlocal prompt
                for ev in router.feed(chunk):
                    if ev[0] == "prompt" and prompt is None:
                        prompt = ev[1]

            prompt: str | None = None

            self.session._write_sink = _sink
            try:
                for _ci, chunk_line in enumerate(
                        injection_lines(shell, 1, flag)):
                    _dbg("chunk", _ci, "sending", len(chunk_line), "B")
                    await self.session.send_raw(chunk_line)
                    _dbg("chunk", _ci, "sent, draining")
                    drained = await self._drain_quiet(0.12, router)
                    _dbg("chunk", _ci, "drained, prompt=", drained is not None)
                    # sink 可能在写入停顿期已捕获提示符；drain 未再见时不覆盖
                    if drained is not None:
                        prompt = drained
                    if prompt is not None:
                        break
            finally:
                self.session._write_sink = None
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 8
            while loop.time() < deadline and prompt is None:
                try:
                    chunk = await self.session._read_some(0.3)
                except asyncio.TimeoutError:
                    continue
                except (ConnectionError, EOFError):
                    return
                if not chunk:
                    continue
                _dbg("wait raw=", repr(chunk[:60]))
                for ev in router.feed(chunk):
                    if ev[0] == "prompt":
                        prompt = ev[1]
                        break
            if prompt is None:
                # 注入行可能被 tty 行缓冲截断（macOS 本地 canonical 缓冲
                # ~1KB，装不下 ~2KB 的注入行）：残留半行会把 shell 卡在
                # dquote cmdsubst> 续行提示，后续哨兵 run 全部超时。清行
                # 中断后回退直通模型。
                _dbg("setup: 注入后 8s 无提示符标记 → 纯终端直通")
                await self.session.send_raw(b"\x15\x03")
                return
            self._router = router
            self._shell_kind = shell
            self._b64flag = flag
            self._cur_prompt = prompt
            self._runner = InteractiveRunner(self)
            self._interactive = True
            # 后台预热 AI 栈：首条自然语言不再在 _run_task 里付秒级导入
            # （真机分析卡延迟根因之二）；导入走线程池不堵事件循环
            asyncio.get_running_loop().create_task(self._prewarm_agent())
        except Exception:  # noqa: BLE001 - 探测/注入任何失败都回退直通
            import traceback
            _dbg("setup: 异常回退纯终端直通", traceback.format_exc())
            self._interactive = False

    async def _dispatch(self, msg: ClientMsg) -> None:
        if msg.type == "raw":
            await self._on_keys(msg.data)
        elif msg.type == "mode":
            await self._switch_display(msg.text)
        elif msg.type == "resize":
            if self.session is not None:
                await self.session.resize(msg.rows, msg.cols)
        elif msg.type == "change_model":
            await self._change_model(msg.model)
        elif msg.type == "close":
            await self.close()
        elif msg.type == "new_session":
            # 总结卡「开启新会话」：只重置模型上下文，不清屏不动 PTY
            #（界面等效回车，由前端发）；与 /clear 的区别就是没有清屏
            self._reset_context()

    # --- 按键 / AI 取消 ---
    async def _on_keys(self, data: bytes) -> None:
        """键盘字节直发 PTY（§5.4：单管线下 AI 工作时用户照样敲命令；
        AI 注入的 Ctrl+U/Ctrl+Y 括号保护覆盖唯一竞争点——真提示符半行）。"""
        if self.session is None or not data:
            return
        if self._session_dead and not await self._revive_session():
            return
        if self._pw_verifying:
            # 验证窗口（密码已提交、auth 结果未到）：按键 hold，验证结束
            # 依序释放——否则落进 ssh 输入队列被当下一条密码吃掉（真机
            # 「模态刚关抢跑的命令连排 Permission denied」根因）
            self._pw_hold.append(("raw", data))
            return
        _dbg("keys=", repr(data[:60]))
        if self._interactive and b"\x03" in data:
            await self._maybe_cancel_ai()
        await self.session.send_raw(data)
        # 回车看门狗：用户敲的回车是「hook 还在不在」最自然的验活点。命令行
        # 回车**不经** _on_frontend_line——前端只对自然语言发 submit，
        # `sudo su -` 这类命令是纯按键透传（真机 [otdbg] 只有 keys= b'\r'），
        # 只在 submit 上武装就永远迟一步：到点时裸 \r 早已把整行自然语言交给
        # 落回来的裸壳执行。集成壳的回车必有 PROMPT_COMMAND 回响（133;D +
        # 133;A/B），只有文本没有标记 = 承接回车的不是集成壳。
        # 密码位上的回车不验活：那是 sudo/ssh 的读取器在读密码，本来就不发
        # 标记，据此判陈旧是误判。工具命令在途同理（标记由 agent 帧负责）。
        if (b"\r" in data or b"\n" in data) and self._hook_ok() \
                and self._exec_future is None \
                and not self._pw_at_end and not self._pw_prompt_seen:
            self._arm_hook_watch()

    async def _revive_session(self) -> bool:
        """断线后首个键触发重连：恢复会话、补启泵并通知前端。

        持 _run_lock 防 AI 命令超时路径（_handle_timeout）并发恢复——双
        close/start 会交错杀进程。run() 哨兵路径可能已把会话换新（泵读到
        旧 fd 的 EOF 才走到这里），此时恢复是多余的但无害：新 shell 再
        重启一次，历史注入随 _notify_reconnect 重放。恢复期间的密码弹窗
        经 _pws 队列应答（不走 _inbox），此处阻塞不饿死应答。
        """
        if self.session is None:
            return False
        async with self.session._run_lock:
            try:
                ok = await self.session.recover()
            except Exception:  # noqa: BLE001 - 目标不可达/认证取消等
                ok = False
        if not ok:
            await self.emit_msg(ServerMsg(
                type="status", text="重连失败：目标暂不可达，稍后敲键可重试"))
            return False
        self._session_dead = False
        if self._pump is None or self._pump.done():
            self._pump = asyncio.create_task(self._pump_guard())
        await self.emit_msg(ServerMsg(
            type="reconnected", text=f"已重新连接 {self._target_host or '目标'}"))
        return True

    def _ai_cancellable(self) -> bool:
        return self._ai_task is not None and not self._exec_stack

    async def _maybe_cancel_ai(self) -> None:
        """Ctrl+C/⏹：AI 任务在跑且 shell 空闲（无打开的执行）→ 取消任务。
        有执行打开时不取消——\\x03 会直达 PTY 中断正在跑的命令。"""
        if self._ai_cancellable():
            self._ai_queue.clear()
            self._ai_task.cancel()

    async def _wait_exec_idle(self, timeout: float) -> bool:
        """等待 shell 空闲（无打开的执行上下文）。"""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while self._exec_stack:
            if loop.time() >= deadline:
                return False
            await asyncio.sleep(0.05)
        return True

    async def _stop_pump(self) -> None:
        """停输出泵并等它真正退出。只 cancel 不等的话，泵可能还压在
        _read_some 上，抢走随后命令/探测的回显与哨兵字节（哨兵流被切坏
        → run 拿空输出）。"""
        if self._pump is not None:
            t, self._pump = self._pump, None
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                # 外层任务在 `await t` 上被取消时，取消会传导给泵任务
                # （await task 的 waiter 就是任务本身），泵的 CancelledError
                # 会从这里冒出来——不能吞，否则外层的取消也被吞掉，任务
                # 变成杀不死的僵尸（teardown gather 挂死）
                if asyncio.current_task().cancelling() > 0:
                    raise
            except Exception:  # noqa: BLE001 - 会话关闭竞态（fd 失效等）
                pass

    def _reset_context(self) -> None:
        """模型上下文归零：换 thread_id（langgraph MemorySaver 按 thread 存
        历史，新任务的提示词不再带旧上下文，省 token）+ 换 transcript 文件。
        不碰 PTY——清屏与否由调用方决定（/clear 清屏，new_session 不清）。"""
        self._ctx_epoch += 1
        self.transcript = open_transcript(self.tab_id)

    async def _handle_slash(self, line: str) -> bool:
        """斜杠命令处理；返回 True 表示已消费（经 hook AI 报告进入）。"""
        if line == "/help":
            await self.emit_msg(ServerMsg(
                type="status",
                text="/target 切换主机  /clear 清屏新任务  /model 查看模型"
                     "  /system 手动设系统方言  /exit 关闭会话"))
            return True
        if line == "/model":
            await self.emit_msg(ServerMsg(
                type="status",
                text=f"{self.cfg.model.model} @ {self.cfg.model.base_url}"))
            return True
        if line == "/exit":
            await self.close()
            return True
        if line == "/clear":
            self._reset_context()
            await self.emit_msg(ServerMsg(
                type="status", text="已开启新任务。"))
            # 通知前端清掉本会话的全部 AI 卡片
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "session_cleared"}))
            # 清屏交原生：Ctrl+L 让 shell 清屏重画提示符（历史进 scrollback）
            if self.session is not None and self._interactive:
                await self.session.send_raw(b"\x0c")
            return True
        if line.startswith("/target"):
            await self._switch_target(line)
            return True
        if line.startswith("/system"):
            await self._manual_system(line)
            return True
        return False

    async def _run_task(self, text: str, hooked: bool = False) -> None:
        self.transcript.append("user", text=text)
        self._task_cmd_started = False
        self._tool_idx_map = {}   # 跨任务残留的局部 index 映射作废（序号不回绕）
        # task_start 先于 AI 栈导入/重注入：首任务 deepagents/langchain 秒级
        # 导入与换壳重注入不得挡在分析卡出场前（真机「输完自然语言等几秒
        # 才出卡」根因）；构建失败照发 error 事件，卡片原地定格为已中止
        await self.emit_msg(ServerMsg(
            type="event", event={"kind": "task_start", "text": text}))
        try:
            self._ensure_agent()   # 首个 AI 任务才构建（惰性导入 AI 栈）
        except Exception as e:  # noqa: BLE001 - 构建失败发 error 事件让前端收尾
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"AI 初始化失败：{type(e).__name__}: {e}"}))
            return
        # hook 上报触发的任务不重注入：上报即在位凭据，而注入吞窗口会吃掉
        # 在途蓝色重绘字节（真机「提交行消失」）；外部启动（无上报）才需要
        if not hooked:
            await self._ensure_integrated()   # su - 等 login shell 重置后先重注入
        presenter = CorePresenter(self)
        self.backend.on_start = presenter.on_start
        self.backend.on_output = None   # 输出由 exec 状态机直写主 xterm
        self.backend.on_finish = presenter.on_finish
        self.backend.on_boundary = self._boundary_gate

        def _live(ev) -> None:
            self._ai_ping_at = time.monotonic()   # 事件产出 = 任务在世，僵尸判据刷新
            if ev.kind == "token":
                self._emit_nowait(ServerMsg(
                    type="event",
                    event={"kind": "ai_token", "text": ev.text}))
            elif ev.kind == "think":
                self._emit_nowait(ServerMsg(
                    type="event",
                    event={"kind": "ai_think", "text": ev.text}))
            elif ev.kind == "denied":
                self._emit_nowait(ServerMsg(
                    type="event", event={"kind": "denied", "text": ev.text}))
            elif ev.kind == "tool_start":
                # 阶段边界先定格当前分析卡（工具卡挂流底，之后模型输出开新卡，
                # 叙事节奏与分析卡→命令→分析卡一致）；再挂工具调用小卡。
                # 工具执行期无 PTY 输出，不需要 boundary 门闩。execute 也发卡
                #（远程目标上模型几乎只走 execute），但不再补 ai_collapse：
                # 命令定格走 boundary 门闩既有路径，双发会把 CLI 的执行面板打两遍
                self._tool_card_seq += 1
                self._tool_idx_map[ev.index] = self._tool_card_seq
                if ev.name != "execute":
                    self._emit_nowait(ServerMsg(
                        type="event", event={"kind": "ai_collapse"}))
                self._emit_nowait(ServerMsg(
                    type="event",
                    event={"kind": "ai_tool", "phase": "start",
                           "id": self._tool_card_seq,
                           "name": ev.name, "args": ev.text}))
            elif ev.kind == "tool_end":
                gid = self._tool_idx_map.pop(ev.index, None)
                if gid is not None:
                    self._emit_nowait(ServerMsg(
                        type="event",
                        event={"kind": "ai_tool", "phase": "end", "id": gid,
                               "failed": ev.failed}))
            elif ev.kind == "limit":
                self._emit_nowait(ServerMsg(
                    type="event", event={"kind": "limit", "text": ev.text}))
            elif ev.kind == "error":
                self._emit_nowait(ServerMsg(
                    type="event", event={"kind": "error", "text": ev.text}))

        # 调用点取 TaskRunner：预热已导入 agent 模块（sys.modules 命中零
        # 成本）；测试桩打 amod.TaskRunner，缓存进 core 会跨测试串味
        from .agent import TaskRunner
        runner = TaskRunner(
            self.agent, f"{self.tab_id}#c{self._ctx_epoch}",
            max_tool_turns=self.cfg.shell.max_tool_turns,
            on_event=_live,
        )
        try:
            events = await runner.run(text)
            await self._handle_events(runner, events)
        except Exception as e:  # noqa: BLE001 - 任务异常发 error 事件让前端收尾
            # 不能只靠 _run 兜底的 status——前端靠 error/final 停计时、收卡片
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"任务失败：{type(e).__name__}: {e}"}))
            return
        finally:
            self.backend.on_output = None
            self.backend.on_start = None
            self.backend.on_finish = None
            self.backend.on_boundary = None
        # 累计会话 token 用量并上报前端状态栏。口径：真实 usage_metadata
        # 优先；网关不回传时用 tiktoken 估算（token_est），前端以 ≈ 标注
        task_in = runner.input_tokens or runner.est_input_tokens
        task_out = runner.output_tokens or runner.est_output_tokens
        if task_in or task_out:
            self._tokens_in += task_in
            self._tokens_out += task_out
            await self.emit_msg(ServerMsg(
                type="usage", tokens_in=self._tokens_in,
                tokens_out=self._tokens_out,
                estimated=not (runner.input_tokens or runner.output_tokens)))

    async def _change_model(self, model_id: str) -> None:
        """运行时切换模型：记录新 ModelConfig；agent 已建则重建（保留 profile/session）。"""
        if not model_id or model_id == self._model.model:
            return
        self._model = replace(self._model, model=model_id)
        if self.agent is None:
            # 尚未构建 agent（还没发起过 AI 任务）——只记录模型，_ensure_agent 会用它
            await self.emit_msg(ServerMsg(
                type="status", text=f"已切换模型：{model_id}"))
            return
        try:
            self._build_agent_now()
            await self.emit_msg(ServerMsg(
                type="status", text=f"已切换模型：{model_id}"))
        except Exception as e:  # noqa: BLE001 - 切换失败提示，不影响会话
            await self.emit_msg(ServerMsg(
                type="status", text=f"切换模型失败：{type(e).__name__}: {e}"))

    async def _handle_events(self, runner, events) -> None:
        while True:
            for ev in events:
                if ev.kind == "tool_call":
                    self.transcript.append("tool_call", command=ev.command)
                elif ev.kind == "tool_start" and ev.name != "execute":
                    # execute 已由 tool_call 记账，不重复落 transcript
                    self.transcript.append(
                        "tool_call",
                        command=ev.name + (f" {ev.text}" if ev.text else ""))
                elif ev.kind == "denied":
                    self.transcript.append("denied", text=ev.text)
                elif ev.kind in ("limit", "error"):
                    return
                elif ev.kind == "final":
                    self.transcript.append("final", text=ev.text)
                    await self.emit_msg(ServerMsg(
                        type="event",
                        event={"kind": "final", "text": ev.text}))
                    # final 总结 markdown → 前端挂总结装饰卡（§5.3）
                    await self.emit_msg(ServerMsg(
                        type="event",
                        event={"kind": "ai_card", "markdown": ev.text}))
            if runner.interrupt_payload is None:
                return
            requests = runner.interrupt_payload["action_requests"]
            if len(requests) > 1:
                await self.emit_msg(ServerMsg(
                    type="status", text=f"模型一轮发起 {len(requests)} 个命令，请逐个确认"))
            decisions: list[dict] = []
            for req in requests:
                command = req.get("args", {}).get("command", "")
                description = req.get("description") or "高危命令需要审批"
                self.transcript.append("approval", command=command)
                decision = await self.ask_approval(
                    command, description, self._target_host,
                    self._approval_risk(command))
                decisions.append(decision)
            events = await runner.resume(decisions)

    async def _switch_target(self, line: str) -> None:
        from .connections import list_ssh_hosts, load_saved_targets

        names = list(dict.fromkeys(
            ["local"] + [t.name for t in load_saved_targets()] + list_ssh_hosts()))
        parts = line.split(maxsplit=1)
        arg = parts[1] if len(parts) == 2 else ""
        if not arg:
            await self.emit_msg(ServerMsg(
                type="status", text="可用目标：" + ", ".join(names)))
            return
        target = "default" if arg == "local" else self._register_target(arg)
        if self._ai_task is not None:
            self._ai_queue.clear()
            self._ai_task.cancel()
            self._ai_task = None
        if self._pump is not None:
            self._pump.cancel()
            self._pump = None
        if self.session is not None:
            await self.session.close()
        self.session = self.profile = self.agent = None
        self._display = "agent"
        self._runner = None
        self.target_name = target
        try:
            await self._connect()
        except Exception as e:  # noqa: BLE001 - 切换失败不打死 tab，回状态提示
            await self.emit_msg(ServerMsg(
                type="status", text=f"切换目标失败：{type(e).__name__}: {e}"))
            return
        await self.emit_msg(ServerMsg(
            type="ready", tab_id=self.tab_id, host=self._target_host,
            user=self._target_user, distro=self.profile.distro or "",
            prompt=self._cur_prompt,
            interactive=1 if self._interactive else 0))
        self._pump = asyncio.create_task(self._pump_guard())
        if self._interactive:
            await self.session.send_raw(b"\x0c")

    def _register_target(self, text: str) -> str:
        from .config import TargetConfig
        from .connections import load_saved_targets, parse_user_at_host

        if text in self.cfg.targets or text in {"local", "default"}:
            return text
        # 记住的连接按 name 直接注册（含 host/user/port），否则 ad-hoc 重建
        for t in load_saved_targets():
            if t.name == text:
                self.cfg.targets[text] = t
                return text
        host, user, port = parse_user_at_host(text)
        name = text if user is None and port is None else host
        if name not in self.cfg.targets:
            self.cfg.targets[name] = TargetConfig(
                name=name, mode="ssh", host=host, user=user, port=port)
        return name

    async def _manual_system(self, line: str) -> None:
        from .sysprobe import MANUAL_PRESETS

        parts = line.split()
        if len(parts) < 2 or parts[1] not in MANUAL_PRESETS:
            await self.emit_msg(ServerMsg(
                type="status", text="可选：" + ", ".join(MANUAL_PRESETS)))
            return
        self.profile = replace(self.profile, **MANUAL_PRESETS[parts[1]])
        if self.agent is not None:
            self._build_agent_now()   # 已建才重建；未建由 _ensure_agent 用新画像
        await self.emit_msg(ServerMsg(
            type="status", text=f"系统方言已手动设为 {parts[1]}"))

    async def _pump_guard(self) -> None:
        """泵死亡留痕：任务引用被 self._pump 持有，异常永远不会被 asyncio 当作
        「未取回」打印出来——真机「终端彻底不再回显、日志一片安静」就此查无
        实据（第 3 轮复现里降级路径之后 90s 零字节的盲区）。"""
        try:
            await self._pump_loop()
        except asyncio.CancelledError:
            raise
        except BaseException:  # noqa: BLE001 - 只为留痕，原样重抛
            import traceback
            _dbg("pump died:", traceback.format_exc())
            raise

    async def _pump_loop(self) -> None:
        """PTY 泵：回退/Shell 模式纯透传；集成模式下按 OSC 标记切分——
        标记字节与需吞除的注入回显不外发，其余原样转发（唯一显示管线）。"""
        _tick = 0
        while not self._closed:
            try:
                data = await self.session._read_some(0.2)
            except asyncio.TimeoutError:
                # 心跳：读超时是稳态，每 10 次（≈2s）留一行。它把「远端真的
                # 沉默」与「泵死了/卡在处理器里」分开——心跳仍在 = 泵活着且
                # _read_some 正常返回，字节确实没来（第 3 轮真机盲区）。
                _tick += 1
                if _tick % 10 == 0:
                    _dbg("pump tick", _tick, "phase=", self._pump_phase)
                continue
            except (ConnectionError, EOFError):
                await self._pump_eof("连接已断开")
                return
            if data == b"":     # 本地 PTY 读者线程的 EOF 哨兵（如用户 exit）
                await self._pump_eof("会话已结束")
                return
            if not data:
                continue
            self._pump_phase = "body"
            _dbg("raw", len(data), repr(data[:60]))
            if self._cs_tail is not None:
                self._cs_tail.extend(data)
                if len(self._cs_tail) > 8192:
                    del self._cs_tail[:-8192]   # 只留尾部:提示匹配只需最近输出
            if self._intr_swallow_until:
                data = self._strip_intr_echo(data)
                if not data:
                    _dbg("intr swallow: 整块被 ^C 回显吞除")
                    continue
            self._detect_password_prompt(data)
            await self._detect_shell_exit(data)
            if not self._interactive or self._display == "ssh":
                self._pump_phase = "passthru"
                await self.emit_bytes(data)   # 回退模型 / Shell 模式：纯透传
                continue
            for ev in self._router.feed(data):
                self._pump_phase = "ev:" + str(ev[0])
                await self._on_stream_event(ev)
            self._pump_phase = "read"

    async def _pump_eof(self, text: str) -> None:
        if self._ai_task is not None:
            self._ai_queue.clear()
            self._ai_task.cancel()
        self._session_dead = True
        await self.emit_msg(ServerMsg(type="closed", text=f"{text}；敲键自动重连"))

    # --- 集成模式：标记流事件 ---
    async def _on_stream_event(self, ev: tuple) -> None:
        kind = ev[0]
        _dbg("ev", kind, "sup=", self._suppress_live,
             (ev[1][:60] if isinstance(ev[1], str) else ev[1:])
             if kind in ("live", "exec", "prompt") else ev[1:])
        if kind == "live":
            self._ev_stream.set()   # 回显到达：重注入分片的逐片应答凭据
            self._note_hook_text()
            if self._probe_buf is not None:
                # live 的 ev[1] 是 str（本分支末尾 emit 前也要 .encode），
                # bytearray.extend(str) 抛 TypeError 当场打死泵任务；而任务
                # 引用被 self._pump 持有，asyncio 连「未取回异常」都不打印
                # ——真机表现为终端彻底沉默（无回显、无输出、无 closed 帧）。
                # 触发条件恰是裸壳：探测行的回显是纯文本 → 走 live（集成壳
                # 里走 silent exec 帧，所以这条路径平时无声无息）。
                self._probe_buf.extend(ev[1].encode("utf-8", "replace"))
            if self._curtain:
                # 幕帘扣留：live 文本（提示符段及后续杂散回显）按序暂存，
                # 下一次注入（闸）或任务收尾才放行
                self._curtain_parts.append(ev[1])
                if time.monotonic() - self._curtain_at > 600.0:
                    await self._curtain_open()   # 防呆：扣满 10 分钟强制放行
            elif self._suppress_live:
                self._suppressed_echo = True   # 注入行回显：吞（§5.5）
            else:
                self._last_live_at = time.monotonic()
                await self.emit_bytes(ev[1].encode("utf-8", "replace"))
        elif kind == "exec":
            self._ev_stream.set()
            self._note_hook_text()
            if self._probe_buf is not None:
                self._probe_buf.extend(ev[1].encode("utf-8", "replace"))
            await self._on_exec_text(ev[1])
        elif kind == "prompt_start":
            self._ev_prompt.set()   # 模式切换等提示符重画
            self._note_hook_mark()
            # 任务运行期关帘：这段提示符重绘扣住不发——前端流式卡期间底部
            # 不出现空提示符（用户诉求：对话完全结束才显示命令提示符）
            self._curtain_close()
        elif kind == "prompt":
            self._cur_prompt = ev[1]
            self._note_hook_mark()
        elif kind == "report":
            self._note_hook_mark()
            inst, k, line = ev[1], ev[2], ev[3]
            if k == "AI":
                # 外部触发链健康路径：本行是补发 \r 后 hook 的原地蓝色重绘上报
                # ——上报即任务触发（与英文自然语言同一条 proven 路径）。
                # _suppress_ai_report：兜底已按同文启动任务，迟到上报吞掉防双跑
                if self._suppress_ai_report is not None and \
                        line.strip() == self._suppress_ai_report:
                    self._suppress_ai_report = None
                else:
                    if self._hook_report_pending is not None and \
                            line.strip() == self._hook_report_pending:
                        self._hook_report_pending = None
                    # hooked=True：hook 上报即 hook 在位的凭据，任务启动
                    # 跳过重注入——其吞窗口会吃掉在途的蓝色重绘字节
                    # （真机「提交行消失」根因：stty 快照后重绘慢几 ms 落进窗口）
                    await self._on_ai_line(line, hooked=True)
            else:
                # hook 把这行分类成了命令（CMD/EXEC）并会就地执行：清掉等 AI
                # 上报的兜底挂起，否则 _submit_fallback 会在 1.2s 后对同一行
                # \x03 + 重注入 + 强起 AI 任务（真机：hook 已报 command not
                # found，随后 ^C 残行 + 提示符连排）
                if self._hook_report_pending is not None and \
                        line.strip() == self._hook_report_pending:
                    self._hook_report_pending = None
                self._pending_report = (inst, k, line)
        elif kind == "exec_start":
            self._note_hook_mark()
            await self._on_exec_start(ev[1])
        elif kind == "exec_end":
            self._note_hook_mark()
            await self._on_exec_end(ev[1], ev[2], ev[3])

    async def _on_exec_start(self, inst: int) -> None:
        """C 标记：AI/探测/静默注入开帧；用户命令不进栈，仅记账。"""
        rep = self._pending_report
        self._pending_report = None
        kind, line = (rep[1], rep[2]) if rep else ("", "")
        if kind != "EXEC":
            if is_internal_line(line):
                # 注入分片装配 / eval 解包：静默开帧。两条症状的共同来源——
                # ①每片 __ot_run 的 C 标记各补一个 \r\n → 任务启动连打空行；
                # ②重注入 export -f 报错走无帧 exec 直通前端。internal 行不补
                # 收束换行、输出全吞（__ot_exec__ 恒走 EXEC 分支，不受影响）
                self._exec_stack.append({"ctx": "silent", "line": line, "inst": inst})
                return
            # 用户命令（CMD 报告或无报告）：显示全靠 PTY 原样字节，这里只
            # 记账（transcript 在 exec_end 带退出码记一次，避免重复）
            self._open_cmds[inst] = line
            self._open_cmd_at[inst] = time.monotonic()
            self._nested_pw_attempts = 0   # 新命令帧：嵌套密码自动填充资格重置
            self._user_out = bytearray()   # 救援上下文从本条命令输出起算
            if line:
                self._record_history("user", line)
            await self._close_suppressed_line()
            return
        if self._hidden_exec:
            ctx = "probe"
        else:
            ctx = "agent" if self._exec_future is not None else "silent"
        _dbg("exec_start inst=", inst, "ctx=", ctx, "line=", line[:60],
             "fut=", self._exec_future is not None)
        self._exec_stack.append({"ctx": ctx, "line": line, "inst": inst})
        await self._close_suppressed_line()
        if ctx == "agent":
            # AI 工具命令真正开始执行：此刻登记命令与首个收束事件——保证
            # ai_collapse 与输出按真实执行顺序交错（多命令并发发起时同理）
            cmd = (self._pending_agent_cmds.popleft()
                   if self._pending_agent_cmds else line)
            self._agent_open_cmd = cmd
            self._record_history("agent", cmd)
            if not self._task_cmd_started:
                self._task_cmd_started = True
                await self.emit_msg(ServerMsg(
                    type="event",
                    event={"kind": "ai_collapse", "command": cmd}))

    async def _close_suppressed_line(self) -> None:
        """注入窗口吞过回显时补一个换行收束提示符行（§5.5）：前端看不到
        被吞的注入行，不补换行的话命令输出会接在提示符同一行。"""
        if self._suppressed_echo:
            self._suppressed_echo = False
            await self.emit_bytes(b"\r\n")

    async def _on_exec_text(self, text: str) -> None:
        frame = self._exec_stack[-1] if self._exec_stack else None
        ctx = frame["ctx"] if frame else None
        if ctx in ("agent", "probe"):
            # 捕获进 _exec_buf：exec_end 用它组装 run() 的返回值
            raw = text.encode("utf-8", "replace")
            limit = self.cfg.shell.max_output_bytes
            if len(self._exec_buf) < limit:
                room = limit - len(self._exec_buf)
                self._exec_buf.extend(raw[:room])
                if len(raw) > room:
                    self._exec_truncated = True
            else:
                self._exec_truncated = True
            if ctx == "agent":
                await self.emit_bytes(raw)   # 输出直写主 xterm（§5.3）
            # probe：只捕获不转发（隐藏探测无前端副作用）
        elif ctx == "silent":
            pass    # 模式开关注入：吞掉（无显示）
        else:
            # 用户命令输出（无帧）：直通前端；抑制窗口内（su - 后重注入、C 帧
            # 未闭）这段 exec 字节是分片回显/eval 杂行——base64 墙，一并吞掉
            if self._suppress_live:
                return
            # 救援上下文：尾部截断保留（4KB 足够 AI 判定失败原因）
            self._user_out.extend(text.encode("utf-8", "replace"))
            if len(self._user_out) > 8192:
                del self._user_out[: len(self._user_out) - 4096]
            await self.emit_bytes(text.encode("utf-8", "replace"))

    async def _on_exec_end(self, inst: int, ec, cwd) -> None:
        _dbg("exec_end inst=", inst, "ec=", ec, "stack=",
             [(f["ctx"], f["inst"]) for f in self._exec_stack])
        self._ev_exec_end.set()
        if cwd and self._runner is not None:
            self._runner.cwd = cwd
        if inst in self._open_cmds:
            line = self._open_cmds.pop(inst)
            self._open_cmd_at.pop(inst, None)
            if line:
                self.transcript.append("direct", command=line, exit_code=ec)
            if not self._open_cmds:
                # 嵌套 shell（su - 等）退出：外层 hook 的标记/函数从未丢过，
                # 复位换壳判定，健康路径/pad 恢复
                self._hook_gone = False
                self._hook_stale = False
            await self._maybe_rescue(line, ec)
        if not self._exec_stack:
            return    # 孤儿 D：无帧的执行周期，忽略
        top = self._exec_stack[-1]
        if inst != top["inst"]:
            return    # 旧实例的 D：忽略
        frame = self._exec_stack.pop()
        if frame["ctx"] in ("agent", "probe"):
            fut = self._exec_future
            if fut is not None and not fut.done():
                fut.set_result(CommandResult(
                    output=bytes(self._exec_buf).decode("utf-8", "replace"),
                    exit_code=ec if ec is not None else 0,
                    truncated=self._exec_truncated,
                    cwd=cwd or (self._runner.cwd if self._runner else "")))
            # 立即恢复 live：D 之后的提示符重画字节不能被抑制窗口吞掉
            self._suppress_live = False
            self._suppressed_echo = False
            if frame["ctx"] == "agent" and self._agent_open_cmd is not None:
                self._agent_open_cmd = None   # 输出块已自然收束于主 xterm

    # --- 失败救援（reactive）---
    async def _maybe_rescue(self, line: str, ec) -> None:
        """用户命令非零退出 → 挂一张救援卡（一键交 AI 判定原意/修复）。

        分类启发式判 CMD 就直接执行（零延迟、对真命令零误伤），失败即信号
        （market 先例：Copilot 终端建议 / JetBrains 内联修复 / thefuck）。
        手动卡而非自动起任务：grep 无匹配（exit 1）、测试挂掉这类「正常失败」
        不能被劫持进 AI。130/143 = 用户自己 Ctrl+C/kill，不是失败。
        """
        if (not self._interactive or not isinstance(ec, int) or ec == 0
                or ec in (130, 143)
                or self._ai_task is not None      # AI 在跑：用户侧命令不掺和
                or self._rescue_open              # 已有待决策救援卡：不刷屏
                or self._exec_future is not None  # runner 占用（理论不可达，双保险）
                or self._suppress_live            # 注入窗口内的杂行不是用户命令
                or not line.strip()):
            return
        self._rescue_open = True
        out = bytes(self._user_out[-2048:]).decode("utf-8", "replace").strip()
        self._rescue_ctx = (line, ec, out)
        await self.emit_msg(ServerMsg(type="event", event={
            "kind": "rescue", "line": line, "ec": ec, "output": out}))

    async def _on_rescue_decision(self, accept: bool) -> None:
        """救援卡决策：accept → 以失败上下文起 AI 任务（自然语言优先解读）。"""
        if not self._rescue_open:
            return
        self._rescue_open = False
        ctx, self._rescue_ctx = self._rescue_ctx, None
        if not accept or ctx is None:
            return
        line, ec, out = ctx
        prompt = (
            f"我在终端里输入了「{line}」并回车，它被当作命令执行但失败了"
            f"（退出码 {ec}）。\n"
            + (f"命令输出：\n{out}\n" if out else "（无输出）\n")
            + "\n请判断我的真实意图：如果我想输入的是自然语言请求，直接完成它；"
              "如果是命令写错了（拼写/参数/路径），修正后用 execute 工具执行并"
              "给我结果。")
        # hooked=True：这条 CMD 上报+C/D 帧刚走通，hook 在位是既成事实，
        # 重注入的吞窗口只会白吃在途字节
        await self._on_ai_line(prompt, hooked=True)

    # --- AI 行（自然语言，经 hook AI 报告进入）---
    async def _on_ai_line(self, line: str, hooked: bool = False) -> None:
        if self._ai_task is not None:
            self._ai_queue.append((line, hooked))   # 忙：排队，结束后依序回放
            return
        self._start_ai(line, hooked)

    async def _on_frontend_line(self, text: str, dirty: bool = False,
                                typed: bool = True) -> None:
        """外部触发链：前端在 agent 模式拦下的整行。

        健康路径（hook 在位 + shell 空闲在提示符）：补发回车——hook 的 AI 分支
        原地把默认色回显重画为「提示符+蓝色文本」（§5.6 Workbench 观感：用户
        输入蓝、工具命令青），再以 6337 AI 上报触发任务（自然语言不入 shell
        历史——↑/↓ 只召回历史命令；上报即
        启动，与英文自然语言同一条 proven 路径，无 \x03 残行）。hook 在位时
        shell BUFFER 即真相：镜像 dirty（被无法镜像的转义/控制键清过，如历史
        召回）也走健康路径，只是不挂兜底——镜像文本与 hook 上报必不相等，
        挂了会在 1.2s 后按残镜像误起任务（真机「帮我把ll设置为"ls -al"的别名」
        行内方向键编辑后 AI 只收到光标后尾巴的根因之一）。
        「shell 空闲」由 _open_cmds 空判定：用户命令执行帧开着（前台占用，典型
        su - 整段会话——其 C 帧不闭合还会让 _hook_ok 的时间戳比较永久误判在位）
        时 readline 不在读行，补发的 \r 只落进命令 stdin，hook 永不重绘/上报。

        降级路径（hook 标记绝迹 = su - 重置）：先发 Ctrl+C 丢弃已回显半行（不能
        用 \x15/^U：kill 进 kill ring 的文本会被后续注入序列收尾的 \x19/^Y yank
        回提示符行），再重注入分片脚本——成功且镜像可信时把整行重发进 hook
        （蓝色回显 + 上报触发，su - 后用户同样看得见自己的输入）；镜像 dirty 时
        不重发（残尾巴会被当整行画屏并送 AI），静默走 AI 流；重注入失败才静默
        走 AI 流。工具命令执行中不动终端，只透传回车。
        typed=False（验证窗口 hold 输入的回放）：字符当时被 hold、不在 shell
        buffer——健康路径补发整行+回车，降级路径跳过 \x03（无半行回显可丢）。
        验证窗口（_pw_verifying）内整行与按键一并 hold（见 _begin_pw_verify），
        验证结束由 _flush_pw_hold 依序释放。"""
        if self.session is None:
            return
        t = text.strip()
        _dbg("submit text=", repr(t[:60]), "dirty=", dirty,
             "exec_busy=", self._exec_future is not None,
             "open_cmds=", len(self._open_cmds))
        if self._pw_verifying:
            # 验证窗口：抢跑的整行 hold 住——补发的 \r 会落进 ssh 输入队列
            # 成一次空密码尝试（真机连排 Permission denied 根因）
            if t and _looks_ai(t):
                self._pw_hold.append(("submit", t, dirty))
            else:
                self._pw_hold.append(("raw", b"\r"))
            return
        if not t or self._exec_future is not None or not _looks_ai(t):
            await self.session.send_raw(b"\r")
            # 命令行回车同样要验活：承接它的若不是集成壳（嵌套 shell 被 TMOUT
            # 收走后落回的裸壳），下一条自然语言的健康路径 \r 就会把整行当命令
            # 执行。工具命令在途不武装——那段的标记由 agent 帧负责。
            if t and self._exec_future is None and self._hook_ok():
                self._arm_hook_watch()
            return
        if self._pw_prompt_seen:
            # 密码提示符在前台（ssh/sudo 讨密码）：绝不能拦成自然语言——
            # 否则密码行被当任务挂起，\r 被 ^C/重注入链吞掉，登录失败。
            # 字符已原样透传（echo 关闭），这里只补发回车提交密码。
            await self.session.send_raw(b"\r")
            return
        if self._interactive and self._hook_ok() and (
                not self._open_cmds or self._inner_ssh_prompt_live()):
            await self.session.send_raw(b"\r" if typed else (t + "\r").encode())
            # 兜底只保本次任务不悬空；看门狗保的是**下一条**：hook 其实不在位时
            # 置 _hook_stale，后续提交不再重复把整行自然语言送进裸壳
            self._arm_hook_watch()
            if not dirty:
                self._hook_report_pending = t
                self._fallback_task = asyncio.create_task(self._submit_fallback(t))
            return
        # 降级路径：先 Ctrl+C 丢弃已回显半行（不能用 \x15/^U：kill 进 kill
        # ring 的文本会被后续注入序列收尾的 \x19/^Y yank 回提示符行），再尝试
        # 重注入（su - 重置是主因）——成功则把整行重发进 hook：蓝色回显 + 6337
        # 上报触发，与健康路径同一条 proven 链路，用户看得见自己的输入；重注入
        # 失败才回退外部启动（静默不回显）。工具命令执行中不动终端，只透传回车。
        if typed:
            self._arm_intr_swallow()   # bash 会在半行尾回显 "^C"：吞掉这两字节
            await self.session.send_raw(b"\x03")
            # readline 的 SIGINT 恢复窗口（^C 回显 + 退格重画）会丢弃期间到达的
            # 输入：紧贴 ^C 写分片会丢 chunk0 头部（真机实测：解码脚本缺字节、注释行
            # 断成命令报 "对策: …: command not found"；settle 0.4s 后消失）。
            # ^C 回显本身由 _strip_intr_echo 精确吞除（只两字节，不吞提示符段——
            # 整窗吞会让前端光标与 PTY 失步 = 真机「同一行输入重复两遍」根因）；
            # 分片回显的吞窗口由 _ensure_integrated 自管（自带 try/finally 复位）
            await asyncio.sleep(0.4)
        if self._interactive and await self._ensure_integrated() and not dirty:
            await self.session.send_raw((t + "\r").encode())
            self._hook_report_pending = t
            self._fallback_task = asyncio.create_task(self._submit_fallback(t))
            return
        # 镜像 dirty：残尾巴重发会被当整行画屏并送 AI（真机截图根因）；
        # 重注入失败亦静默外部启动
        await self._on_ai_line(t)

    def _hook_ok(self) -> bool:
        """hook 在位判定：本会话见过 OSC 标记，且探测未判定「换了壳」。

        旧口径「标记时间戳不落后于纯文本」会把**按键回显**（纯文本）误判成
        标记绝迹：用户只要敲过字，live 必然新于最后一次提示符标记，健康路径
        永久退化——\\x03 + 整行重发，且 suppress 窗口吞掉 ^C 后的提示符重画
        使前端光标与 PTY 失步，重发回显拼在首段回显后（真机「同一行输入重复
        两遍」根因）。su - 等重置发生在用户命令帧内（_open_cmds 开着），已由
        空闲门闩覆盖；帧闭合后外层 hook 仍在、标记恢复。

        但仅凭标记流也不够：su - 换壳后注入的外族 PS1 照样发标记而函数全空
        （真机 zsh PS1 落进 bash 3.2），故 _ensure_integrated 探测失败置
        _hook_gone 转假；嵌套 shell 退出（_open_cmds 清空）复位，外层 hook
        的标记与函数从未丢过，自然恢复在位。

        _hook_stale 补的是第三类：**带 hook 的 shell 自己没了**。root 空闲
        TMOUT 自动登出、exit、logout 都不发任何标记，_hook_gone 的两个入口全
        够不着，而死壳留下的 _last_mark_at 会让 _inner_ssh_prompt_live 继续
        放行健康路径——补发的 \r 把自然语言整行送进落回来的裸壳执行（真机
        跳板机 → xiaojian → sudo su - root → TMOUT 掉回 → 再 sudo su - 后
        「输入自然语言就不行了」= -bash: 执行: command not found）。
        由回车看门狗置位，任一标记到达即撤销。"""
        return (self._interactive and not self._hook_gone
                and not self._hook_stale and self._last_mark_at > 0)

    # --- 回车看门狗：健康路径的「hook 还在不在」验活 -----------------------

    def _note_hook_mark(self) -> None:
        """任一 OSC 标记到达：集成壳就在当前提示符上活着。

        既是 _inner_ssh_prompt_live 的时间戳凭据，也是陈旧判定的撤销凭据——
        外层集成壳重新画出提示符（嵌套裸壳退出后落回来）即自愈，健康路径
        立刻恢复，不必白付一次探测 + 分片重注入。"""
        self._last_mark_at = time.monotonic()
        self._hook_stale = False
        self._cancel_hook_watch()

    def _note_hook_text(self) -> None:
        """纯文本（无标记）到达：看门狗窗口内记一笔「壳有响应」。

        只有文本、没有标记才判陈旧——一个标记都没有且毫无输出（链路卡死）时
        不作结论，交给既有的超时/断线机制。"""
        if self._hook_watch is not None:
            self._hook_watch_text = True

    def _arm_hook_watch(self) -> None:
        """健康路径补发回车后武装看门狗。

        集成壳的回车必有回响：PROMPT_COMMAND 发 133;D，提示符重画发 133;A/B。
        _HOOK_LIVENESS 内只收到纯文本 = 承接回车的不是集成壳，转降级（下一条
        自然语言走探测 + 重注入，而不是把整行交给裸壳执行）。误判自愈：真正的
        标记一到即撤销；期间最多多付一次幂等重注入。"""
        if self._display == "ssh":
            # Shell 模式 pump 纯透传，标记根本不进路由器：无从验活，不作结论
            return
        self._cancel_hook_watch()
        self._hook_watch_text = False
        self._hook_watch = asyncio.create_task(self._hook_liveness())

    def _cancel_hook_watch(self) -> None:
        t = self._hook_watch
        if t is not None:
            self._hook_watch = None
            t.cancel()

    async def _hook_liveness(self) -> None:
        me = asyncio.current_task()
        try:
            await asyncio.sleep(_HOOK_LIVENESS)
        finally:
            # 只清自己的把手：撤销后紧接着重新武装时，新任务不得被旧任务的
            # finally 抹掉（否则看门狗失控、再也撤不掉）
            if self._hook_watch is me:
                self._hook_watch = None
        if self._closed or not self._hook_watch_text:
            return
        _dbg("hook stale: 回车后只有文本没有标记 → 转降级")
        self._hook_stale = True

    # --- shell 自行退出感知（TMOUT 自动登出 / logout / 断链）--------------

    async def _detect_shell_exit(self, data: bytes) -> None:
        """在输出字节流里认 shell 自行退出的文字特征。

        bash 退出不发任何 OSC 标记，_hook_gone 的两个入口与回车看门狗都够
        不着（见 _hook_ok 注释的「第三类」）；而 TMOUT 最常命中在**审批等待
        期**——那段 core 对 PTY 零字节发送，看门狗根本无从武装。故只能在字节
        流里认文字，匹配口径见 _match_shell_exit。
        """
        self._exit_tail.extend(data)
        if len(self._exit_tail) > 4096:
            del self._exit_tail[:-2048]
        why = self._match_shell_exit(bytes(self._exit_tail))
        if why is None:
            return
        self._exit_tail.clear()
        await self._note_shell_dead(why)

    def _match_shell_exit(self, tail: bytes) -> str | None:
        """在滚动窗里认 shell 告别语，回命中片段；没命中回 None。

        视觉行＝按 CR / LF 断开（CR 重画、提示符转义都并进同一行），剥掉转义
        与控制符后**整行**全文匹配。两重收敛防误判：告别语前只允许一段提示符
        宽度的普通字符、后面只许空白；裸 logout 只在审批挂起窗口认。只翻窗尾
        几行：命中即清窗处置，再往前翻只会翻出早已处置过（或与本次无关）的
        旧行。
        """
        lines = [x for x in re.split(rb"[\r\n]", tail) if x.strip()]
        for line in lines[-8:]:
            plain = _EXIT_CTRL_RE.sub(b"", _EXIT_ANSI_RE.sub(b"", line))
            for pat, label in _SHELL_EXIT_RULES:
                if pat.fullmatch(plain):
                    return plain.decode("utf-8", "replace")[:80] or label
            if self._shell_exit_window():
                for pat, label in _SHELL_EXIT_WEAK_RULES:
                    if pat.fullmatch(plain):
                        return label
        return None

    def _shell_exit_window(self) -> bool:
        """退出特征的弱匹配窗口：审批挂起。

        审批等待期 core 对 PTY 零字节发送、没有命令输出在途，行首 logout
        只可能是 shell 自己的告别；窗口外认了会把 history/ps/grep 输出里
        恰好成行的 logout 误判成壳死了。强特征（TMOUT 告别语 / ssh 断链）
        贴行首且专用，不受此窗口限制——空闲提示符上的 TMOUT 最常见，而那段
        既不在审批挂起也不在执行等待。"""
        return self._pending_approval is not None

    async def _note_shell_dead(self, why: str) -> None:
        """壳已死：作废 hook 活凭据，立刻解阻塞在途工具执行。

        后续提交与工具注入经 _hook_ok 转假走门禁/降级（P0-1、P1-4），不再把
        工具注入行、Ctrl+C、__ot_pad 注进落回来的裸壳。任一 OSC 标记到达即由
        _note_hook_mark 撤销陈旧判定（外层集成壳重画提示符＝自愈）。
        """
        if not self._interactive:
            return
        first = not self._hook_stale
        self._hook_stale = True       # _hook_ok 转假：注入/健康路径全降级
        self._last_mark_at = 0.0      # 死壳留下的旧时间戳不得再当活凭据
        self._cancel_hook_watch()
        fut = self._exec_future
        if fut is not None and not fut.done():
            # 明确错误立即收束，不等超时打 ^C（那也是落进裸壳的垃圾）
            fut.set_result(CommandResult(
                output=f"[ot] 远端 shell 已退出（{why}），命令未执行；"
                       f"请重新登录后重试",
                exit_code=CHANNEL_DEAD_EC, truncated=False, cwd=""))
        if first:
            await self.emit_msg(ServerMsg(
                type="status",
                text=f"远端 shell 已退出（{why}）：AI 工具执行不可用，"
                     f"请重新登录后重试"))

    async def _submit_fallback(self, t: str) -> None:
        """健康路径兜底：补发 \\r 后 hook AI 上报迟迟未到（重置误判/路由丢报）
        → 中断残行改走外部启动，保证任务不悬空。迟到的同文上报由
        _suppress_ai_report 吞掉，不会双跑。"""
        await asyncio.sleep(SUBMIT_FALLBACK_DELAY)
        if self._closed or self._hook_report_pending != t:
            return
        self._hook_report_pending = None
        self._suppress_ai_report = t
        if self.session is not None:
            self._arm_intr_swallow()   # 同降级路径：吞 ^C 回显残迹
            await self.session.send_raw(b"\x03")
            # 同降级路径：settle 躲开 SIGINT 恢复窗口的输入丢弃；不吞 ^C 回显
            # （吞掉会使前端光标失步，重发回显拼在旧行后）
            await asyncio.sleep(0.4)
        await self._on_ai_line(t)

    def _start_ai(self, line: str, hooked: bool = False) -> None:
        self._ai_ping_at = time.monotonic()   # 僵尸回收基准：任务起点即有锚
        self._ai_task = asyncio.create_task(self._ai_flow(line, hooked))

    async def _ai_flow(self, line: str, hooked: bool = False) -> None:
        try:
            if line.startswith("/"):
                if await self._handle_slash(line.strip()):
                    return
                # 未知斜杠命令（/clearn 打错字、无 +x 的 /x.sh）：不静默吞——
                # 落回正常任务（与 CLI 语义一致：未知 / 交 LLM 判定），否则
                # hook 蓝色重绘后用户零反馈（真机：以为终端卡死）
            text = line.lstrip("?").strip() or line
            await self._run_task(text, hooked)
        except asyncio.CancelledError:
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "error", "text": "已停止"}))
        except Exception as e:  # noqa: BLE001 - 兜底：前端靠 error 停表收卡片
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"处理失败：{type(e).__name__}: {e}"}))
        finally:
            self._ai_task = None
            try:
                await self._curtain_open()   # 任务收尾：扣住的提示符放行
            except Exception:                # noqa: BLE001 - 收尾放行不能盖错误
                pass
            if self._ai_queue and not self._closed:
                _q = self._ai_queue.pop(0)
                self._start_ai(_q[0], _q[1] if len(_q) > 1 else False)

    # --- Agent/Shell 显示模式切换 ---
    async def _switch_display(self, mode: str) -> None:
        _dbg("switch_display", mode, "cur=", self._display,
             "stack=", [(f["ctx"], f["inst"]) for f in self._exec_stack],
             "ai=", self._ai_task is not None)
        if mode not in ("ssh", "agent"):
            return
        if not self._interactive:
            self._display = mode
            return
        if mode == self._display:
            return
        if mode == "ssh":
            # 先停 AI 并等其工具执行收尾：开关行与 runner 的 \x15/注入
            # 序列交错会污染 PTY 输入缓冲（开关不生效）
            t = self._ai_task
            await self._maybe_cancel_ai()
            if t is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(t), 3)
                except Exception:  # noqa: BLE001 - 取消/超时都继续
                    pass
            if not await self._wait_exec_idle(5):
                await self.emit_msg(ServerMsg(
                    type="status",
                    text="AI 命令执行中，退出后再切 Shell 模式。"))
                return
            # su - / sudo su - / 嵌套 shell 会把 hook 集成整个丢掉:此时
            # toggle 的 __ot_exec__ 变普通命令执行(command not found),
            # 确认标记永不回来 → 下面死等 5s 才清屏(真机「切 Shell 没反应」)。
            # 先补注入(幂等,healthy shell 只重定义同名函数)再开关注入。
            await self._ensure_integrated()
            self._ev_exec_end.clear()
            self._suppress_live = True   # 开关注入行的回显吞掉（§5.5）
            try:
                await self.session.send_raw(toggle_line(self._shell_kind, False))
                try:
                    await asyncio.wait_for(self._ev_exec_end.wait(), 5)
                except asyncio.TimeoutError:
                    pass    # 开关未确认也切显示（hook off 失败时字节仍原样透传）
            finally:
                self._suppress_live = False
                self._suppressed_echo = False
            self._display = "ssh"
            await self.session.send_raw(b"\x0c")   # 清屏重画，纯透传从干净屏开始
        else:
            self._display = "agent"
            self._router.reset()
            self._ev_prompt.clear()
            # Shell 模式期间 pump 纯透传不产生标记事件，时间戳已失效；重置为
            # 保守态（标记绝迹）——首个自然语言提交走降级路径重注入确认 hook
            self._last_mark_at = 0.0
            self._hook_stale = False
            self._cancel_hook_watch()
            self._last_live_at = time.monotonic()
            self._suppress_live = True
            try:
                await self.session.send_raw(toggle_line(self._shell_kind, True))
                try:
                    await asyncio.wait_for(self._ev_prompt.wait(), 5)
                except asyncio.TimeoutError:
                    pass
            finally:
                self._suppress_live = False
                self._suppressed_echo = False
            await self.session.send_raw(b"\x0c")   # hook 已回 agent：清屏重画


class CorePresenter:
    """backend 的同步回调 → 执行登记/清理（显示由 exec 状态机直写主 xterm）。"""

    def __init__(self, worker: PipelineCore) -> None:
        self.w = worker

    def on_start(self, command: str) -> None:
        # 模型可能一轮并发发起多个工具调用（on_start 全部先到），而真实执行
        # 被 run 锁串行化——命令登记进队列，真实归属由 exec 状态机在 C 标记
        # 时弹出（保证 ai_collapse 与输出按真实执行顺序出现）
        self.w._pending_agent_cmds.append(command)

    def on_finish(self, command: str, exit_code: int) -> None:
        w = self.w
        if command in w._pending_agent_cmds:
            # 命令未执行（目标忙 / 执行前取消）：清理登记，否则下一个命令
            # 会错拿这条开 ai_collapse
            w._pending_agent_cmds.remove(command)
        elif w._agent_open_cmd == command:
            # 兜底 C 已到但 D 迟迟不到的超时路径（Ctrl+C 后 3s 宽限仍无 D）
            w._agent_open_cmd = None
