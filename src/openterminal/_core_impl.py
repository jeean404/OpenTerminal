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
from typing import Callable


_OFFLINE_CAP = 500   # 断线期缓存的 JSON 控制帧上限（防长期断线涨内存）


def _dbg(*a) -> None:
    """OT_WEB_DEBUG=1 时打印交互式状态机轨迹（排障用，默认静默）。"""
    if _OT_DBG:
        print(f"[otdbg +{time.monotonic() - _OT_T0:7.3f}s]", *a, flush=True)

from . import cmdset
from . import history_db
from .config import Config, TargetConfig, app_dir
from .connections import (
    PW_STORE_FAIL_HINT, display_name, open_session, parse_user_at_host)
from .history_db import HISTORY_RECALL_LIMIT
from .policy import Policy
from .core.messages import (
    CHANNEL_DEAD_EC, CHANNEL_DEAD_MSG, ClientMsg, InteractiveRunner,
    PasswordCancelled, ServerMsg, _ANSI_RE, _ansi_free, _dbg,
    _PROBE_TIMEOUT,
)

# 健康路径兜底：补发 \r 后等 hook AI 上报的最长时限（超时改走外部启动）
SUBMIT_FALLBACK_DELAY = 1.2


# 嵌套密码验证窗口：密码打进 PTY 后 hold 前端输入的时长上限（auth 结果输出
# 到达即提前结束）；超时视为已resolved，防输入被永久 hold
_PW_VERIFY_TIMEOUT = 3.0
# hold 释放防抖：auth 结果输出后稍等再放——隧道合包可能把 deny 与重讨提示符
# 拆成两块，即放会让抢跑命令打进新密码位
_PW_HOLD_RELEASE = 0.25
# 手输密码验证成功后的「记住」询问防抖（P1-3/P1-4）：等一拍让迟到的 deny/
# 重讨提示落地再问——「只落本次验证通过的密码」，错密拆块到达也不误问
_PW_REMEMBER_DELAY = 0.45
# 验证失败指纹：auth 结果输出出现即判失败——错密不进库、不弹记忆询问。
# 英文覆盖 OpenSSH（Permission denied）/sudo（Sorry, try again / incorrect
# password）原文，中文兜部分本地化；成功输出不含这些字样（bytes 字面量
# 不能含非 ASCII，中文段 str 编码拼接——同 _PASSWORD_PROMPT_RE）
_PW_AUTH_FAIL_RE = re.compile(
    rb"permission denied|sorry, try again|authentication fail"
    rb"|incorrect password|" + "密码错误|口令错误".encode(),
    re.IGNORECASE)
# AI 僵尸任务静默上限：_ai_task 存活但长时间零产出（无 ai_token/think/tool、
# 无非遇抑 echo）→ 按僵尸回收。触发场景：任务卡在某个等不住的 await 上一直
# 不归 None，使提示符幕帘在每次 prompt_start 重新关帘（见 _curtain_close），
# shell 重绘的新提示符永被扣住 → 底行目录冻结「像写死」。回收后 finally 自动
# 清 _ai_task 并开帘，提示符即刻恢复。取长值防空转思考被误杀。
_AI_ZOMBIE_T = 180.0
_PW_MODAL_DISMISS = 0.5   # 密码提示符被消费后陈旧模态的代关防抖


# 注入期续行提示符指纹（zsh PS2）：回显流里出现即判定输入字节被行规程丢弃、
# 引号失配，shell 卡在续行等补引号——setup 注入竞态的自愈触发点
_PS2_ECHO_RE = re.compile(rb"(?:quote|dquote|cmdsubst)> ")


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
from .secrets_store import load_password_alias as _load_password_alias_impl


def load_password_alias(host: str, user: str | None, port: int | None) -> str | None:
    """首跳（_connect）与嵌套（_load_nested_password）共用的凭据读取：
    None/22 端口别名互查，规范实现在 secrets_store.load_password_alias。

    这里只做透传并把本模块的 load_password 全局当读函数传入——读取永远
    走 core.load_password 这个名字，wmod 桥转发的测试 monkeypatch
    （test_web_worker/test_term_frontend）语义不变。
    """
    return _load_password_alias_impl(host, user, port, load=load_password)


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


