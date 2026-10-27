"""单管线核心：PTY 直通 + hook 记账 + AI 任务（自 web/worker.py 搬移，设计见 docs/superpowers/specs/2026-09-27-cli-single-pipeline-design.md）。

显示模型：PTY 字节是唯一显示管线——核心除需吞除/记账的字节外，把
live/exec 相位文本原样转发给前端出口；不做任何显示路由（无
term_open/commit/command_done、无直通活块、无嵌套 shell 状态机、无写死
提示符）。核心只做三件事：

1. 记账：OSC 133（A/B/C/D 相位）+ OSC 6337（CMD/AI/EXEC 行报告）的
   StreamRouter 监听——history、退出码、AI 上下文；
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
from contextlib import suppress
from dataclasses import dataclass, replace
from typing import Callable


_OFFLINE_CAP = 500   # 断线期缓存的 JSON 控制帧上限（防长期断线涨内存）


def _dbg(*a) -> None:
    """OT_WEB_DEBUG=1 时打印交互式状态机轨迹（排障用，默认静默）。"""
    if _OT_DBG:
        print(f"[otdbg +{time.monotonic() - _OT_T0:7.3f}s]", *a, flush=True)

from ..shell import cmdset
from . import history
from ..config import Config, TargetConfig, app_dir
from ..connections import (
    PW_STORE_FAIL_HINT, display_name, open_session, parse_user_at_host)
from .history import HISTORY_RECALL_LIMIT
from ..policy import Policy
from .messages import (
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
from ..connections.secrets import load_password, store_password
from ..shell.integration import (
    StreamRouter, agent_exec_line, history_inject_line, history_quiet_line,
    injection_lines, is_internal_line,
    parse_probe, probe_command, toggle_line,
)
from ..session.base import (
    _PASSWORD_PROMPT_RE, CommandResult, _needs_password_prompt)
from ..agent.sysprobe import (
    LOCAL_PROFILE, MANUAL_PRESETS, load_host_cache, probe_profile,
    save_host_cache,
)
from .transcript import open_transcript
from ..connections.secrets import load_password_alias as _load_password_alias_impl


def load_password_alias(host: str, user: str | None, port: int | None) -> str | None:
    """首跳（_connect）与嵌套（_load_nested_password）共用的凭据读取：
    None/22 端口别名互查，规范实现在 connections.secrets.load_password_alias。

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
        from ..agent.build import build_agent as _build_agent
        build_agent = _build_agent
    if build_chat_model is None:
        from ..agent.model import build_chat_model as _build_chat_model
        build_chat_model = _build_chat_model


