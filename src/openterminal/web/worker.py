"""一个 Web tab 的 ot REPL：单管线真终端 + AI 卡片事件（设计文档 §5）。

显示模型：PTY 字节是唯一显示管线——worker 除需吞除/记账的字节外，把
live/exec 相位文本原样转发给前端主 xterm；不做任何显示路由（无
term_open/commit/command_done、无直通活块、无嵌套 shell 状态机、无写死
提示符）。worker 只做三件事：

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
from dataclasses import replace

_OT_DBG = bool(os.environ.get("OT_WEB_DEBUG"))


def _dbg(*a) -> None:
    """OT_WEB_DEBUG=1 时打印交互式状态机轨迹（排障用，默认静默）。"""
    if _OT_DBG:
        print("[otdbg]", *a, flush=True)

from ..agent import build_agent, build_chat_model
from .. import cmdset
from .. import history_db
from ..config import Config, TargetConfig, app_dir
from ..connections import open_session
from ..history_db import HISTORY_RECALL_LIMIT
from ..policy import Policy

# 健康路径兜底：补发 \r 后等 hook AI 上报的最长时限（超时改走外部启动）
SUBMIT_FALLBACK_DELAY = 1.2

# 换壳探测（_probe_shell_kind）：等 __OTPROBE__ 输出的最长时限
_PROBE_TIMEOUT = 1.5


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
from ..secrets_store import load_password, store_password
from ..shell_integration import (
    StreamRouter, agent_exec_line, history_inject_line, injection_lines,
    is_internal_line,
    parse_probe, probe_command, toggle_line,
)
from ..shell_session import CommandResult
from ..sysprobe import (
    LOCAL_PROFILE, MANUAL_PRESETS, load_host_cache, probe_profile,
    save_host_cache,
)
from ..transcript import open_transcript
from .protocol import ClientMsg, ServerMsg, encode_server


class InteractiveRunner:
    """交互式模式的 AI 工具通道：为 PtyShellBackend 鸭子类型 ShellSession。

    工具命令经 ``__ot_exec__ `` 通道注入同一个 PTY（与用户共享 shell 状态：
    cd/环境变量/别名全部生效）；Ctrl+U / Ctrl+Y 括号保护用户已输入的半行。
    输出由泵按 EXEC 相位字节捕获并直写主 xterm，OSC 133 C…D 标记界定结束
    与退出码。超时发 Ctrl+C 中断再宽限 3s，仍无 D 标记则按 130 返回。
    """

    def __init__(self, worker: "TabWorker") -> None:
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
            w._exec_buf = bytearray()
            w._exec_truncated = False
            fut = asyncio.get_running_loop().create_future()
            w._exec_future = fut
            try:
                # 不吞回显：注入行的 tty 回显（明文时即青色命令本身）必须
                # 原样进 xterm——Windows ConPTY 按自己的缓冲区模型发绝对
                # 光标定位重绘，吞字节会让 xterm 光标与 ConPTY 失步（实测
                # 提示符叠印/内容覆盖的根因）
                await w.session.send_raw(b"\x15")     # 收纳用户半行输入
                await w.session.send_raw(
                    agent_exec_line(w._shell_kind, command, w._b64flag))
                try:
                    res = await asyncio.wait_for(asyncio.shield(fut), to)
                except asyncio.TimeoutError:
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


# --- 连接后命令集时序(模块级便于测试 monkeypatch 调小)---
CMDSET_ECHO_TIMEOUT = 2.0     # 等命令回显封顶(秒)
CMDSET_QUIET = 0.3            # 输出静默判定窗口(秒)
CMDSET_PROMPT_TIMEOUT = 10.0  # 等交互提示封顶(秒);超时跳过该应答行
CMDSET_RESUME_QUIET = 1.2     # 暂停等输入:提示消失后再静默此时长才继续(秒)
_CMDSET_PROMPT_RE = re.compile(
    r"(password|passphrase|密码|口令)\s*[:：]\s*$|\[sudo\]|yes/no|verification code",
    re.IGNORECASE)
# 密码类与确认类提示分开:@引用是密码,只能应答密码类——确认类(yes/no)
# 会回显输入,密码打上去就明文漏进终端(真机:跳转时 host key 确认先弹)。
# 明文应答(如 yes/y)两类都应答。
_CMDSET_SECRET_RE = re.compile(
    r"(password|passphrase|密码|口令)\s*[:：]\s*$|\[sudo\]", re.IGNORECASE)
_CMDSET_CONFIRM_RE = re.compile(r"yes/no|verification code", re.IGNORECASE)


class TabWorker:
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
        self._outbox: asyncio.Queue = asyncio.Queue()
        self._inbox: asyncio.Queue = asyncio.Queue()
        self._pws: asyncio.Queue = asyncio.Queue()      # 密码应答
        self._hks: asyncio.Queue = asyncio.Queue()      # 主机密钥应答
        self._decisions: asyncio.Queue = asyncio.Queue()  # 审批决策
        self._boundary_ack = asyncio.Event()  # 前端阶段结账完成（ai_boundary 门闩）
        self._pad_task: asyncio.Task | None = None  # 在途 pad 打字任务（门闩排序用）
        self._task: asyncio.Task | None = None
        self._target: TargetConfig | None = None   # _connect 时持有(命令集等读取)
        self._cs_tail: bytearray | None = None     # 命令集监听的输出滚动缓冲
        self._cs_task: asyncio.Task | None = None
        self._cs_resume = asyncio.Event()          # 「继续」按钮强制放行
        self._target_host = ""       # _connect 时填充
        self._target_user = ""
        self._sender: asyncio.Task | None = None
        self._pump: asyncio.Task | None = None
        self._closed = False
        self._closed_sent = False  # closed 消息已入 outbox（sender 退出门闩）
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
        self._probe_buf: bytearray | None = None  # 探测行输出收集（_probe_shell_kind）
        self._cur_prompt = ""        # 最近一次 B 标记捕获的提示符纯文本
        self._pending_report = None  # C 标记前最近的行报告 (inst, kind, line)
        self._open_cmds: dict[int, str] = {}  # 用户命令记账 inst -> line（退出码）
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
        self._ai_task: asyncio.Task | None = None
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
            await self._send_bytes("".join(parts).encode("utf-8", "replace"))

    def _curtain_close(self) -> None:
        if self._ai_task is None:
            return
        self._curtain = True
        self._curtain_parts = []
        self._curtain_at = time.monotonic()

    # --- 模型兜底分类（cli 共用形态；web 侧行分类由 hook 完成）---
    async def _llm_classify(self, text: str) -> str:
        from ..agent import message_text

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

    def detach(self, sink) -> None:
        if self._sink is sink:
            self._sink = None

    async def handle_client(self, msg: ClientMsg) -> None:
        if msg.type == "decision" and msg.decision is not None:
            await self._decisions.put(msg.decision)
        elif msg.type == "auth":
            if msg.auth_kind == "password":
                await self._pws.put(msg.text)
                if msg.remember:
                    self._store_auth_password(msg.text)
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
        await self._send_json(encode_server(ServerMsg(
            type="event", event={"kind": "ai_boundary"})))
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
            if not self._hook_ok():
                await self._send_json(encode_server(ServerMsg(
                    type="event", event={"kind": "padded", "rows": rows})))
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
        await self._send_json(encode_server(ServerMsg(
            type="event", event={"kind": "padded", "rows": rows})))

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
            self._ev_prompt.clear()
            self._suppress_live = True
            try:
                # 前置 \x15 收纳半行但不补 \x19 恢复：任务启动即丢弃该半行
                #（若 yank 回 kill ring 里的旧文本，会在提示符行复活污染输入）。
                # 探测行必须敲在干净提示符上——半行没清，探测行会拼在用户
                # 已敲文本后面整行执行。
                await self.session.send_raw(b"\x15")
                shell, flag = await self._probe_shell_kind()
                if shell is None:
                    self._hook_gone = True
                    return False
                self._hook_gone = False
                if shell != self._shell_kind:
                    self._shell_kind = shell
                    self._b64flag = flag
                for _ci, line in enumerate(
                        injection_lines(self._shell_kind, 1, self._b64flag)):
                    self._ev_stream.clear()
                    await self.session.send_raw(line)
                    # 逐片等本片回显到达再发下一片：固定短间隔会让分片堆进
                    # shell 执行间隙的 canonical 缓冲（4096 溢出丢块，真机实测
                    # 0.03s 间隔 md5 不复现）。回显即 readline 已读入本片的凭据；
                    # 回显绝迹（裸模式残影）时退回实测安全的 0.12s 间隔
                    try:
                        await asyncio.wait_for(self._ev_stream.wait(), 0.12)
                    except asyncio.TimeoutError:
                        pass
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
        ——hook 恰好在位时该行按内部行静默记账，不入历史、不占用户命令帧。
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
                ('_ot_inj=""; ' + probe_command(self.profile.os_family)
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
        # 解阻塞挂起的认证/审批等待（ask_* 收到 None 视为已关闭）
        for q in (self._pws, self._hks, self._decisions):
            q.put_nowait(None)
        # 先等泵真正退出再关 session：只 cancel 不等的话，泵可能正压在
        # _read_some 上，fd 被关掉后抛 ValueError 成为未取回异常
        await self._stop_pump()
        if self.session is not None:
            await self.session.close()
        await self._send_json(encode_server(ServerMsg(type="closed", text="已关闭")))
        self._closed_sent = True   # 排空 backlog 后 sender 才允许退出
        # 唤醒 _run 的 inbox 等待（若 close 来自外部调用）；dispatch 到 close 幂等返回
        self._inbox.put_nowait(ClientMsg(type="close"))
        # _run/_sender 各自在 _closed 后自然退出（见 _run / _sender_loop），
        # 不 cancel 当前任务——close 常在 _run 内部被调用，cancel 会打断自己

    # --- 认证回调（供 SshPtySession 注入）---
    async def ask_password(self, label: str, auth_kind: str = "") -> str:
        await self._send_json(encode_server(ServerMsg(
            type="ask_password", label=label, auth_kind=auth_kind)))
        val = await self._pws.get()
        if val is None:
            raise ConnectionError("连接已关闭")
        return val

    async def ask_host_key(self, message: str) -> bool:
        await self._send_json(encode_server(ServerMsg(type="ask_host_key", message=message)))
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
        await self._send_json(encode_server(ServerMsg(
            type="approval", command=command, reasons=reasons, host=host,
            risk=risk)))
        val = await self._decisions.get()
        if val is None:
            raise ConnectionError("连接已关闭")
        return val

    # --- 输出：全部经 outbox 串行（保持顺序）---
    async def _send_json(self, text: str) -> None:
        await self._outbox.put(("json", text))

    async def _send_bytes(self, data: bytes) -> None:
        await self._outbox.put(("bytes", data))

    async def _sender_loop(self) -> None:
        while True:
            kind, payload = await self._outbox.get()
            sink = self._sink
            if sink is not None:
                try:
                    if kind == "bytes":
                        await sink.send_bytes(payload)
                    else:
                        await sink.send_text(payload)
                except Exception:
                    continue
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
            await self._send_json(encode_server(ServerMsg(
                type="closed", text=f"连接失败：{type(e).__name__}: {e}")))
            self._closed = True  # sender 据此排空后退出，避免协程泄漏
            self._closed_sent = True
            return
        self.connected.set()
        await self._send_json(encode_server(ServerMsg(
            type="ready", tab_id=self.tab_id,
            host=self._target_host, user=self._target_user,
            distro=self.profile.distro or "",
            prompt=self._cur_prompt,
            model=self._model.model, models=self._models,
            interactive=1 if self._interactive else 0)))
        if self._interactive:
            hint = ("shell 集成已就绪：按键直达终端（Tab 补全 / ↑ 历史 / Ctrl+R 搜索"
                    "原生可用）；命令直接执行，自然语言交给 AI；? 前缀强制 AI，"
                    "! 前缀强制执行命令。")
        else:
            hint = "纯终端直通（未检测到可集成的 shell）：按键直达终端。"
        await self._send_json(encode_server(ServerMsg(
            type="status",
            text=f"已连接 {self._target_host}"
                 f"（{self.profile.distro or self.profile.os_family}）。{hint}")))
        self._pump = asyncio.create_task(self._pump_loop())
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
                await self._send_json(encode_server(ServerMsg(
                    type="status", text=f"处理出错：{type(e).__name__}: {e}")))

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
        self.agent, self.allowed, self.backend = build_agent(
            self.profile, self._agent_session(), self.cfg, self.policy,
            model=build_chat_model(self._model))

    def _agent_session(self):
        """agent 工具执行用的会话：交互式 = InteractiveRunner（同 PTY 注入），
        否则原始 session（哨兵批处理，仅记账，无 AI 输入通道）。"""
        return self._runner if self._interactive else self.session

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
        return bytes(self._cs_tail or b"").decode("utf-8", "replace")

    def _cs_lastline(self) -> str:
        return self._cs_text().rsplit("\n", 1)[-1]

    async def _cs_pause_for_input(self) -> None:
        """命令执行后终端停在交互提示、又没有应答行接管 → 暂停等用户输入。

        用户直接在终端输(密码不回显),提示消失且静默 RESUME_QUIET 后
        自动继续;前端「继续」按钮(cmdset_resume)随时强制放行。输错
        密码导致提示重现时保持暂停。
        """
        if not _CMDSET_PROMPT_RE.search(self._cs_lastline()):
            return
        self._cs_resume.clear()
        paused = False
        while not self._closed:
            if not _CMDSET_PROMPT_RE.search(self._cs_lastline()):
                # 提示消失:再静默一小段确认(密码错会重新提示,别抢跑)
                try:
                    await asyncio.wait_for(self._cs_resume.wait(),
                                           CMDSET_RESUME_QUIET)
                    return                    # 用户点继续:强制放行
                except asyncio.TimeoutError:
                    if not _CMDSET_PROMPT_RE.search(self._cs_lastline()):
                        return
                    continue                  # 提示重现(输错了):继续等
            if not paused:
                paused = True
                await self._send_json(encode_server(ServerMsg(
                    type="cmdset", state="paused")))
            try:
                await asyncio.wait_for(self._cs_resume.wait(), 0.2)
                return                        # 提示未消失也放行:用户明示继续
            except asyncio.TimeoutError:
                pass

    async def _run_command_set(self) -> None:
        lines = [l for l in (self._target.commands if self._target else [])
                 if l.strip() and not l.lstrip().startswith("#")]
        total = len(lines)
        try:
            for i, line in enumerate(lines, 1):
                if self._closed:
                    return
                await self._send_json(encode_server(ServerMsg(
                    type="cmdset", state="running", index=i, total=total)))
                if line.lstrip().startswith(">"):
                    await self._cs_answer(line.strip()[1:].strip())
                else:
                    await self._cs_pause_for_input()
                    await self._cs_command(line.strip())
            await self._send_json(encode_server(ServerMsg(
                type="cmdset", state="done", index=total, total=total)))
        except asyncio.CancelledError:
            raise
        except ConnectionError:
            return  # 弹窗等待期间连接关闭:静默退出,close 流程已接管
        finally:
            self._cs_tail = None   # runner 退出即停缓冲(pump 钩子归零)

    async def _cs_command(self, cmd: str) -> None:
        """命令行:写入 PTY,等回显再等输出静默(自回显起封顶 ECHO_TIMEOUT)。

        不在结束时清 tail:密码提示常与命令回显同批到达(快网络),
        后续应答行要能继承这段输出继续匹配。
        """
        self._cs_tail = bytearray()
        await self.session.send_raw((cmd + "\r").encode())
        deadline = time.monotonic() + CMDSET_ECHO_TIMEOUT
        while time.monotonic() < deadline and cmd not in self._cs_text():
            await asyncio.sleep(0.02)
        quiet_deadline = time.monotonic() + CMDSET_ECHO_TIMEOUT
        last = -1
        while time.monotonic() < quiet_deadline:
            if len(self._cs_tail) != last:
                last = len(self._cs_tail)
                await asyncio.sleep(CMDSET_QUIET)   # 有新字节:再等一个静默窗
            else:
                break                               # 静默期满:命令大概率跑完

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
                    await self._send_json(encode_server(ServerMsg(
                        type="status",
                        text=f"命令集：@{name} 未输入密码，已跳过自动应答")))
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
                    await asyncio.sleep(CMDSET_QUIET)   # 密码不回显,静默即稳
                    return
                await asyncio.sleep(0.05)
            await self._send_json(encode_server(ServerMsg(
                type="status", text="命令集：未检测到交互提示，已跳过自动应答")))
        finally:
            self._cs_tail = None

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

    # --- 按键 / AI 取消 ---
    async def _on_keys(self, data: bytes) -> None:
        """键盘字节直发 PTY（§5.4：单管线下 AI 工作时用户照样敲命令；
        AI 注入的 Ctrl+U/Ctrl+Y 括号保护覆盖唯一竞争点——真提示符半行）。"""
        if self.session is None or not data:
            return
        _dbg("keys=", repr(data[:60]))
        if self._interactive and b"\x03" in data:
            await self._maybe_cancel_ai()
        await self.session.send_raw(data)

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

    async def _handle_slash(self, line: str) -> bool:
        """斜杠命令处理；返回 True 表示已消费（经 hook AI 报告进入）。"""
        if line == "/help":
            await self._send_json(encode_server(ServerMsg(
                type="status",
                text="/target 切换主机  /clear 清屏新任务  /model 查看模型"
                     "  /system 手动设系统方言  /exit 关闭会话")))
            return True
        if line == "/model":
            await self._send_json(encode_server(ServerMsg(
                type="status",
                text=f"{self.cfg.model.model} @ {self.cfg.model.base_url}")))
            return True
        if line == "/exit":
            await self.close()
            return True
        if line == "/clear":
            self.transcript = open_transcript(self.tab_id)
            await self._send_json(encode_server(ServerMsg(
                type="status", text="已开启新任务。")))
            # 通知前端清掉本会话的全部 AI 卡片
            await self._send_json(encode_server(ServerMsg(
                type="event", event={"kind": "session_cleared"})))
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
        from ..agent import TaskRunner

        # hook 上报触发的任务不重注入：上报即在位凭据，而注入吞窗口会吃掉
        # 在途蓝色重绘字节（真机「提交行消失」）；外部启动（无上报）才需要
        if not hooked:
            await self._ensure_integrated()   # su - 等 login shell 重置后先重注入
        self.transcript.append("user", text=text)
        self._task_cmd_started = False
        await self._send_json(encode_server(ServerMsg(
            type="event", event={"kind": "task_start", "text": text})))
        presenter = _WebPresenter(self)
        self.backend.on_start = presenter.on_start
        self.backend.on_output = None   # 输出由 exec 状态机直写主 xterm
        self.backend.on_finish = presenter.on_finish
        self.backend.on_boundary = self._boundary_gate

        def _live(ev) -> None:
            if ev.kind == "token":
                self._outbox.put_nowait(("json", encode_server(ServerMsg(
                    type="event",
                    event={"kind": "ai_token", "text": ev.text}))))
            elif ev.kind == "think":
                self._outbox.put_nowait(("json", encode_server(ServerMsg(
                    type="event",
                    event={"kind": "ai_think", "text": ev.text}))))
            elif ev.kind == "denied":
                self._outbox.put_nowait(("json", encode_server(ServerMsg(
                    type="event", event={"kind": "denied", "text": ev.text}))))
            elif ev.kind == "limit":
                self._outbox.put_nowait(("json", encode_server(ServerMsg(
                    type="event", event={"kind": "limit", "text": ev.text}))))
            elif ev.kind == "error":
                self._outbox.put_nowait(("json", encode_server(ServerMsg(
                    type="event", event={"kind": "error", "text": ev.text}))))

        runner = TaskRunner(
            self.agent, self.tab_id,
            max_tool_turns=self.cfg.shell.max_tool_turns,
            on_event=_live,
        )
        try:
            events = await runner.run(text)
            await self._handle_events(runner, events)
        except Exception as e:  # noqa: BLE001 - 任务异常发 error 事件让前端收尾
            # 不能只靠 _run 兜底的 status——前端靠 error/final 停计时、收卡片
            await self._send_json(encode_server(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"任务失败：{type(e).__name__}: {e}"})))
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
            await self._send_json(encode_server(ServerMsg(
                type="usage", tokens_in=self._tokens_in,
                tokens_out=self._tokens_out,
                estimated=not (runner.input_tokens or runner.output_tokens))))

    async def _change_model(self, model_id: str) -> None:
        """运行时切换模型：用新 ModelConfig 重建 agent（保留 profile/session）。"""
        if not model_id or model_id == self._model.model:
            return
        if self.agent is None:
            return
        self._model = replace(self._model, model=model_id)
        try:
            self.agent, self.allowed, self.backend = build_agent(
                self.profile, self._agent_session(), self.cfg, self.policy,
                model=build_chat_model(self._model))
            await self._send_json(encode_server(ServerMsg(
                type="status", text=f"已切换模型：{model_id}")))
        except Exception as e:  # noqa: BLE001 - 切换失败提示，不影响会话
            await self._send_json(encode_server(ServerMsg(
                type="status", text=f"切换模型失败：{type(e).__name__}: {e}")))

    async def _handle_events(self, runner, events) -> None:
        while True:
            for ev in events:
                if ev.kind == "tool_call":
                    self.transcript.append("tool_call", command=ev.command)
                elif ev.kind == "denied":
                    self.transcript.append("denied", text=ev.text)
                elif ev.kind in ("limit", "error"):
                    return
                elif ev.kind == "final":
                    self.transcript.append("final", text=ev.text)
                    await self._send_json(encode_server(ServerMsg(
                        type="event",
                        event={"kind": "final", "text": ev.text})))
                    # final 总结 markdown → 前端挂总结装饰卡（§5.3）
                    await self._send_json(encode_server(ServerMsg(
                        type="event",
                        event={"kind": "ai_card", "markdown": ev.text})))
            if runner.interrupt_payload is None:
                return
            requests = runner.interrupt_payload["action_requests"]
            if len(requests) > 1:
                await self._send_json(encode_server(ServerMsg(
                    type="status", text=f"模型一轮发起 {len(requests)} 个命令，请逐个确认")))
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
        from ..connections import list_ssh_hosts, load_saved_targets

        names = list(dict.fromkeys(
            ["local"] + [t.name for t in load_saved_targets()] + list_ssh_hosts()))
        parts = line.split(maxsplit=1)
        arg = parts[1] if len(parts) == 2 else ""
        if not arg:
            await self._send_json(encode_server(ServerMsg(
                type="status", text="可用目标：" + ", ".join(names))))
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
            await self._send_json(encode_server(ServerMsg(
                type="status", text=f"切换目标失败：{type(e).__name__}: {e}")))
            return
        await self._send_json(encode_server(ServerMsg(
            type="ready", tab_id=self.tab_id, host=self._target_host,
            user=self._target_user, distro=self.profile.distro or "",
            prompt=self._cur_prompt,
            interactive=1 if self._interactive else 0)))
        self._pump = asyncio.create_task(self._pump_loop())
        if self._interactive:
            await self.session.send_raw(b"\x0c")

    def _register_target(self, text: str) -> str:
        from ..config import TargetConfig
        from ..connections import load_saved_targets, parse_user_at_host

        if text in self.cfg.targets or text in {"local", "default"}:
            return text
        # 记住的连接按 name 直接注册（含 host/user/port/jump），否则 ad-hoc 重建
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
        from ..sysprobe import MANUAL_PRESETS

        parts = line.split()
        if len(parts) < 2 or parts[1] not in MANUAL_PRESETS:
            await self._send_json(encode_server(ServerMsg(
                type="status", text="可选：" + ", ".join(MANUAL_PRESETS))))
            return
        self.profile = replace(self.profile, **MANUAL_PRESETS[parts[1]])
        self.agent, self.allowed, self.backend = build_agent(
            self.profile, self._agent_session(), self.cfg, self.policy,
            model=build_chat_model(self._model))
        await self._send_json(encode_server(ServerMsg(
            type="status", text=f"系统方言已手动设为 {parts[1]}")))

    async def _pump_loop(self) -> None:
        """PTY 泵：回退/Shell 模式纯透传；集成模式下按 OSC 标记切分——
        标记字节与需吞除的注入回显不外发，其余原样转发（唯一显示管线）。"""
        while not self._closed:
            try:
                data = await self.session._read_some(0.2)
            except asyncio.TimeoutError:
                continue
            except (ConnectionError, EOFError):
                await self._pump_eof("连接已断开")
                return
            if data == b"":     # 本地 PTY 读者线程的 EOF 哨兵（如用户 exit）
                await self._pump_eof("会话已结束")
                return
            if not data:
                continue
            if self._cs_tail is not None:
                self._cs_tail.extend(data)
                if len(self._cs_tail) > 8192:
                    del self._cs_tail[:-8192]   # 只留尾部:提示匹配只需最近输出
            if not self._interactive or self._display == "ssh":
                await self._send_bytes(data)   # 回退模型 / Shell 模式：纯透传
                continue
            for ev in self._router.feed(data):
                await self._on_stream_event(ev)

    async def _pump_eof(self, text: str) -> None:
        if self._ai_task is not None:
            self._ai_queue.clear()
            self._ai_task.cancel()
        await self._send_json(encode_server(ServerMsg(type="closed", text=text)))

    # --- 集成模式：标记流事件 ---
    async def _on_stream_event(self, ev: tuple) -> None:
        kind = ev[0]
        _dbg("ev", kind, "sup=", self._suppress_live,
             (ev[1][:60] if isinstance(ev[1], str) else ev[1:])
             if kind in ("live", "exec", "prompt") else ev[1:])
        if kind == "live":
            self._ev_stream.set()   # 回显到达：重注入分片的逐片应答凭据
            if self._probe_buf is not None:
                self._probe_buf.extend(ev[1])
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
                await self._send_bytes(ev[1].encode("utf-8", "replace"))
        elif kind == "exec":
            self._ev_stream.set()
            if self._probe_buf is not None:
                self._probe_buf.extend(ev[1].encode("utf-8", "replace"))
            await self._on_exec_text(ev[1])
        elif kind == "prompt_start":
            self._ev_prompt.set()   # 模式切换等提示符重画
            self._last_mark_at = time.monotonic()
            # 任务运行期关帘：这段提示符重绘扣住不发——前端流式卡期间底部
            # 不出现空提示符（用户诉求：对话完全结束才显示命令提示符）
            self._curtain_close()
        elif kind == "prompt":
            self._cur_prompt = ev[1]
            self._last_mark_at = time.monotonic()
        elif kind == "report":
            self._last_mark_at = time.monotonic()
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
            self._last_mark_at = time.monotonic()
            await self._on_exec_start(ev[1])
        elif kind == "exec_end":
            self._last_mark_at = time.monotonic()
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
                await self._send_json(encode_server(ServerMsg(
                    type="event",
                    event={"kind": "ai_collapse", "command": cmd})))

    async def _close_suppressed_line(self) -> None:
        """注入窗口吞过回显时补一个换行收束提示符行（§5.5）：前端看不到
        被吞的注入行，不补换行的话命令输出会接在提示符同一行。"""
        if self._suppressed_echo:
            self._suppressed_echo = False
            await self._send_bytes(b"\r\n")

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
                await self._send_bytes(raw)   # 输出直写主 xterm（§5.3）
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
            await self._send_bytes(text.encode("utf-8", "replace"))

    async def _on_exec_end(self, inst: int, ec, cwd) -> None:
        _dbg("exec_end inst=", inst, "ec=", ec, "stack=",
             [(f["ctx"], f["inst"]) for f in self._exec_stack])
        self._ev_exec_end.set()
        if cwd and self._runner is not None:
            self._runner.cwd = cwd
        if inst in self._open_cmds:
            line = self._open_cmds.pop(inst)
            if line:
                self.transcript.append("direct", command=line, exit_code=ec)
            if not self._open_cmds:
                # 嵌套 shell（su - 等）退出：外层 hook 的标记/函数从未丢过，
                # 复位换壳判定，健康路径/pad 恢复
                self._hook_gone = False
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
        await self._send_json(encode_server(ServerMsg(type="event", event={
            "kind": "rescue", "line": line, "ec": ec, "output": out})))

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

    async def _on_frontend_line(self, text: str, dirty: bool = False) -> None:
        """外部触发链：前端在 agent 模式拦下的整行。

        健康路径（hook 在位 + shell 空闲在提示符）：补发回车——hook 的 AI 分支
        原地把默认色回显重画为「提示符+蓝色文本」（§5.6 Workbench 观感：用户
        输入蓝、工具命令青）、记入 history，再以 6337 AI 上报触发任务（上报即
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
        走 AI 流。工具命令执行中不动终端，只透传回车。"""
        if self.session is None:
            return
        t = text.strip()
        _dbg("submit text=", repr(t[:60]), "dirty=", dirty,
             "exec_busy=", self._exec_future is not None,
             "open_cmds=", len(self._open_cmds))
        if not t or self._exec_future is not None or not _looks_ai(t):
            await self.session.send_raw(b"\r")
            return
        if self._interactive and self._hook_ok() and not self._open_cmds:
            await self.session.send_raw(b"\r")
            if not dirty:
                self._hook_report_pending = t
                self._fallback_task = asyncio.create_task(self._submit_fallback(t))
            return
        # 降级路径：先 Ctrl+C 丢弃已回显半行（不能用 \x15/^U：kill 进 kill
        # ring 的文本会被后续注入序列收尾的 \x19/^Y yank 回提示符行），再尝试
        # 重注入（su - 重置是主因）——成功则把整行重发进 hook：蓝色回显 + 6337
        # 上报触发，与健康路径同一条 proven 链路，用户看得见自己的输入；重注入
        # 失败才回退外部启动（静默不回显）。工具命令执行中不动终端，只透传回车。
        await self.session.send_raw(b"\x03")
        # readline 的 SIGINT 恢复窗口（^C 回显 + 退格重画）会丢弃期间到达的
        # 输入：紧贴 ^C 写分片会丢 chunk0 头部（真机实测：解码脚本缺字节、注释行
        # 断成命令报 "对策: …: command not found"；settle 0.4s 后消失）。
        # 不吞 ^C 回显与提示符重画：吞掉会让前端光标与 PTY 失步（真实光标已换
        # 行），随后整行重发的回显拼在旧行首段回显后 = 「同一行输入重复两遍」。
        # 主屏留中断残迹比光标错乱诚实；分片回显的吞窗口由 _ensure_integrated
        # 自管（自带 try/finally 复位）
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
        的标记与函数从未丢过，自然恢复在位。"""
        return (self._interactive and not self._hook_gone
                and self._last_mark_at > 0)

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
            await self.session.send_raw(b"\x03")
            # 同降级路径：settle 躲开 SIGINT 恢复窗口的输入丢弃；不吞 ^C 回显
            # （吞掉会使前端光标失步，重发回显拼在旧行后）
            await asyncio.sleep(0.4)
        await self._on_ai_line(t)

    def _start_ai(self, line: str, hooked: bool = False) -> None:
        self._ai_task = asyncio.create_task(self._ai_flow(line, hooked))

    async def _ai_flow(self, line: str, hooked: bool = False) -> None:
        try:
            if line.startswith("/"):
                await self._handle_slash(line.strip())
                return
            text = line.lstrip("?").strip() or line
            await self._run_task(text, hooked)
        except asyncio.CancelledError:
            await self._send_json(encode_server(ServerMsg(
                type="event", event={"kind": "error", "text": "已停止"})))
        except Exception as e:  # noqa: BLE001 - 兜底：前端靠 error 停表收卡片
            await self._send_json(encode_server(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"处理失败：{type(e).__name__}: {e}"})))
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
                await self._send_json(encode_server(ServerMsg(
                    type="status",
                    text="AI 命令执行中，退出后再切 Shell 模式。")))
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


class _WebPresenter:
    """backend 的同步回调 → 执行登记/清理（显示由 exec 状态机直写主 xterm）。"""

    def __init__(self, worker: TabWorker) -> None:
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