class PipelineCore:
    # pad 指纹扫描窗开关：类级默认 False——测试可直接构造实例不跑 __init__，
    # live 分支读它时属性必须存在
    _pad_inflight = False

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
        self._outbox: asyncio.Queue = asyncio.Queue()
        self._inbox: asyncio.Queue = asyncio.Queue()
        self._pws: asyncio.Queue = asyncio.Queue()      # 密码应答
        self.auth   # noqa: B018 — 密码状态机组件：触达 lazy 属性即建 _pw_* 状态（core/auth.py）
        self.exec   # noqa: B018 — 标记流/注入/幕帘组件：触达 lazy 属性即建 _exec_*/_curtain 等状态（core/exec_events.py）
        self.hook   # noqa: B018 — hook 集成/验活组件：触达 lazy 属性即建 _hook_*/_interactive 等状态（core/hook_gate.py）
        self.cs    # noqa: B018 — 连接后命令集组件：触达 lazy 属性即建 _cs_* 状态（core/cmdset_runner.py）
        self._hks: asyncio.Queue = asyncio.Queue()      # 主机密钥应答
        self._decisions: asyncio.Queue = asyncio.Queue()  # 审批决策
        # 未决审批记账：审批帧只发一次，WS 断隙/刷新即丢，core 会永久等决策
        # （= 任务假死，真机 2026-10-06）；attach 重挂时据此补发
        self._pending_approval: ServerMsg | None = None
        # 断线期攒下的 JSON 控制帧（终局/用量/状态…）：PTY 字节帧照旧丢，
        # 控制帧丢了前端就永久收不到任务收尾（真机「AI 正在思考」不收）
        self._offline: list = []
        self._boundary_ack = asyncio.Event()  # 前端阶段结账完成（ai_boundary 门闩）
        self._task: asyncio.Task | None = None
        self._target: TargetConfig | None = None   # _connect 时持有(命令集等读取)
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
        self._display = "agent"      # agent = hook 集成 / ssh = 纯透传（Shell 模式）
        self._router: StreamRouter | None = None
        self._exec_future = None     # InteractiveRunner 等待 D 标记的 future
        self._ai_task: asyncio.Task | None = None
        self._ai_ping_at = 0.0  # AI 任务最近一次有产出（_live）的时间戳，僵尸判据
        self._ai_queue: list = []           # AI 忙时排队 (line, hooked)
        self._suppress_ai_report: str | None = None    # 兜底已启动后迟到的重复上报
        self._fallback_task: asyncio.Task | None = None  # _submit_fallback 句柄（测试/关闭可取消）
        # --- 失败救援（分类判 CMD 就直接执行；失败即信号，一键交 AI）---
        self._rescue_open = False     # 救援卡待决策（同时最多一张，防连败刷屏）
        self._rescue_ctx: tuple | None = None   # (line, ec, output)：决策时的任务上下文
        self._runner: InteractiveRunner | None = None
        self._runner_lock = asyncio.Lock()
        self._ev_prompt = asyncio.Event()    # 模式切换：等提示符重画
        # 任意流字节（live/exec 回显）到达信号：重注入分片逐片等回显做应答
        # （固定短间隔会在 shell 执行间隙把分片堆进 canonical 缓冲溢出丢块）
        self._ev_stream = asyncio.Event()
        self._pump_phase = "read"   # 排障：泵当前所处 stage（心跳打出）
        self._ev_exec_end = asyncio.Event()  # 模式切换：等 toggle 的 D 标记

    @property
    def nested(self) -> "NestedSshTracker":
        """嵌套 SSH 帧解析组件（无状态，惰性建以兼容裸构造测试实例）。"""
        from .core.nested_ssh import NestedSshTracker  # 局部导入：core/__init__ 反向转发本模块，模块级导入成环
        n = self.__dict__.get("_nested")
        if n is None:
            n = NestedSshTracker(self)
            self.__dict__["_nested"] = n
        return n

    @property
    def auth(self) -> "AuthFlow":
        """密码状态机组件（Task 3）：惰性建以兼容裸构造测试实例。"""
        a = self.__dict__.get("_auth")
        if a is None:
            from .core.auth import AuthFlow
            a = AuthFlow(self)
            self.__dict__["_auth"] = a
        return a

    @property
    def exec(self) -> "ExecEvents":
        """标记流/注入/幕帘组件（Task 4）：惰性建以兼容裸构造测试实例。"""
        e = self.__dict__.get("_exec_events")
        if e is None:
            from .core.exec_events import ExecEvents
            e = ExecEvents(self)
            self.__dict__["_exec_events"] = e
        return e

    @property
    def hook(self) -> "HookGate":
        """hook 集成/验活组件（Task 5）：惰性建以兼容裸构造测试实例。"""
        h = self.__dict__.get("_hook_gate")
        if h is None:
            from .core.hook_gate import HookGate
            h = HookGate(self)
            self.__dict__["_hook_gate"] = h
        return h

    @property
    def cs(self) -> "CmdsetRunner":
        """连接后命令集组件（Task 6）：惰性建以兼容裸构造测试实例。"""
        c = self.__dict__.get("_cmdset_runner")
        if c is None:
            from .core.cmdset_runner import CmdsetRunner
            c = CmdsetRunner(self)
            self.__dict__["_cmdset_runner"] = c
        return c

    # --- 过渡委托（tests/ 引用旧名；Task 9/10 迁移测试后删除）---
    @staticmethod
    def _parse_ssh_cmd_target(line: str
                              ) -> tuple[str | None, str | None, int | None] | None:
        from .core.nested_ssh import NestedSshTracker
        return NestedSshTracker.parse_ssh_cmd_target(line)

    def _innermost_ssh_frame(self) -> int | None:
        return self.nested.innermost_ssh_frame()

    def _inner_ssh_prompt_live(self) -> bool:
        return self.nested.inner_ssh_prompt_live()

    def _nested_ssh_target(self) -> tuple[str | None, str | None, int | None]:
        return self.nested.nested_ssh_target()

    def _ssh_frame_host(self) -> str | None:
        return self.nested.ssh_frame_host()

    def _sudo_pw_key(self) -> tuple[str, str, int | None] | None:
        return self.nested.sudo_pw_key()

    # --- Agent 输入框斜杠命令 ---
    def _is_pwsh(self) -> bool:
        return self.profile is not None and \
            "powershell" in (self.profile.shell or "").lower()

    # --- 提示符幕帘（任务期扣住提示符重绘，注入/收尾放行）---

    # --- 模型兜底分类（cli 共用形态；web 侧行分类由 hook 完成）---
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
                # 内联手输的密码留档：ready 后前端确认「记住」时回读写库
                # （password_remember 不携明文，避免密码再回流一遍）
                self._pw_last_entered = msg.text
                await self._pws.put(msg.text)
                if msg.remember and not self.auth.store_auth_password(msg.text):
                    await self.emit_msg(ServerMsg(
                        type="status", text=PW_STORE_FAIL_HINT))
            elif msg.auth_kind == "password_remember":
                # 手输密码登录成功后的「记住」确认：与弹窗勾选记住同键写 keyring
                if getattr(self, "_pw_last_entered", "") and \
                        not self.auth.store_auth_password(self._pw_last_entered):
                    await self.emit_msg(ServerMsg(
                        type="status", text=PW_STORE_FAIL_HINT))
            elif msg.auth_kind == "password_cancel":
                # 终端内联密码输入的 Ctrl+C：中止认证等待（等同连接关闭），
                # ask_password 抛 PasswordCancelled → 前端显示「连接已取消」
                self._pw_cancelled = True
                await self._pws.put(None)
            elif msg.auth_kind == "nested_password":
                # 嵌套 ssh/sudo 密码提示符的模态代答：打进 PTY 而非认证队列
                await self.auth._on_nested_password(msg.text, msg.remember)
            elif msg.auth_kind == "remember_yes":
                # 手输密码验证成功后的「记住」询问应答：按留档键写 keyring
                await self.auth._finish_remember(True)
            elif msg.auth_kind == "remember_no":
                await self.auth._finish_remember(False)
            elif msg.auth_kind == "nested_password_cancel":
                # 模态取消/点遮罩：用户改终端手输密码，立即退出验证窗口
                # （否则手输的密码被 hold 到 _PW_VERIFY_TIMEOUT 才放行）；
                # 已 hold 的抢跑输入不丢，仍等 auth 结果输出后依序释放
                self.auth._end_pw_verify()
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
            if self.session is None:
                return
            if not self._interactive:
                # 直通模式（hook 注入失败/不可集成）没有 __ot_pad 通道：立即
                # ack（宁藏不盖，卡由显隐/夹紧逻辑兜底）。旧实现静默丢弃 →
                # 前端 _padWait 烧满 8s 超时才放行挂卡（直通下分析卡迟到
                # 8s 的根因）
                await self.emit_msg(ServerMsg(
                    type="event", event={"kind": "padded",
                                         "rows": max(1, msg.pad)}))
                return
            prev = self._pad_task

            async def _run_pad(p=prev, n=max(1, msg.pad), mr=msg.mirror):
                if p is not None:
                    try:
                        await p
                    except Exception:
                        pass
                await self.exec.shell_pad(n, mr)

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


    # --- 嵌套密码提示符（ssh/sudo 前台讨密码）---

    # --- 密码状态机过渡委托（实现已拆 core/auth.py；src 内部已直呼
    # self.auth.*，委托仅供 tests/ 旧名过渡，Task 9 随 _core_impl 删除）---
    def _detect_password_prompt(self, data: bytes) -> None:
        self.auth._detect_password_prompt(data)

    def _begin_pw_verify(self) -> None:
        self.auth._begin_pw_verify()

    def _end_pw_verify(self) -> None:
        self.auth._end_pw_verify()

    def _schedule_pw_verify_expiry(self) -> None:
        self.auth._schedule_pw_verify_expiry()

    async def _pw_verify_expiry(self) -> None:
        await self.auth._pw_verify_expiry()

    def _schedule_pw_hold_release(self) -> None:
        self.auth._schedule_pw_hold_release()

    def _cancel_pw_hold_release(self) -> None:
        self.auth._cancel_pw_hold_release()

    async def _pw_hold_release(self) -> None:
        await self.auth._pw_hold_release()

    async def _flush_pw_hold(self) -> None:
        await self.auth._flush_pw_hold()

    def _schedule_pw_dismiss(self) -> None:
        self.auth._schedule_pw_dismiss()

    def _cancel_pw_dismiss(self) -> None:
        self.auth._cancel_pw_dismiss()

    async def _pw_dismiss_release(self) -> None:
        await self.auth._pw_dismiss_release()

    def _pw_prompt_host(self) -> tuple[str | None, str | None]:
        return self.auth._pw_prompt_host()

    def _pw_armed(self) -> bool:
        return self.auth.armed

    def _load_nested_password(self, host: str, user: str | None,
                              port: int | None) -> str | None:
        return self.auth._load_nested_password(host, user, port)

    async def _on_nested_password_prompt(self) -> None:
        await self.auth._on_nested_password_prompt()

    async def _on_nested_password(self, pw: str, remember: bool) -> None:
        await self.auth._on_nested_password(pw, remember)

    def _arm_typed_capture(self, key) -> None:
        self.auth._arm_typed_capture(key)

    def _pw_typed_capture(self, data: bytes) -> None:
        self.auth._pw_typed_capture(data)

    def _pw_capture_submit(self) -> None:
        self.auth._pw_capture_submit()

    def _pw_result_tail(self) -> bytes:
        return self.auth._pw_result_tail()

    def _pw_auth_result(self) -> None:
        self.auth._pw_auth_result()

    async def _pw_remember_offer(self, cand) -> None:
        await self.auth._pw_remember_offer(cand)

    async def _finish_remember(self, store: bool) -> None:
        await self.auth._finish_remember(store)

    async def ask_password(self, label: str, auth_kind: str = "") -> str:
        return await self.auth.ask_password(label, auth_kind)

    def _store_auth_password(self, password: str) -> bool:
        return self.auth.store_auth_password(password)


    # --- \x03 后 ^C 回显吞除（降级重注入的视觉残迹）---

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
        self.hook._cancel_hook_watch()
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

    async def ask_host_key(self, message: str) -> bool:
        await self.emit_msg(ServerMsg(type="ask_host_key", message=message))
        val = await self._hks.get()
        if val is None:
            raise ConnectionError("连接已关闭")
        return val


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
        except PasswordCancelled:
            await self.emit_msg(ServerMsg(type="closed", text="连接已取消"))
            self._closed = True  # sender 据此排空后退出，避免协程泄漏
            self._closed_sent = True
            return
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
        stored_pw = (load_password_alias(target.host, target.user, target.port)
                     if target.mode == "ssh" and target.host else None)
        self.session = await open_session(
            target,
            password=stored_pw,
            default_timeout=self.cfg.shell.timeout_default,
            max_output_bytes=self.cfg.shell.max_output_bytes,
            password_prompt=self.auth.ask_password,
            host_key_prompt=self.ask_host_key,
            # 补存失败经 status 可见（P0-1）：同步 _emit_nowait 不阻塞建连
            notify=lambda text: self._emit_nowait(
                ServerMsg(type="status", text=text)),
        )
        # 断线自动重连成功后把历史命令重新灌进新 shell（裸 shell 阶段，
        # 回调内不可走 run()——彼时 _runner_lock 被恢复流程持有）
        self.session.on_reconnect = self._on_session_reconnect
        # 阶段上报：建连（PTY/SSH+shell 启动）已完成，进入 agent 初始化
        # （shell 能力探测 + 集成脚本注入，秒级），前端浮层据此换文案
        await self.emit_msg(ServerMsg(
            type="stage", text="agent_init"))
        self.exec._install_curtain_gate()
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

    async def _on_session_reconnect(self) -> None:
        # 重连后的新 shell 是裸的（集成脚本已随旧会话消失），用记住的
        # shell 种类重新灌历史；种类未知（探测失败过的批处理）跳过
        await self._inject_shell_history(self._shell_kind, self._b64flag)
        if self._target is not None and self._target.commands:
            self._spawn_cmdset()

    # --- 连接后命令集过渡委托（实现已拆 core/cmdset_runner.py；委托仅供
    # tests/ 旧名过渡，Task 9 随 _core_impl 删除）---
    def _spawn_cmdset(self) -> None:
        self.cs.spawn()

    async def _run_command_set(self) -> None:
        await self.cs._run_command_set()

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
                # 等 shell 消化完再发下一波：rc 尾声（conda init 等）zle 尚未
                # 读输入，行规程缓冲积压会整段丢字节——真机注入竞态根因
                # （丢在引号中间 → shell 卡 quote> 续行 → 8s 兜底 → 直通）
                await self.hook._drain_quiet(0.15)
            # 历史注入须在集成脚本之前（裸 shell 阶段执行 history -r / fc -R）
            await self._inject_shell_history(shell, flag)
            if shell != "powershell":
                await self.hook._drain_quiet(0.15)
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
                # 注入竞态自愈：shell 若已卡进续行提示符（quote>/dquote>/
                # cmdsubst>，输入字节被行规程丢弃、引号失配的指纹），当前
                # 批必不执行——\x15 收残行 + ^C 回提示符后整链重灌一次，
                # 不再烧满 8s 兜底才回退直通。b64 字母表无空格/`>`，误报面
                # 仅限注入行回显本身；误报代价 = 一次无害清行重试。
                for _attempt in (1, 2):
                    ps2_buf = bytearray()

                    def _scan_ps2(b: bytes) -> None:
                        ps2_buf.extend(b)
                        del ps2_buf[:-64]

                    for _ci, chunk_line in enumerate(
                            injection_lines(shell, 1, flag)):
                        _dbg("chunk", _ci, "sending", len(chunk_line), "B")
                        await self.session.send_raw(chunk_line)
                        _dbg("chunk", _ci, "sent, draining")
                        drained = await self.hook._drain_quiet(0.12, router,
                                                          raw_sink=_scan_ps2)
                        _dbg("chunk", _ci, "drained, prompt=", drained is not None)
                        # sink 可能在写入停顿期已捕获提示符；drain 未再见时不覆盖
                        if drained is not None:
                            prompt = drained
                        if prompt is not None:
                            break
                        if _PS2_ECHO_RE.search(bytes(ps2_buf)):
                            _dbg("setup: 续行提示符指纹，清行重试",
                                 f"attempt={_attempt}")
                            await self.session.send_raw(b"\x15\x03")
                            await self.hook._drain_quiet(0.5, router)
                            break
                    else:
                        break   # 全部片发完且未见续行指纹：不需要重试
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
        if self.auth.feed_input(data):
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
        if (b"\r" in data or b"\n" in data) and self.hook._hook_ok() \
                and self._exec_future is None \
                and not self._pw_at_end and not self._pw_prompt_seen:
            self.hook._arm_hook_watch()

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
        _dbg("task_start emit", repr(text[:40]))
        await self.emit_msg(ServerMsg(
            type="event", event={"kind": "task_start", "text": text}))
        try:
            # 首任务 AI 栈导入（deepagents/langchain 秒级）是**同步阻塞**——
            # 事件循环整个冻住：实测 sleep(0.12) 被拖成 8.9s，task_start 虽已
            # emit 却同样迟到 9s 才达前端（分析卡/思考徽标一起迟到）。放线程
            # 池跑构建，循环不被挡：task_start 毫秒级达前端，卡即出
            await asyncio.to_thread(self._ensure_agent)
        except Exception as e:  # noqa: BLE001 - 构建失败发 error 事件让前端收尾
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"AI 初始化失败：{type(e).__name__}: {e}"}))
            return
        # hook 上报触发的任务不重注入：上报即在位凭据，而注入吞窗口会吃掉
        # 在途蓝色重绘字节（真机「提交行消失」）；外部启动（无上报）才需要
        if not hooked:
            await self.hook._ensure_integrated()   # su - 等 login shell 重置后先重注入
            self._reinject_pending = False   # 在途重注入已落定：pad 恢复 60s 兜底
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
                data = self.exec._strip_intr_echo(data)
                if not data:
                    _dbg("intr swallow: 整块被 ^C 回显吞除")
                    continue
            self.auth.inspect_output(data)
            await self.hook._detect_shell_exit(data)
            if not self._interactive or self._display == "ssh":
                self._pump_phase = "passthru"
                await self.emit_bytes(data)   # 回退模型 / Shell 模式：纯透传
                continue
            for ev in self._router.feed(data):
                self._pump_phase = "ev:" + str(ev[0])
                await self.exec.on_stream_event(ev)
            self._pump_phase = "read"

    async def _pump_eof(self, text: str) -> None:
        if self._ai_task is not None:
            self._ai_queue.clear()
            self._ai_task.cancel()
        self._session_dead = True
        await self.emit_msg(ServerMsg(type="closed", text=f"{text}；敲键自动重连"))

    # --- 集成模式：标记流事件 ---
    # --- 标记流/注入/幕帘过渡委托（实现已拆 core/exec_events.py；src 内部
    # 已直呼 self.exec.*，委托仅供 tests/ 旧名过渡，Task 9 随 _core_impl 删除）---
    def _install_curtain_gate(self) -> None:
        self.exec._install_curtain_gate()

    async def _curtain_open(self) -> None:
        await self.exec._curtain_open()

    def _curtain_close(self) -> None:
        self.exec._curtain_close()

    async def _shell_pad(self, rows: int, mirror: str | None = None) -> None:
        await self.exec._shell_pad(rows, mirror)

    def _reinject_inst_base(self) -> int:
        return self.exec._reinject_inst_base()

    def _arm_intr_swallow(self) -> None:
        self.exec._arm_intr_swallow()

    def _strip_intr_echo(self, data: bytes) -> bytes:
        return self.exec._strip_intr_echo(data)

    async def _proactive_reinject(self) -> None:
        await self.exec._proactive_reinject()

    async def _on_stream_event(self, ev: tuple) -> None:
        await self.exec._on_stream_event(ev)

    async def _on_exec_start(self, inst: int) -> None:
        await self.exec._on_exec_start(inst)

    @staticmethod
    def _disp_width(s: str) -> int:
        return self.exec._disp_width(s)

    async def _repaint_line(self, text: str | None, echoed: bool = True) -> None:
        await self.exec._repaint_line(text, echoed)

    async def _resync_after_suppress(self) -> None:
        await self.exec._resync_after_suppress()

    async def _close_suppressed_line(self) -> None:
        await self.exec._close_suppressed_line()

    async def _on_exec_text(self, text: str) -> None:
        await self.exec._on_exec_text(text)

    async def _on_exec_end(self, inst: int, ec, cwd) -> None:
        await self.exec._on_exec_end(inst, ec, cwd)

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

        降级路径（hook 标记绝迹 = su - 重置）：任务先行——task_start→分析卡
        毫秒级出场（文字由卡的 text 承接，与直通修复同形态）；清场（\x15 可见
        地收掉已回显半行 + ^C 把 shell 从可能的前台命令里要回提示符）放后台
        且持 _runner_lock，_run_task 里 if not hooked 的 _ensure_integrated
        等锁串行在其后完成重注入（su - 后下一条自然语言即恢复健康路径）。
        旧序先擦行再同步重注入 4-6s 才见蓝行/起任务——用户对着空行干等光标
        闪几秒（真机根因，已废）。前一任务在跑时只排队、不发任何终端字节
        （擦行/^C/重注入都会与在跑任务的工具注入赛跑）。
        typed=False（验证窗口 hold 输入的回放）：字符当时被 hold、不在 shell
        buffer——健康路径补发整行+回车，降级路径跳过清场（无半行回显可丢）。
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
            if t and self._exec_future is None and self.hook._hook_ok():
                self.hook._arm_hook_watch()
            return
        if self._pw_prompt_seen:
            # 密码提示符在前台（ssh/sudo 讨密码）：绝不能拦成自然语言——
            # 否则密码行被当任务挂起，\r 被 ^C/重注入链吞掉，登录失败。
            # 字符已原样透传（echo 关闭），这里只补发回车提交密码；
            # CJK/IME 整行路径的回车同时冻结手输捕获的候选（P1-3）。
            self._pw_capture_submit()
            await self.session.send_raw(b"\r")
            return
        if self._interactive and self.hook._hook_ok() and (
                not self._open_cmds or self._inner_ssh_prompt_live()):
            await self.session.send_raw(b"\r" if typed else (t + "\r").encode())
            # 兜底只保本次任务不悬空；看门狗保的是**下一条**：hook 其实不在位时
            # 置 _hook_stale，后续提交不再重复把整行自然语言送进裸壳
            self.hook._arm_hook_watch()
            if not dirty:
                self._hook_report_pending = t
                self._fallback_task = asyncio.create_task(self._submit_fallback(t))
            return
        if not self._interactive:
            # 纯终端直通（hook 注入失败/不可集成）：清缓冲与起任务并行。
            # 旧序先 \x15+^C+0.52s 再起任务——用户已回显的整行当场被擦掉，
            # 文字只能等分析卡渲染 task_start 的 text 才重现，净空白 1-2s
            # （真机「Enter 后空白然后才显示文字」根因）。task_start→分析卡
            # 不依赖终端状态，先起；^C 引发的提示符重绘由幕帘扣住（_ai_task
            # 已同步置位，prompt_start 关帘），任务收尾才放行，不会写进卡的
            # 预留空白区。清缓冲只须赶在首个工具命令注入（模型思考秒级）
            # 之前——直通工具走哨兵批（_agent_session 返回裸 session），
            # 残留半行会拼进注入命令。
            if typed:
                if self._ai_task is not None:
                    # 前一任务在跑：清缓冲须同步完成再排队（后台跑会与
                    # 在跑任务的下一发工具注入赛跑）
                    await self._passthrough_reset(t)
                else:
                    asyncio.create_task(self._passthrough_reset(t))
            else:
                # 回放行（验证窗口 hold 过）：没有半行可擦，但蓝行仍要补画
                await self.exec._repaint_line(t, echoed=False)
            await self._on_ai_line(t)
            return
        # 降级路径（hook 标记绝迹 = su - 重置等）：任务先行——task_start→分析卡
        # 毫秒级出场，文字由卡的 text 承载（与直通修复同形态）。旧序先**可见地**
        # 擦掉已回显半行，再同步重注入（探测 + 27 分片 ≈ 4-6s）成功才重发蓝行/
        # 失败才起任务——用户对着空行干看光标闪几秒（真机「Enter 后光标闪几秒
        # 才见字和卡」根因）。清场（\x15 收残行 + ^C 救回提示符）放后台且持
        # _runner_lock：_run_task 里 if not hooked 的 _ensure_integrated 等锁
        # 串行在其后——探测行必须敲在干净提示符上，且重注入与工具命令注入
        # （InteractiveRunner 同锁）互斥，无赛跑窗口。
        if self._ai_task is not None:
            # 前一任务在跑：只排队，不发任何终端字节——此刻擦行/^C/重注入
            # 都会与在跑任务的工具注入赛跑。回放行的重注入由 _run_task
            # 既有逻辑（not hooked 分支）兜住
            await self._on_ai_line(t)
            return
        if typed:
            asyncio.create_task(self._degraded_reset(t))
        else:
            # 回放行（验证窗口 hold 过）：没有半行可擦，但蓝行仍要补画
            await self.exec._repaint_line(t, echoed=False)
        await self._on_ai_line(t)

    async def _degraded_reset(self, text: str | None = None) -> None:
        """降级提交的后台清场：\x15 收掉已回显半行 + ^C 把 shell 从可能的
        前台命令里要回提示符（su - 重置是主因）。持 _runner_lock：与任务内
        _ensure_integrated（探测行须敲在干净提示符上）和工具命令注入互斥。
        镜像 dirty 也照发 \x15——降级不再重发整行，不存在「保留残行等重发」
        的语义，宁可多擦（残半行会拼进工具命令）；擦掉的画面由分析卡的 text
        承接（卡先于清理完成出现）。"""
        if self.session is None:
            return
        try:
            async with self._runner_lock:
                # 清场全程开抑制窗：\x15 的擦行回显、^C 回显、bash 补画的
                # 新提示符全吞（否则 ^C 与提示符先到、NL 原文后补画就叠在
                # 它们上面 = 又一层错位）。窗末统一按 hook 观感补画蓝行。
                self._suppress_live = True
                self._suppressed_tail = ""
                try:
                    _dbg("dg-reset: send \\x15")
                    await self.session.send_raw(b"\x15")
                    await asyncio.sleep(0.12)
                    self.exec._arm_intr_swallow()   # bash 会在半行尾回显 "^C"：吞掉这两字节
                    _dbg("dg-reset: send \\x03")
                    await self.session.send_raw(b"\x03")
                    # readline 的 SIGINT 恢复窗口（^C 回显 + 退格重画）会丢弃期间
                    # 到达的输入：紧贴 ^C 写分片会丢 chunk0 头部（真机实测：解码
                    # 脚本缺字节、注释行断成命令报 "对策: …: command not found"；
                    # settle 0.4s 后消失）。^C 回显由 _strip_intr_echo 精确吞除
                    await asyncio.sleep(0.4)   # settle 躲开 SIGINT 恢复窗口
                    _dbg("dg-reset: done")
                finally:
                    self._suppress_live = False
                    await self.exec._repaint_line(text)
        except Exception as e:  # noqa: BLE001 - 清理失败不追责：任务已起跑
            _dbg("dg-reset: exc", repr(e))

    async def _passthrough_reset(self, text: str | None = None) -> None:
        """直通模式的行缓冲后台清理：\x15 收掉已回显/残存半行 + ^C 把 shell
        从可能的前台命令里要回提示符，语义与降级路径的清场相同但不挡任务
        起跑。镜像 dirty 也照发 \x15——直通不重发整行，不存在「保留残行等
        重发」的语义，宁可多擦（残半行会拼进工具命令）；擦掉的画面由分析卡
        的 text 承接（卡先于清理完成出现）。"""
        if self.session is None:
            return
        try:
            # 与降级路径同形：清场全程抑制，窗末补画蓝行（否则半行被擦掉后
            # 用户自然语言在屏上完全不可见，只能等分析卡的 text 才重现）
            self._suppress_live = True
            self._suppressed_tail = ""
            try:
                _dbg("pt-reset: send \\x15")
                await self.session.send_raw(b"\x15")
                await asyncio.sleep(0.12)
                self.exec._arm_intr_swallow()   # bash 会在半行尾回显 "^C"：吞掉这两字节
                _dbg("pt-reset: send \\x03")
                await self.session.send_raw(b"\x03")
                await asyncio.sleep(0.4)   # settle 躲开 SIGINT 恢复窗口（同降级路径）
                _dbg("pt-reset: done")
            finally:
                self._suppress_live = False
                await self._repaint_line(text)
        except Exception as e:  # noqa: BLE001 - 清理失败不追责：任务已起跑
            _dbg("pt-reset: exc", repr(e))

    # --- hook 集成/验活过渡委托（实现已拆 core/hook_gate.py；src 内部
    # 已直呼 self.hook.*，委托仅供 tests/ 与 core 子组件旧名过渡，Task 9 随
    # _core_impl 删除）---
    async def _ensure_integrated(self) -> bool:
        return await self.hook._ensure_integrated()

    async def _ensure_integrated_locked(self) -> bool:
        return await self.hook._ensure_integrated_locked()

    async def _probe_shell_kind(self) -> tuple[str | None, str]:
        return await self.hook._probe_shell_kind()

    async def _drain_quiet(self, quiet: float = 0.12,
                           router: "StreamRouter | None" = None,
                           raw_sink: "Callable[[bytes], None] | None" = None
                           ) -> int:
        return await self.hook._drain_quiet(quiet, router, raw_sink)

    def _hook_ok(self) -> bool:
        return self.hook._hook_ok()

    def _note_hook_mark(self) -> None:
        self.hook._note_hook_mark()

    def _note_hook_text(self) -> None:
        self.hook._note_hook_text()

    def _arm_hook_watch(self) -> None:
        self.hook._arm_hook_watch()

    def _cancel_hook_watch(self) -> None:
        self.hook._cancel_hook_watch()

    async def _hook_liveness(self) -> None:
        await self.hook._hook_liveness()

    async def _detect_shell_exit(self, data: bytes) -> None:
        await self.hook._detect_shell_exit(data)

    def _match_shell_exit(self, tail: bytes) -> str | None:
        return self.hook._match_shell_exit(tail)

    def _shell_exit_window(self) -> bool:
        return self.hook._shell_exit_window()

    async def _note_shell_dead(self, why: str) -> None:
        await self.hook._note_shell_dead(why)

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
            self.exec._arm_intr_swallow()   # 同降级路径：吞 ^C 回显残迹
            await self.session.send_raw(b"\x03")
            # 同降级路径：settle 躲开 SIGINT 恢复窗口的输入丢弃；不吞 ^C 回显
            # （吞掉会使前端光标失步，重发回显拼在旧行后）
            await asyncio.sleep(0.4)
            # ^C 已可见地收掉残行并补画了新提示符：行上只剩提示符，按
            # echoed=False 接上蓝行即可（与 hook 的 __ot_repaint 同观感）
            await self.exec._repaint_line(t, echoed=False)
        await self._on_ai_line(t)

    def _start_ai(self, line: str, hooked: bool = False) -> None:
        self._ai_ping_at = time.monotonic()   # 僵尸回收基准：任务起点即有锚
        # 任务起跑未走 hook 上报（外部触发链）→ _run_task 必有重注入在途：
        # _shell_pad 的 60s 节流补注入对本次任务冗余（pad ack 不必等它）
        self._reinject_pending = not hooked
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
            # 用户中止（Ctrl+C/⏹）语义发 interrupt（不是 error）：前端按
            # 「中止」收束——流式未渲染完毕的卡整卡移除，不留下半截卡
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "interrupt", "text": "已停止"}))
        except Exception as e:  # noqa: BLE001 - 兜底：前端靠 error 停表收卡片
            await self.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"处理失败：{type(e).__name__}: {e}"}))
        finally:
            self._ai_task = None
            self._reinject_pending = False
            try:
                await self.exec._curtain_open()   # 任务收尾：扣住的提示符放行
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
            await self.hook._ensure_integrated()
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
                self._suppressed_tail = ""
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
            self.hook._cancel_hook_watch()
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
                self._suppressed_tail = ""
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

def __getattr__(name: str):
    # PEP 562：_HOOK_LIVENESS 已拆 core/hook_gate.py；模块级 from-import 会在
    # 「core 子模块先于 _core_impl 导入」的顺序下成环（子模块注册触发包桥
    # __setattr__ → 拉起本模块 → 再回头要半初始化 hook_gate 的符号），
    # 改惰性再导出供 core 包桥 getattr 读取（tests/test_nested_session.py）
    if name == "_HOOK_LIVENESS":
        from .core.hook_gate import _HOOK_LIVENESS
        return _HOOK_LIVENESS
    if name in ("CMDSET_ECHO_TIMEOUT", "CMDSET_QUIET", "CMDSET_PROMPT_TIMEOUT",
                "CMDSET_RESUME_QUIET", "CMDSET_HOOK_WAIT", "_CMDSET_PROMPT_RE",
                "_CMDSET_SECRET_RE", "_CMDSET_CONFIRM_RE", "_CMDSET_DONE_RE",
                "_CS_PROMPT_ID_RE"):
        from .core import cmdset_runner as _cs
        return getattr(_cs, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