class PipelineCore:
    # pad 指纹扫描窗开关：类级默认 False——测试可直接构造实例不跑 __init__，
    # live 分支读它时属性必须存在
    _pad_inflight = False
    # 事件节奏分流：False=逐 token 流式（CLI 直播）；True=段攒流（Web：
    # 每段一条完整 ai_result + 心跳，前端不攒 token 流）。由子类覆写。
    paced_display: bool = False

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
        self.ai    # noqa: B018 — AI 行处理/任务组件：触达 lazy 属性即建 _ai_*/_display 等 AI 状态（core/ai_flow.py）
        self.pump   # noqa: B018 — 输出泵组件：触达 lazy 属性即建 _pump/_sender/_pump_phase 状态（core/pump.py）
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
        self._closed = False
        self._closed_sent = False  # closed 消息已入 outbox（sender 退出门闩）
        # 泵 EOF（_pump_eof）置位：断线后首个键经 _on_keys 触发 _revive_session
        self._session_dead = False
        # 模型上下文轮次：/clear 自增 → TaskRunner 换新 thread_id，langgraph
        # MemorySaver 按 thread 存历史，旧上下文不再进新任务的提示词（省 token，
        # 语义同 CLI /clear 换 session_id）
        self._ctx_epoch = 0
        # --- 交互式 shell 集成（单管线真终端）---
        self._router: StreamRouter | None = None
        self._exec_future = None     # InteractiveRunner 等待 D 标记的 future
        # --- 失败救援（分类判 CMD 就直接执行；失败即信号，一键交 AI）---
        self._ev_prompt = asyncio.Event()    # 模式切换：等提示符重画
        # 任意流字节（live/exec 回显）到达信号：重注入分片逐片等回显做应答
        # （固定短间隔会在 shell 执行间隙把分片堆进 canonical 缓冲溢出丢块）
        self._ev_stream = asyncio.Event()
        self._ev_exec_end = asyncio.Event()  # 模式切换：等 toggle 的 D 标记

    @property
    def nested(self) -> "NestedSshTracker":
        """嵌套 SSH 帧解析组件（无状态，惰性建以兼容裸构造测试实例）。"""
        from .nested_ssh import NestedSshTracker  # 局部导入：core/__init__ 反向转发本模块，模块级导入成环
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
            from .auth import AuthFlow
            a = AuthFlow(self)
            self.__dict__["_auth"] = a
        return a

    @property
    def exec(self) -> "ExecEvents":
        """标记流/注入/幕帘组件（Task 4）：惰性建以兼容裸构造测试实例。"""
        e = self.__dict__.get("_exec_events")
        if e is None:
            from .exec_events import ExecEvents
            e = ExecEvents(self)
            self.__dict__["_exec_events"] = e
        return e

    @property
    def hook(self) -> "HookGate":
        """hook 集成/验活组件（Task 5）：惰性建以兼容裸构造测试实例。"""
        h = self.__dict__.get("_hook_gate")
        if h is None:
            from .hook_gate import HookGate
            h = HookGate(self)
            self.__dict__["_hook_gate"] = h
        return h

    @property
    def cs(self) -> "CmdsetRunner":
        """连接后命令集组件（Task 6）：惰性建以兼容裸构造测试实例。"""
        c = self.__dict__.get("_cmdset_runner")
        if c is None:
            from .cmdset_runner import CmdsetRunner
            c = CmdsetRunner(self)
            self.__dict__["_cmdset_runner"] = c
        return c

    @property
    def ai(self) -> "AiFlow":
        """AI 行处理/任务组件（Task 7）：惰性建以兼容裸构造测试实例。"""
        a = self.__dict__.get("_ai_flow")
        if a is None:
            from .ai_flow import AiFlow
            a = AiFlow(self)
            self.__dict__["_ai_flow"] = a
        return a

    @property
    def pump(self) -> "OutputPump":
        """输出泵组件（Task 8）：惰性建以兼容裸构造测试实例。"""
        p = self.__dict__.get("_output_pump")
        if p is None:
            from .pump import OutputPump
            p = OutputPump(self)
            self.__dict__["_output_pump"] = p
        return p

    # --- 委托（tests/ 引用旧名，长期保留——勿删）---
    @staticmethod
    def _parse_ssh_cmd_target(line: str
                              ) -> tuple[str | None, str | None, int | None] | None:
        from .nested_ssh import NestedSshTracker
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
            self._sender = asyncio.create_task(self.pump._sender_loop())
        if self._task is None:
            self._task = asyncio.create_task(self._run())
        if self._hb is None:
            self._hb = asyncio.create_task(self.pump._heartbeat())
        self._flush_offline()
        if self._pending_approval is not None:
            # 重连/刷新重挂：补发未决审批（首挂时必为 None，不会重复投）
            self._emit_nowait(self._pending_approval)


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
        await self.ai._maybe_cancel_ai()
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
                await self.ai._maybe_cancel_ai()
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
            # su - 等 login shell 重置 hook 后依然可用）。
            # 必须走 _inbox 与按键保序：此前内联处理会在 _dispatch 泵的两个
            # 按键之间插进 \r，shell 只接到半行（真机「批准」被截成「批」）
            await self._inbox.put(msg)
        elif msg.type == "rescue":
            # 失败救援卡决策（accept = 交给 AI）
            await self.ai._on_rescue_decision(msg.accept)
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

    # --- 密码状态机委托（实现在 core/auth.py；tests/ 与组件仍经此引用，
    # 长期保留——勿删）---


    async def ask_password(self, label: str, auth_kind: str = "") -> str:
        return await self.auth.ask_password(label, auth_kind)


    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        # 可释放资源钩子（如文件面板的 SSH 连接）：放在最前，后面任何一步
        # 抛错都不会漏释放。旧实现靠调用点记得调 close_cascade，断线回收
        # 与 app 关闭两条路径都漏了。getattr 默认空表 → fake worker 零改动。
        for fn in list(getattr(self, "_disposables", [])):
            with suppress(Exception):
                await fn()
        self._curtain = False   # 关闭即弃：扣留的提示符字节随会话消失
        self._curtain_parts = []
        if self._ai_task is not None:
            self._ai_queue.clear()
            self._ai_task.cancel()
        if self._cs_task is not None:
            self._cs_task.cancel()
        # 密码 hold/验证窗口的定时器一并撤掉：不然会话关了它们还空转到点
        self.auth._cancel_pw_hold_release()
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
        await self.pump._stop_pump()
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


    def _approval_risk(self, command: str) -> str:
        """审批风险级（单一来源在 Policy.risk：删除/提权/写改/无法判定等 → high）。"""
        return self.policy.risk(command)

    async def ask_approval(self, command: str, reasons: str, host: str,
                           risk: str = "high", id: int = 0) -> dict:
        msg = ServerMsg(
            type="approval", command=command, reasons=reasons, host=host,
            risk=risk, id=id)
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
        # 启动期配置错误（协议二选一冲突/都缺）→ 红色警告卡（真机约定：
        # 报错信息都进红卡）；顺序在 ready 后，前端 island 已可挂卡
        for err in (getattr(self.cfg, "errors", None) or []):
            self._emit_nowait(ServerMsg(
                type="event", event={"kind": "alert", "text": err}))
        self.pump.start()
        if self._interactive:
            # 注入期的提示符字节被 setup 消化掉了：Ctrl+L 让 shell 重画提示符
            #（ready 已先入 outbox，顺序有保证）
            await self.session.send_raw(b"\x0c")
        if self._target is not None and self._target.commands:
            self.cs._spawn_cmdset()
        while not self._closed:
            msg = await self._inbox.get()
            try:
                await self._dispatch(msg)
            except Exception as e:  # noqa: BLE001 - 单条消息出错不能让 tab 变僵尸
                text = f"处理出错：{type(e).__name__}: {e}"
                await self.emit_msg(ServerMsg(
                    type="status", text=text))
                await self.emit_msg(ServerMsg(
                    type="event", event={"kind": "alert", "text": text}))

    async def _connect(self) -> None:
        target = self.cfg.targets.get(self.target_name, self.cfg.targets["default"])
        self._target = target
        host = target.host or ("local" if target.mode == "local" else target.name)
        self._target_host = host
        # 用户名与主机同时就绪：下面 probe_profile 要跑几秒，期间文件面板的
        # 登录弹框就要预填「用户名」，等 _setup_interactive 之后才赋值就晚了。
        # 这里先按连接目标给，后面再用 session.username 兜底覆盖。
        self._target_user = target.user or ""
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
        pending = getattr(self, "_pending_size", None)
        if pending:
            await self.session.resize(*pending)
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


    def _record_history(self, source: str, command: str) -> None:
        """落一条命令进历史库；失败静默（历史不能打死主流程）。

        注入管线内部行（_ot_inj 分片、__ot_exec__/__ot_pad）不入史：每次
        任务重注入都记 ~8 条 ~700B 垃圾，回灌单行超 tty 缓冲会死锁黑屏。
        """
        if command and self._target_host and not is_internal_line(command):
            history.record(self._target_host, source, command)

    async def _inject_shell_history(self, shell: str | None,
                                    flag: str = "-d") -> None:
        """把该 target 近期命令灌进远端 shell 历史（history / ↑ 原生可见）。

        必须在集成脚本注入前（裸 shell 阶段）发送；批处理回退下注入行的
        回显会闪现一次，可接受。失败静默降级。
        """
        if not shell or self.session is None or not self._target_host:
            return
        try:
            rows = history.recent(self._target_host, HISTORY_RECALL_LIMIT)
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
            self.cs._spawn_cmdset()

    # --- 连接后命令集委托（实现在 core/cmdset_runner.py；tests/ 仍经此
    # 引用旧名，长期保留——勿删）---


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
                # 慢 shell 宽限重试（真机 2026-10-16：Windows conda profile
                # 初始化实测 40s+，首轮 10s 探测必超时/读空重连 → 集成脚本
                # 不注入 → __ot_pad 无 hook → 补差熔断 → 卡片被夹紧截断）。
                # 只对「探测没跑成」重试：超时中断（exit 130）/读空重连
                # （reconnected）。探测跑成但答非所问（旧 shell/怪 shell）
                # 重试无意义，直接降级直通——也避免测试桩（恒回 "hello"）
                # 被无谓拖一轮。
                probe_ran = not (
                    r.exit_code == 130
                    or getattr(r, "reconnected", False)
                    or not (r.output or "").strip())
                if probe_ran:
                    _dbg("setup: probe 未识别 shell → 纯终端直通")
                    return
                _dbg("setup: probe 未跑成，宽限重试")
                await asyncio.sleep(3)
                r = await self.session.run(
                    probe_command(self.profile.os_family), timeout=45)
                shell, flag = parse_probe(r.output or "")
                _dbg("setup probe retry out=", repr((r.output or "")[:120]),
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
                        # 这里不得因「提示符已到」提前停发：bash 的注入链是
                        # base64…→ eval → bind 三段，eval 一落地 hook 的 PS1
                        # 就带 OSC 标记地画提示符——在它处 break 会把末行
                        # bind 丢下，\C-m 维持原生 accept-line，自然语言被
                        # shell 当命令执行（真机 CI：'please' not found）。
                        # 提示符只是「hook 已活」的成功凭据，留给循环结束
                        # 后的等待逻辑消费；本循环的职责是把每一行都发完。
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
            asyncio.get_running_loop().create_task(self.ai._prewarm_agent())
        except Exception:  # noqa: BLE001 - 探测/注入任何失败都回退直通
            import traceback
            _dbg("setup: 异常回退纯终端直通", traceback.format_exc())
            self._interactive = False

    @property
    def files_identity(self) -> dict:
        """文件面板该连哪台机器、以谁的身份。

        跳板机场景（连 A、终端里 `ssh B`）下会话的 SFTP 挂在 A 上，够不着
        B 的文件——面板要经隧道另连 B。host/port 取**最近一层未闭合 ssh 帧**
        （ssh_frame_target：`sudo su -` 开帧后仍要认出 B，用
        nested_ssh_target 会退回跳板机）；user 优先取提示符里的用户名
        （`sudo su -` 之后是 root，面板以该身份连才看得到 /root），拿不到
        就退 ssh 帧里的登录名。

        `users` 是连接候选（按优先级）：连不上时逐个退，直到连上或全部
        缺凭据。`nested=False` 表示终端没跳，面板用会话自己的 SFTP 即可。
        """
        from .cmdset_runner import _CS_PROMPT_ID_RE

        thost, tuser, tport = self.nested.ssh_frame_target()
        session_host = getattr(self, "_target_host", "") or ""
        host = thost or session_host
        m = _CS_PROMPT_ID_RE.match((self._cur_prompt or "").strip())
        eff = m.group(1) if m else ""
        session_user = getattr(self, "_target_user", "") or ""
        target = getattr(self, "_target", None)
        users = []
        for u in (eff, tuser, session_user,
                  getattr(target, "user", None) or ""):
            if u and u not in users:
                users.append(u)
        return {
            "host": host,
            # 非嵌套时 ssh_frame_target 全 None，但用户连的可能不是 22 端口
            # （诊断拓扑正是 127.0.0.1:2222）——端口栏必须预填真实端口
            "port": (tport if thost
                     else (getattr(target, "port", None) if target else None)),
            "users": users,
            "effective_user": eff or (users[0] if users else ""),
            "nested": bool(thost) and (thost != session_host or tport is not None),
            # 本机终端没有「最终服务器」（host 是字面量 "local"），
            # 文件面板据此隐藏 📁 入口，别把 "local" 当 IP 填进表单
            "mode": getattr(target, "mode", "") if target else "",
        }

    async def _dispatch(self, msg: ClientMsg) -> None:
        if msg.type == "raw":
            await self._on_keys(msg.data)
        elif msg.type == "submit":
            # 与按键同队列保序（feed_msg 只入队）：半行 \r 截断中文的根因修复
            if self.session is not None and msg.text:
                await self.ai._on_frontend_line(msg.text, msg.dirty)
        elif msg.type == "mode":
            await self.ai._switch_display(msg.text)
        elif msg.type == "resize":
            self._pending_size = (msg.rows, msg.cols)
            if self.session is not None:
                await self.session.resize(msg.rows, msg.cols)
        elif msg.type == "change_model":
            await self.ai._change_model(msg.model)
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
            await self.ai._maybe_cancel_ai()
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
            self.pump.start()
        await self.emit_msg(ServerMsg(
            type="reconnected", text=f"已重新连接 {self._target_host or '目标'}"))
        return True


    def _reset_context(self) -> None:
        """模型上下文归零：换 thread_id（langgraph MemorySaver 按 thread 存
        历史，新任务的提示词不再带旧上下文，省 token）+ 换 transcript 文件。
        不碰 PTY——清屏与否由调用方决定（/clear 清屏，new_session 不清）。"""
        self._ctx_epoch += 1
        self.transcript = open_transcript(self.tab_id)


    async def _switch_target(self, line: str) -> None:
        from ..connections import list_ssh_hosts, load_saved_targets

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
        self.pump.start()
        if self._interactive:
            await self.session.send_raw(b"\x0c")

    def _register_target(self, text: str) -> str:
        from ..config import TargetConfig
        from ..connections import load_saved_targets, parse_user_at_host

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
        from ..agent.sysprobe import MANUAL_PRESETS

        parts = line.split()
        if len(parts) < 2 or parts[1] not in MANUAL_PRESETS:
            await self.emit_msg(ServerMsg(
                type="status", text="可选：" + ", ".join(MANUAL_PRESETS)))
            return
        self.profile = replace(self.profile, **MANUAL_PRESETS[parts[1]])
        if self.agent is not None:
            await self.ai._rebuild_agent()   # 已建才重建；未建由 _ensure_agent 用新画像
        await self.emit_msg(ServerMsg(
            type="status", text=f"系统方言已手动设为 {parts[1]}"))


    # --- 输出泵委托（实现在 core/pump.py；core 内部仍经此引用，
    # 长期保留——勿删）---

    async def _pump_eof(self, text: str) -> None:
        if self._ai_task is not None:
            self._ai_queue.clear()
            self._ai_task.cancel()
        self._session_dead = True
        await self.emit_msg(ServerMsg(type="closed", text=f"{text}；敲键自动重连"))

    # --- 集成模式：标记流事件 ---
    # --- 标记流/注入/幕帘委托（实现在 core/exec_events.py；tests/ 与
    # ai_flow 仍经此引用旧名，长期保留——勿删）---


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
        from .hook_gate import _HOOK_LIVENESS
        return _HOOK_LIVENESS
    if name in ("CMDSET_ECHO_TIMEOUT", "CMDSET_QUIET", "CMDSET_PROMPT_TIMEOUT",
                "CMDSET_RESUME_QUIET", "CMDSET_HOOK_WAIT", "_CMDSET_PROMPT_RE",
                "_CMDSET_SECRET_RE", "_CMDSET_CONFIRM_RE", "_CMDSET_DONE_RE",
                "_CS_PROMPT_ID_RE"):
        from . import cmdset_runner as _cs
        return getattr(_cs, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
