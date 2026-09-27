"""CLI 终端前端：核心 ↔ stdin/stdout 适配。

单管线核心（openterminal.core.PipelineCore）的零卡片终端前端：
- CliCore：emit_msg/emit_bytes/_emit_nowait 覆写为进前端串行渲染 outbox
  （核心自身 outbox/sender_loop 对 None sink 空转）；
- TermFrontend：raw 输入泵（键盘字节 → core.feed_input）、串行渲染
  outbox（("bytes", d) → writer 直写；("msg", m) → _on_msg 钩子）、
  初始 resize、SIGWINCH、closed 停止；finally 还原 termios + 移除
  信号处理（KeyboardInterrupt/渲染异常/EOF/正常 closed 四条退出路径
  都必须走完，否则用户 shell 留在 raw 态）；
- _CaptureLayer：本地截获层（审批/rescue/认证/Ctrl+C，spec §3.1/§3.3）。
  待决态消费的键与 password 累积字符绝不进 PTY；on_keys 返回
  ("pass", 剩余直通字节) | ("edit", 余量字节)；决策经 frontend.core.feed_msg
  发出后退出截获态；
- _run_edit：审批编辑流（e 键）。termios 交接顺序（Review Focus #5）：
  暂停泵 → _restore_input → prompt_toolkit 多行输入 → _set_raw_input →
  恢复泵 → feed_msg；结果过 approval.reclassify_edited。

raw 原语四件（_set_raw_input/_restore_input/_read_one_key/_term_size）
自 rawmode.py 复制为私有函数——rawmode.py 旧 CLI 还在用，一个字节不动，
Task 7 删除旧管线时一并退场。
"""
from __future__ import annotations

import asyncio
import os
import signal
import sys
import time

from rich.console import Console, Group
from rich.panel import Panel
from rich.syntax import Syntax
from rich.text import Text

from .approval import edit_decision, reclassify_edited
from .config import Config
from .core import ClientMsg, PipelineCore, ServerMsg


class CliCore(PipelineCore):
    """PipelineCore 的 CLI 适配：全部下行出口进前端串行渲染 outbox。

    核心自身的 _outbox/_sender_loop 在 CLI 下不承载业务流量（attach(None)
    后 sender 空转）；消息与 PTY 字节统一进 frontend._outbox，由前端
    _render_loop 串行消费——渲染动作与 PTY 字节不互相撕裂（spec §3.2）。
    """

    def __init__(self, cfg: Config, target_name: str,
                 frontend: "TermFrontend | None") -> None:
        # frontend 允许暂 None（两段构造：先建 core 再建 TermFrontend 后
        # 回填），但 attach/emit 发生前必须就位
        # 先设 _frontend 再 super().__init__：core __init__ 不碰 frontend，
        # 顺序防未来踩坑（基类构造期若出现 emit 也能找到出口）
        self._frontend = frontend
        super().__init__(cfg, target_name)

    async def emit_msg(self, msg: ServerMsg) -> None:
        await self._frontend._outbox.put(("msg", msg))

    async def emit_bytes(self, data: bytes) -> None:
        await self._frontend._outbox.put(("bytes", data))

    def _emit_nowait(self, msg: ServerMsg) -> None:
        # 同步缝（AI token 流走它）：同步回调里无法 await
        self._frontend._outbox.put_nowait(("msg", msg))

    async def close(self) -> None:
        await super().close()
        # CLI 下核心 outbox 永不收货（全部下行走前端 _outbox），基类
        # _sender_loop 会永远阻塞在 outbox.get()、够不到「closed 已发 +
        # backlog 空」的退出门闩——投一个哨兵唤醒它按门闩自然退出
        # （sink=None 不发送，无副作用；attach 未发生时无 sender 可醒）。
        # web 侧由 closed 消息本身唤醒 sender，CliCore 需要自己补这一脚。
        if self._sender is not None and not self._sender.done():
            self._outbox.put_nowait(("close-sentinel", b""))


class _CaptureLayer:
    """本地截获层（spec §3.1/§3.3，与 web approvalKeys/rescue/auth 同规则）。

    待决态（state = "approval"|"rescue"|"password"|"host_key"）下消费的
    决策键与 password 累积字符**绝不进 PTY**（Review Focus #2）：
    on_keys(data) -> ("pass", 剩余待直通字节) | ("edit", 余量字节)——决策键
    本地消费掉，pass payload 只含剩余字节；"edit" 表示进审批编辑流（由
    _input_pump await frontend._run_edit()）。

    决策全部经 frontend.core.feed_msg 发出（approve/reject payload 与 web
    完全一致，源自 approval.py；edit 用 approval.edit_decision），发送后
    退出对应截获态。enter_approval/enter_rescue/enter_auth 由渲染器在
    进入对应待决态时调用（调用形状被 test_term_render.py 钉死）；
    exit_* 对应清除。

    按键规则：
    - approval（risk=="high" 二段确认）：\\r 进 confirming（红行提示）→
      再 \\r 才 approve；\\x7f/\\x08 reject；e/E → ("edit", 余量)（编辑完成后泵继续路由余量）；
      confirming 态 \\x7f 仅退出 confirming；其余键吞掉不透传。
    - rescue：y/Y → accept=True，n/N → accept=False，其余键透传。
    - password：可打印字符累积（不回显，渲染器已打提示行）、\\x7f/\\x08
      退格、\\r 提交（remember 恒 False）；期间字节不透传。
    - host_key：y → text="true"、n → text="false"，其余透传。
    - 待决期 \\x03（钉死规则）：approval → reject、rescue → accept=False，
      均不透传；password/host_key 态吞掉不透传（隐藏输入不外泄）。
    - 无截获态 \\x03：核心任务活跃（core._ai_task 非 None）→ interrupt
      且不透传；空闲 → 原样透传（shell 原生 ^C）。
    - \\x04（Ctrl+D）永远透传（shell exit → 核心 closed）。
    """

    def __init__(self, frontend: "TermFrontend") -> None:
        self._frontend = frontend
        self.state: str | None = None
        self._risk = "normal"       # approval 风险级（二段确认判定）
        self._confirming = False    # high 风险二段确认态
        self._buf = b""             # password 累积（不回显）
        self._editing = False       # 编辑流进行中（泵已停读）

    # --- 待决态进入/退出（渲染器调用 enter_*；exit_* 对应清除）---

    def enter_approval(self, risk: str) -> None:
        self.state = "approval"
        self._risk = "high" if risk == "high" else "normal"
        self._confirming = False
        self._editing = False

    def enter_rescue(self) -> None:
        self.state = "rescue"

    def enter_auth(self, kind: str) -> None:
        # 渲染器只传 "password"|"host_key"；core 的 ask_password 带
        # auth_kind="cmdset" 时渲染器也归 "password"（core 侧 password/
        # cmdset 入同一 _pws 队列，ClientMsg auth_kind="password" 即达）
        self.state = "host_key" if kind == "host_key" else "password"
        self._buf = b""

    def exit_approval(self) -> None:
        if self.state == "approval":
            self._exit_state()

    def exit_rescue(self) -> None:
        if self.state == "rescue":
            self._exit_state()

    def exit_auth(self) -> None:
        if self.state in ("password", "host_key"):
            self._exit_state()

    def _exit_state(self) -> None:
        self.state = None
        self._confirming = False
        self._buf = b""
        self._editing = False

    # --- 待决审批原命令（编辑流预填）---

    @property
    def pending_command(self) -> str:
        """待决审批的原命令。enter_approval(risk) 形状被测试钉死不能加参，
        渲染器在调用前把命令写进 frontend._pending_approval_command。"""
        return getattr(self._frontend, "_pending_approval_command", "") or ""

    # --- 键盘路由 ---

    def on_keys(self, data: bytes) -> tuple[str, object]:
        if self.state is None:
            return self._idle_keys(data)
        if self.state == "approval":
            return self._approval_keys(data)
        if self.state == "rescue":
            return self._rescue_keys(data)
        return self._auth_keys(data)

    def _task_active(self) -> bool:
        """核心任务活跃 = core._ai_task 非 None（core.py 真实属性名）。"""
        core = self._frontend.core
        return getattr(core, "_ai_task", None) is not None

    def _idle_keys(self, data: bytes) -> tuple[str, object]:
        """无截获态：\\x03 任务活跃 → interrupt（消费掉不透传），空闲透传；
        其余字节（含 \\x04）全量直通。"""
        if b"\x03" not in data:
            return ("pass", data)
        out = bytearray()
        for i, byte in enumerate(data):
            if byte == 3 and self._task_active():
                self._send(ClientMsg(type="interrupt"))
            else:
                out.append(byte)
        return ("pass", bytes(out))

    def _approval_keys(self, data: bytes) -> tuple[str, object]:
        out = bytearray()       # approval 其余键吞掉；\\x04 透传为唯一例外
        for i, byte in enumerate(data):
            if byte == 4:                       # Ctrl+D 永远透传
                out.append(byte)
                continue
            if byte == 3:                       # 待决期 Ctrl+C = reject（钉死）
                self._send_decision("reject")
                rest = bytes(out) + data[i + 1:]
                return self.on_keys(rest) if rest else ("pass", b"")
            if self._confirming:
                if byte == 13:                  # confirming \\r → approve
                    self._send_decision("approve")
                    rest = bytes(out) + data[i + 1:]
                    return self.on_keys(rest) if rest else ("pass", b"")
                if byte in (127, 8):            # 仅退出 confirming 回待决
                    self._confirming = False
                continue                        # confirming 其余键吞掉
            if byte == 13:                      # \\r
                if self._risk == "high":
                    self._confirming = True     # 二段确认（红行提示）
                    self._frontend._capture_notice(
                        "确认执行？Enter 放行 / Backspace 取消")
                else:
                    self._send_decision("approve")
                    rest = bytes(out) + data[i + 1:]
                    return self.on_keys(rest) if rest else ("pass", b"")
            elif byte in (127, 8):              # \\x7f/\\x08 → reject
                self._send_decision("reject")
                rest = bytes(out) + data[i + 1:]
                return self.on_keys(rest) if rest else ("pass", b"")
            elif bytes([byte]) in (b"e", b"E"):
                self._editing = True            # 进编辑流（泵 await _run_edit）
                # 余量随 edit 返回：_run_edit 完成后泵继续路由（不丢字节）
                return ("edit", data[i + 1:])
            # 其余键消费不透传（与 web approvalKeys 同规则）
        return ("pass", bytes(out))

    def _rescue_keys(self, data: bytes) -> tuple[str, object]:
        out = bytearray()
        for i, byte in enumerate(data):
            if byte == 3:                       # 待决期 Ctrl+C = 忽略救援
                self._send_rescue(False)
                rest = bytes(out) + data[i + 1:]
                return self.on_keys(rest) if rest else ("pass", b"")
            if byte in (121, 89):               # y/Y → 交给 AI
                self._send_rescue(True)
                rest = bytes(out) + data[i + 1:]   # 前缀透传字节不丢（minor 1）
                return self.on_keys(rest) if rest else ("pass", b"")
            if byte in (110, 78):               # n/N → 忽略
                self._send_rescue(False)
                rest = bytes(out) + data[i + 1:]
                return self.on_keys(rest) if rest else ("pass", b"")
            out.append(byte)                    # 其余键透传
        return ("pass", bytes(out))

    def _auth_keys(self, data: bytes) -> tuple[str, object]:
        if self.state == "host_key":
            return self._host_key_keys(data)
        return self._password_keys(data)

    def _password_keys(self, data: bytes) -> tuple[str, object]:
        """隐藏输入：可打印累积（不回显）、\\x7f 退格、\\r 提交；期间
        字节一律不透传（\\x04 例外：原样透传，计划钉死「永远透传」）。"""
        out = bytearray()       # 仅累积 \x04（隐藏输入期间唯一透传字节）
        for i, byte in enumerate(data):
            if byte == 4:                       # Ctrl+D 永远透传
                out.append(byte)
                continue
            if byte == 3:                       # 隐藏输入不外泄：吞掉
                continue
            if byte == 13:                      # \\r 提交
                self._send(ClientMsg(type="auth", auth_kind="password",
                                     text=self._buf.decode("utf-8",
                                                            "replace")))
                self._exit_state()
                rest = bytes(out) + data[i + 1:]
                return self.on_keys(rest) if rest else ("pass", b"")
            if byte in (127, 8):                # 退格
                if self._buf:
                    self._buf = self._buf[:-1]
                continue
            if byte >= 32 or byte < 0:          # 可打印/非 ASCII 累积
                self._buf += bytes([byte])
            # 其余控制键吞掉
        return ("pass", bytes(out))

    def _host_key_keys(self, data: bytes) -> tuple[str, object]:
        out = bytearray()
        for i, byte in enumerate(data):
            if byte == 4:                       # Ctrl+D 永远透传
                out.append(byte)
                continue
            if byte == 3:                       # 吞掉不泄漏
                continue
            if byte in (121, 89):               # y → 信任
                self._send(ClientMsg(type="auth", auth_kind="host_key",
                                     text="true"))
                self._exit_state()
                rest = bytes(out) + data[i + 1:]
                return self.on_keys(rest) if rest else ("pass", b"")
            if byte in (110, 78):               # n → 拒绝
                self._send(ClientMsg(type="auth", auth_kind="host_key",
                                     text="false"))
                self._exit_state()
                rest = bytes(out) + data[i + 1:]
                return self.on_keys(rest) if rest else ("pass", b"")
            out.append(byte)                    # 其余透传
        return ("pass", bytes(out))

    # --- 决策上行（payload 与 web 完全一致，源自 approval.py）---

    def _send(self, msg: ClientMsg) -> None:
        """on_keys 同步路由里的 async 上行：调度为任务立即发出。"""
        asyncio.ensure_future(self._frontend.core.feed_msg(msg))

    def _send_decision(self, kind: str) -> None:
        if kind == "approve":
            decision: dict = {"type": "approve"}
        else:
            decision = {"type": "reject", "message": "用户拒绝了该命令"}
        self._send(ClientMsg(type="decision", decision=decision))
        self._exit_state()

    def _send_rescue(self, accept: bool) -> None:
        self._send(ClientMsg(type="rescue", accept=accept))
        self._exit_state()

    # --- 编辑流决策（_run_edit 收尾调用）---

    def send_edit(self, new_command: str) -> None:
        self._send(ClientMsg(type="decision", decision=edit_decision(new_command)))
        self._exit_state()

    def send_approve(self) -> None:
        self._send_decision("approve")

    def send_reject(self, message: str) -> None:
        self._send(ClientMsg(type="decision",
                             decision={"type": "reject", "message": message}))
        self._exit_state()

    def cancel_edit(self) -> None:
        """编辑取消/EOF：回待决态（不发决策）。"""
        self._editing = False
        self._confirming = False


def _fmt_tokens(n: int) -> str:
    """token 数渲染：>=1000 缩写为 k（1200 → "1.2k"），.0 去尾。"""
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        s = f"{n / 1000:.1f}"
    else:
        s = f"{n / 1_000_000:.1f}M"
    if s.endswith(".0"):
        s = s[:-2]
    return s + ("k" if n < 1_000_000 else "")


class _WriterFile:
    """rich Console → frontend.writer 的 file-like 适配器（纪律 #1）。

    Console 的每笔输出编码成 UTF-8 字节后经 frontend._writer 发出，与
    PTY 字节在同一串行 outbox 出队（Review Focus #3 不撕裂）。持有
    frontend 而非 writer 本身：测试替换 frontend._writer 时取的是当次值。
    """

    def __init__(self, frontend: "TermFrontend") -> None:
        self._fe = frontend

    def write(self, s: str) -> int:
        # raw 态终端 OPOST/ONLCR 已关：rich 输出的 \n 须翻译成 \r\n 防阶梯
        self._fe._writer(
            s.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8"))
        return len(s)

    def flush(self) -> None:
        pass    # writer 侧直写 stdout.buffer 已带 flush


def _default_console(frontend: "TermFrontend"):
    """生产 console：经 _WriterFile 走 frontend.writer（UTF-8 字节串行出队）。

    force_terminal=True：CLI 输出恒为终端（面板边框/风险色 ANSI 直出），
    测试注入 StringIO console 时不受影响（适配器同样成立，渲染输出与
    字节流在测试里可分开断言）。宽度取当前终端列数。"""
    return Console(file=_WriterFile(frontend), force_terminal=True,
                   width=_term_size()[1])


def _clip_display(s: str, max_cols: int) -> str:
    """按显示列宽截断（CJK 全角计 2 列），保证状态行单行不折行。"""
    import unicodedata
    w = 0
    for i, ch in enumerate(s):
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if w > max_cols:
            return s[:i]
    return s


class _StatusLine:
    """任务期单行状态（转轮 + 计时 + token 计数）。

    绘制协议（Review Focus #3）：写任何内容前先 ``\\r\\x1b[K`` 擦本行，
    写完重画；erase/redraw 只对 active 态生效。文本形如
    ``⠋ 任务进行中 12s · in 1.2k / out 340``（estimated 时 ≈1.2k）。
    0.25s tick 由 TermFrontend._tick_loop 经 _outbox 入队 ("tick", None)
    （串行不撕裂），_render_loop 的 tick 分支调 redraw()。

    光标状态两比特（防覆盖流式文本的关键）：
    - _drawn：状态行当前在屏上，光标停在其行尾（可原位 ``\\r`` 刷新）；
    - _fresh：光标停在新空行（可安全落状态行）。
    流式 chunk 直写后两者皆否（光标在流式文本行中），redraw 跳过，
    状态行隐没到下一个收束点（面板/换行结尾的写入）再重现。
    """

    _FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"   # 转轮帧，每次 redraw 步进一格

    def __init__(self, frontend: "TermFrontend") -> None:
        self._frontend = frontend
        self.active = False
        self._label = "任务进行中"
        self._start = time.monotonic()
        self._frame = 0
        self._t_in = 0
        self._t_out = 0
        self._estimated = False
        self._drawn = False
        self._fresh = True

    def _writer(self, data: bytes) -> None:
        self._frontend._writer(data)

    def _text(self) -> str:
        el = max(0, int(time.monotonic() - self._start))
        parts = [f"{self._FRAMES[self._frame]} {self._label} {el}s"]
        if self._t_in or self._t_out:
            sign = "≈" if self._estimated else ""
            parts.append(f"in {sign}{_fmt_tokens(self._t_in)}"
                         f" / out {sign}{_fmt_tokens(self._t_out)}")
        return " · ".join(parts)

    def activate(self, label: str) -> None:
        self._label = label
        self._start = time.monotonic()
        self._frame = 0
        self._t_in = self._t_out = 0
        self._estimated = False
        self.active = True
        self.redraw()

    def update(self, tokens_in: int, tokens_out: int, estimated: bool) -> None:
        self._t_in = tokens_in
        self._t_out = tokens_out
        self._estimated = estimated
        self.redraw()

    def deactivate(self) -> None:
        # 先擦再置 False：擦除只对在屏状态行生效，顺序反了会把状态行留在屏上
        self.erase()
        self.active = False

    def reactivate(self) -> None:
        """编辑流等临时接管屏幕后复活：保留计时/计数（activate 会归零）。"""
        self.active = True
        self.redraw()

    def erase(self) -> None:
        """擦除在屏状态行（\\r\\x1b[K）；光标回到该行行首（视为新空行）。"""
        if not self._drawn:
            return
        self._drawn = False
        self._fresh = True
        self._writer(b"\r\x1b[K")

    def redraw(self) -> None:
        """重画：光标在新空行（落新行）或状态行在屏（原位刷新）时有效；
        流式行中（两者皆否）跳过，防止覆盖流式文本。"""
        if not self.active or not (self._fresh or self._drawn):
            return
        text = self._text()
        # \x1b[K 只清一行：状态行必须单行，超终端宽度时截断（窄终端防折行）
        text = _clip_display(text, max(1, _term_size()[1] - 1))
        self._frame = (self._frame + 1) % len(self._FRAMES)
        self._writer(f"\r{text}".encode("utf-8"))
        self._drawn = True
        self._fresh = False

    def note_write(self, data: bytes | str) -> None:
        """流式直写后同步光标状态：换行结尾 → 新空行；否则行中。

        裸 \\r 不算新空行：光标虽回行首，但该行仍有内容（进度条 \\r 帧），
        重画状态行会覆盖它——只有 \\n（新行）/erase（清行）产生 fresh。"""
        if isinstance(data, bytes):
            ended = data.endswith(b"\n")
        else:
            ended = data.endswith("\n")
        if ended:
            self._fresh = True
        else:
            self._fresh = False
            self._drawn = False

    @property
    def at_fresh_line(self) -> bool:
        """光标是否停在新空行（_print 据此决定是否先补换行收束）。"""
        return self._fresh


class CliRenderer:
    """内联渲染器：ServerMsg → 终端呈现（spec §3.2 映射表 + §3.4 零占位协议）。

    - 面板/单行文本经注入的 rich console 输出；_print 会先擦状态行再写、
      写完重画（若状态行还活着），防止 rich 输出与状态行互相覆盖。
    - 流式（ai_token/ai_think）与状态行不经 console：增量文本直接经
      frontend 的 writer 追加（think 用暗灰 ANSI \\x1b[2m…\\x1b[22m 包裹）。
    - ai_boundary → 立即 ``feed_msg(boundary_settled)``（零占位协议），
      padded/new_session 忽略；decide/task_fail/rescue_decide 是
      web 前端本地合成的事件词汇（core 不发），渲染器按 spec 词汇表
      防御性承接。
    - approval/rescue/ask_password/ask_host_key 渲染后进入本地截获态
      （frontend.capture.enter_*，按键语义由 _CaptureLayer 承接）。
    """

    def __init__(self, core, console, frontend=None):
        # frontend 允许缺省：取 core._frontend（CliCore 两段构造回填）；
        # TermFrontend 构造时显式传 self，形状更稳（Task 5 会再碰这里）
        self._core = core
        self._console = console
        self._frontend = frontend if frontend is not None \
            else getattr(core, "_frontend", None)
        self.status = _StatusLine(self._frontend) if self._frontend is not None \
            else None
        self._think_open = False   # 暗灰思考流开着（未收束）
        self._think_text = ""      # 当前思考段累计文本（定格行数的事实源）
        self._token_open = False   # 常规流式行开着（写过未换行）
        self._last_summary = ""    # final 与 ai_card 同文去重（对齐 web store）

    def _writer(self) -> object:
        if self._frontend is not None:
            return self._frontend._writer
        return _default_writer

    async def render(self, msg: ServerMsg) -> None:
        t = msg.type
        if t == "ready":
            self._on_ready(msg)
        elif t == "stage":
            self._on_stage(msg)
        elif t == "status":
            self._print(Text(msg.text))
        elif t == "usage":
            if self.status is not None:
                self.status.update(msg.tokens_in, msg.tokens_out,
                                   msg.estimated)
        elif t == "cmdset":
            self._on_cmdset(msg)
        elif t == "approval":
            self._on_approval(msg)
        elif t == "ask_password":
            self._on_ask_password(msg)
        elif t == "ask_host_key":
            self._on_ask_host_key(msg)
        elif t == "closed":
            self._on_closed()
        elif t == "event" and isinstance(msg.event, dict):
            await self._on_event(msg.event)
        # 未知 type 静默忽略（对齐 web handleEvent 的 default 分支）

    # --- ServerMsg type 分支 ---

    def _on_ready(self, msg: ServerMsg) -> None:
        """一行连接信息（spec §3.2 映射表原文）：interactive 字段存在且为
        1 → 「AI 就绪」；否则 → 「AI 不可用：shell 不支持集成」。"""
        body = Text.assemble(
            ("已连接 ", None),
            (msg.host or "?", "bold"),
            (f" {msg.user}" if msg.user else "", None),
            (f"（{msg.distro}）" if msg.distro else "", None),
            ("  [", None),
            ("AI 就绪", "green") if msg.interactive == 1
            else ("AI 不可用：shell 不支持集成", "red"),
            ("]", None),
        )
        self._print(body)

    def _on_stage(self, msg: ServerMsg) -> None:
        if msg.text == "agent_init":
            self._print(Text("正在初始化 Agent…", style="dim cyan"))
        elif msg.text:
            self._print(Text(f"连接阶段：{msg.text}", style="dim cyan"))

    def _on_cmdset(self, msg: ServerMsg) -> None:
        if msg.state == "running":
            self._print(Text(f"命令集 {msg.index}/{msg.total}",
                             style="cyan"))
        elif msg.state == "done":
            self._print(Text(f"命令集完成（{msg.total}/{msg.total}）",
                             style="cyan"))
        # paused：CLI 无「继续」入口，计划映射表未定义 → 静默

    def _on_approval(self, msg: ServerMsg) -> None:
        """审批框：risk=="high" 红色边框、"normal" 蓝色；同时进入本地
        截获态（_CaptureLayer 消费决策键）。"""
        border = "red" if msg.risk == "high" else "blue"
        title = "高危命令待审批" if msg.risk == "high" else "命令待审批"
        body = Text.assemble(
            ("理由：", "dim"), (msg.reasons or "—", None),
            (" · 主机：", "dim"), (msg.host or "—", None),
            ("\n", None),
            ("Enter 执行 · Backspace 拒绝 · e 编辑", "dim"),
        )
        self._print(Panel(
            Group(Syntax(msg.command, "bash", word_wrap=True,
                         theme="ansi_dark"), body),
            title=f"[bold {border}]{title}[/] · {msg.host}",
            title_align="left", border_style=border))
        if self._frontend is not None:
            # 编辑流预填源：enter_approval(risk) 调用形状被测试钉死不能
            # 加参，原命令经 frontend 属性传递（截获层 e 键时读取）
            self._frontend._pending_approval_command = msg.command
            self._frontend.capture.enter_approval(msg.risk or "high")

    def _on_ask_password(self, msg: ServerMsg) -> None:
        label = msg.label or "密码"
        self._print(Text.assemble((label, "bold"), ("（输入不回显，Enter 提交）",
                                                    "dim")))
        if self._frontend is not None:
            self._frontend.capture.enter_auth("password")

    def _on_ask_host_key(self, msg: ServerMsg) -> None:
        self._print(Text(msg.message or "未知主机指纹，是否信任？"))
        self._print(Text("按 y 信任并继续 / n 拒绝连接", style="dim"))
        if self._frontend is not None:
            self._frontend.capture.enter_auth("host_key")

    def _on_closed(self) -> None:
        self._flush_streams()
        self._print(Text("会话已结束", style="dim"))
        self._status_off()   # Task 3 已有 stop 逻辑，这里只收状态行

    # --- 事件分支 ---

    async def _on_event(self, ev: dict) -> None:
        kind = ev.get("kind")
        if kind == "task_start":
            self._flush_streams()
            self._think_text = ""
            self._last_summary = ""
            if self.status is not None:
                self.status.activate("任务进行中")   # 状态行点亮（计时开始）
        elif kind == "ai_token":
            self._on_ai_token(ev.get("text", ""))
        elif kind == "ai_think":
            self._on_ai_think(ev.get("text", ""))
        elif kind == "ai_collapse":
            self._on_ai_collapse(ev.get("command", ""))
        elif kind in ("final", "ai_card"):
            text = ev.get("text") or ev.get("markdown") or ""
            self._on_final_card(text)
        elif kind == "denied":
            self._fail_line(ev.get("text", ""), "✗", "bold red")
        elif kind == "limit":
            self._fail_line(ev.get("text", ""), "⚠", "bold yellow")
        elif kind in ("error", "task_fail"):
            self._fail_line(ev.get("text") or ev.get("reason", ""),
                            "✗", "bold red")
        elif kind == "rescue":
            self._on_rescue(ev)
        elif kind == "rescue_decide":
            self._on_rescue_decide(ev)
        elif kind == "decide":
            self._on_decide(ev)
        elif kind == "session_cleared":
            self._flush_streams()
            self._think_text = ""
            self._last_summary = ""
            self._print(Text("已开启新任务"))
        elif kind == "ai_boundary":
            # 零占位协议（§3.4）：无卡可结账，立即 ack 让命令注入零等待
            if self._core is not None:
                await self._core.feed_msg(ClientMsg(type="boundary_settled"))
        # padded / new_session / 未知事件 → 忽略（零占位协议）

    def _on_ai_token(self, text: str) -> None:
        """常规流式：增量文本直接经 writer 追加（不经 console）。"""
        if not text or self._frontend is None:
            return
        if self._think_open:
            # 暗灰思考流开着被 token 打断：先换行收束（摘要由 ai_collapse 定格）
            self._stream_write("\r\n")
            self._think_open = False
            self._think_text = ""
        elif self.status is not None and self.status.active:
            self.status.erase()   # 状态行让位：token 从其行首起写
        self._token_open = True
        self._stream_write(text)

    def _on_ai_think(self, text: str) -> None:
        """暗灰流式：\\x1b[2m…\\x1b[22m 包裹增量文本直接经 writer 追加。"""
        if not text or self._frontend is None:
            return
        if self._token_open:
            self._stream_write("\r\n")
            self._token_open = False
        elif self.status is not None and self.status.active:
            self.status.erase()   # 状态行让位：思考流从其行首起写
        if not self._think_open:
            self._think_open = True
            self._think_text = ""
        self._think_text += text
        self._stream_write(f"\x1b[2m{text}\x1b[22m")

    def _end_think(self) -> None:
        """思考段收束：定格一行摘要 `… 思考 N 行`（spec ai_collapse 映射）。"""
        if self._frontend is None:
            self._think_open = False
            self._think_text = ""
            return
        if self._think_open:
            self._stream_write("\r\n")
            self._think_open = False
        n = len([l for l in self._think_text.split("\n") if l.strip()])
        if n:
            self._stream_write(f"… 思考 {n} 行\r\n")
        self._think_text = ""

    def _on_ai_collapse(self, command: str) -> None:
        """段落定格：先收思考段，再呈现 AI 发起的命令面板（原 web 卡片头）。"""
        self._end_think()
        if not command:
            return
        body = Text.assemble(
            ("$ ", "dim"), (command, None), ("\n", None),
            ("（AI 发起执行，输出见上方终端）", "dim"),
        )
        self._print(Panel(body, title="▶ 执行", title_align="left",
                          border_style="cyan"))

    def _flush_streams(self) -> None:
        """final/error/denied/limit/task_fail/closed 前收束进行中的流式行。"""
        self._end_think()
        if self._token_open:
            if self._frontend is not None:
                self._stream_write("\r\n")
            self._token_open = False

    def _on_final_card(self, text: str) -> None:
        self._flush_streams()
        if not text or text == self._last_summary:
            return
        self._last_summary = text
        self._summary_panel(text)
        self._status_off()

    def _summary_panel(self, text: str) -> None:
        """总结框（render.print_summary 等价，但经本前端 console——不改
        render.py）。rich Markdown 渲染（markdown 包缺失时 Text 兜底）；
        final 与 ai_card 连发同一份 markdown，同文去重（_on_final_card）。"""
        try:
            from rich.markdown import Markdown
            content = Markdown(text)
        except ImportError:     # rich.markdown 缺依赖（markdown 包）→ 纯文本
            content = Text(text)
        self._print(Panel(content, title="[bold green]📝 总结[/]",
                          title_align="left", border_style="green"))

    def _fail_line(self, text: str, symbol: str, style: str) -> None:
        """denied/limit/error/task_fail：红/黄单行 + 状态行定格。"""
        self._flush_streams()
        body = Text.assemble((f"{symbol} ", style), (text, None))
        self._print(body)
        self._status_off()

    def _status_off(self) -> None:
        if self.status is not None:
            self.status.deactivate()

    def _on_decide(self, ev: dict) -> None:
        """决策回执：审批框原位收回执行（web store decide 事件的 CLI 呈现，
        词汇表内；core 不发该事件，由 Task 5 截获层本地合成或防御性承接）。"""
        self._flush_streams()
        d = ev.get("decision") or {}
        typ = d.get("type") if isinstance(d, dict) else d
        if typ == "reject":
            self._print(Text("✗ 已拒绝", style="bold red"))
        else:
            self._print(Text("✓ 已执行", style="bold green"))

    def _on_rescue(self, ev: dict) -> None:
        """救援面板：失败行 + 退出码 + 输出尾部；同时进入本地截获态。"""
        self._flush_streams()
        out = (ev.get("output") or "").strip()
        out_tail = "\n".join(out.splitlines()[-12:])   # 只展示输出尾部
        body = Text.assemble(
            ("失败命令：", "dim"), (ev.get("line", ""), None), ("\n", None),
            ("退出码：", "dim"), (str(ev.get("ec", "?")), "bold"), ("\n", None),
            (out_tail, "dim") if out_tail else ("（无输出）", "dim"),
        )
        self._print(Panel(body, title="[bold red]命令失败救援[/]",
                          title_align="left", border_style="red"))
        if self._frontend is not None:
            self._frontend.capture.enter_rescue()

    def _on_rescue_decide(self, ev: dict) -> None:
        """救援面板收回单行定格（web store rescue_decide 语义）。"""
        self._flush_streams()
        if ev.get("accept"):
            self._print(Text("✓ 已交给 AI", style="bold green"))
        else:
            self._print(Text("已忽略"))

    def _stream_write(self, data: str) -> None:
        """流式直写（经 writer，不经 console）；同步状态行光标状态。"""
        b = data.encode("utf-8")
        self._writer()(b)
        if self.status is not None:
            self.status.note_write(b)

    def _print(self, renderable) -> None:
        """console 输出统一入口：擦状态行 → 写 → 重画（状态行 active 时），
        保证 rich 面板与状态行/PTY 字节不互相覆盖（Review Focus #3）。"""
        if self.status is not None:
            self.status.erase()
            if not self.status.at_fresh_line:
                self._stream_write("\r\n")   # 行中收起新行，防面板接半行
        self._console.print(renderable)
        if self.status is not None:
            self.status.redraw()


def _default_writer(data: bytes) -> None:
    try:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, ValueError):
        pass    # stdout 已关闭（管道消费端退出等）：丢弃


class TermFrontend:
    """raw stdin 泵 + 串行渲染 outbox + 生命周期。

    reader 契约：``async () -> bytes``，返回 b"" = EOF 停泵；默认 POSIX
    用 loop.add_reader(sys.stdin) + os.read，win32 用
    run_in_executor(_read_one_key)。
    writer 契约：``(bytes) -> None`` 同步写；默认 stdout.buffer 直写。
    """

    def __init__(self, core: PipelineCore, *, reader=None, writer=None,
                 console=None) -> None:
        self.core = core
        self._outbox: asyncio.Queue = asyncio.Queue()
        self._stop = asyncio.Event()
        self._capture = _CaptureLayer(self)
        self._writer = writer if writer is not None else _default_writer
        self._console = console if console is not None \
            else _default_console(self)   # 生产 rich Console（经 writer 适配器）
        self._renderer = CliRenderer(core, self._console, frontend=self)
        self.status = self._renderer.status   # _StatusLine（bytes 分支擦除协议）
        # stdin reader 账目必须在 _make_default_reader 之前清零：_posix_reader
        # 构造期就注册 add_reader 并写入 _stdin_fd/_stdin_cb（审查 B2：曾因
        # 后置初始化把账目抹掉，_remove_stdin_reader 永远 no-op）
        self._stdin_fd: int | None = None
        self._stdin_cb = None      # add_reader 回调（编辑流摘挂/重挂用）
        self._reader = reader if reader is not None \
            else self._make_default_reader()
        self._winch_installed = False
        self._raw_state = None     # termios 状态（Task 5 编辑流交接复用）
        self._pump_paused = False  # 编辑流期间泵停读标志（交接顺序可观测）
        self._pending_approval_command = ""   # 待决审批原命令（编辑预填）
        self._status_was_active = False   # 编辑流前状态行是否在屏（复活用）

    @property
    def capture(self) -> _CaptureLayer:
        """本地截获层：渲染器经它进入审批/rescue/认证待决态；输入泵经它
        路由键盘字节（决策键消费、剩余字节直通）。"""
        return self._capture

    # --- 默认 IO 原语 ---

    def _make_default_reader(self):
        if sys.platform == "win32":
            return self._win_reader
        return self._posix_reader()

    def _posix_reader(self):
        """POSIX 默认 reader：loop.add_reader(stdin) + os.read。

        构造期注册（TermFrontend 须在事件循环内构造——cli._run_pipeline
        即 async 上下文）；fd 就绪回调把字节塞队列，reader 协程按序取。
        EOF（os.read 返回 b""：管道关闭 / 重定向 stdin 结束）原样传 b""
        给泵停摆。回调/队列挂 self：编辑流 _run_edit 需要摘挂同一注册。"""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        fileno = sys.stdin.fileno()

        def _on_readable() -> None:
            try:
                data = os.read(fileno, 4096)
            except BlockingIOError:
                return
            except OSError:
                data = b""
            queue.put_nowait(data)

        loop.add_reader(fileno, _on_readable)
        self._stdin_fd = fileno
        self._stdin_cb = _on_readable

        async def _reader() -> bytes:
            return await queue.get()

        return _reader

    async def _win_reader(self) -> bytes:
        loop = asyncio.get_running_loop()
        ch = await loop.run_in_executor(None, _read_one_key)
        if not ch or ch == b"\x1a":   # None / Ctrl+Z（win32 EOF）→ 停泵
            return b""
        if ch in (b"\x00", b"\xe0"):
            # 特殊键（方向键/功能键）前缀字节：续读第二字节原样透传，
            # 绝不能当 EOF（msvcrt 的 EOF 是 \x1a，前缀是 \x00/\xe0）
            ch2 = await loop.run_in_executor(None, _read_one_key)
            return ch + (ch2 or b"")
        return ch

    # --- 生命周期 ---

    async def run(self) -> None:
        # 非 tty（pytest / 管道喂入）跳过 termios——置 raw 会失败且无意义
        state = _set_raw_input() if sys.stdin.isatty() else None
        self._raw_state = state
        tasks: list[asyncio.Task] = []
        try:
            rows, cols = _term_size()
            # 初始 resize 先行入队：feed_msg 只入核心 _inbox，attach 前排队、
            # session 未就绪时 _dispatch 安全跳过（Review Focus #6）
            await self.core.feed_msg(
                ClientMsg(type="resize", rows=rows, cols=cols))
            self._install_winch()
            # CliCore 的 emit 不进核心 outbox；sender_loop 对 None sink 空转
            self.core.attach(None)
            render = asyncio.create_task(self._render_loop())
            pump = asyncio.create_task(self._input_pump())
            ticker = asyncio.create_task(self._tick_loop())
            tasks = [render, pump, ticker]
            waiter = asyncio.ensure_future(self._stop.wait())
            try:
                while not self._stop.is_set():
                    done, _pending = await asyncio.wait(
                        {waiter, render, pump},
                        return_when=asyncio.FIRST_COMPLETED)
                    if self._stop.is_set():
                        break
                    # 泵/渲染死亡而 _stop 未置 → 向外传播（finally 先还原
                    # 终端再抛，Review Focus #1 异常路径）
                    for t in done:
                        if t is waiter or t.cancelled():
                            continue
                        exc = t.exception()
                        if exc is not None:
                            raise exc
            finally:
                waiter.cancel()
        finally:
            self._stop.set()
            for t in tasks:
                t.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._remove_winch()
            self._remove_stdin_reader()
            try:
                _restore_input(state)
            finally:
                # 收尾换行必须执行：即使 tcsetattr 抛（fd 失效等）也不能
                # 跳过，且不掩盖主异常
                try:
                    self._writer(b"\r\n")
                except Exception:  # noqa: BLE001 - 收尾换行失败不掩盖主异常
                    pass

    def _remove_stdin_reader(self) -> None:
        """注销默认 POSIX reader 的 add_reader（同一 loop 内多次连接不残留
        旧 fd 监听；注入假 reader 时 _stdin_fd 为 None，no-op）。"""
        if self._stdin_fd is None:
            return
        fd, self._stdin_fd = self._stdin_fd, None
        self._stdin_cb = None
        try:
            asyncio.get_running_loop().remove_reader(fd)
        except RuntimeError:
            pass    # loop 已关闭

    def _suspend_stdin_reader(self) -> None:
        """编辑流前摘掉 stdin 的 loop 监听（不注销账目，_resume 可重挂）。

        不摘的后果（审查 B1 实证）：① prompt_toolkit 在 executor 里读同一
        fd，add_reader 的 os.read 与之抢键——抢到的字节进 reader 队列，
        编辑器拿不到，编辑结束后又被泵喂进 PTY；② 编辑期 termios 是
        cooked（_restore_input 有意交还），canonical 模式下 os.read 会阻塞
        到整行——用户敲半行没回车，整个事件循环冻结在 read 系统调用里。"""
        if self._stdin_fd is None:
            return
        try:
            asyncio.get_running_loop().remove_reader(self._stdin_fd)
        except RuntimeError:
            pass    # loop 已关闭

    def _resume_stdin_reader(self) -> None:
        """编辑流后重挂 stdin 监听（与 _posix_reader 同一回调/账目）。"""
        if self._stdin_fd is None or self._stdin_cb is None:
            return
        try:
            asyncio.get_running_loop().add_reader(
                self._stdin_fd, self._stdin_cb)
        except RuntimeError:
            pass    # loop 已关闭

    # --- 渲染：与 PTY 字节共用同一串行 outbox（不撕裂）---

    async def _render_loop(self) -> None:
        while True:
            kind, payload = await self._outbox.get()
            if kind == "bytes":
                # 擦除协议（Review Focus #3）：写 PTY 字节前擦状态行；
                # 写完按尾字符同步光标状态（note_write）——无尾换行的
                # payload（进度条 \r 帧 / 半行回显）光标在行中，此刻
                # redraw 会原位覆盖 PTY 输出，绝不能重画（与流式 token
                # 路径同一笔账）；有尾换行时 fresh 恢复，下个 tick 重画
                self.status.erase()
                self._writer(payload)
                self.status.note_write(payload)
            elif kind == "msg":
                await self._on_msg(payload)
                if payload.type == "closed":
                    self._stop.set()   # 先渲染后停
                    return
            elif kind == "tick":
                # 状态行 0.25s 重画（仅 active 态写屏；与 PTY 字节串行）
                self.status.redraw()

    async def _on_msg(self, msg: ServerMsg) -> None:
        """结构化消息钩子：委托 CliRenderer.render（事件→呈现映射）。"""
        await self._renderer.render(msg)

    # --- 状态行 tick（0.25s）---

    async def _tick_loop(self) -> None:
        """状态行重画节拍：仅 active 时经 _outbox 入队 ("tick", None)，
        由 _render_loop 串行消费重画——tick 与 PTY 字节/渲染共用同一队列，
        不撕裂（Review Focus #3）。deactivate 后自动静默。"""
        try:
            while True:
                await asyncio.sleep(0.25)
                if self.status is not None and self.status.active:
                    self._outbox.put_nowait(("tick", None))
        except asyncio.CancelledError:
            raise

    # --- 输入泵 ---

    async def _input_pump(self) -> None:
        try:
            while not self._stop.is_set():
                data = await self._reader()
                if not data:            # b"" = EOF（管道关闭 / Ctrl+Z）
                    self._stop.set()
                    return
                kind, rest = self._capture.on_keys(data)
                while kind == "edit":
                    # 截获层请求编辑流：内联 await 本协程内完成——泵在此
                    # 期间自然停读，不会与 prompt_toolkit 并发抢 stdin
                    # （纪律 #5）；余量（e 键同 chunk 剩余）编辑后继续路由
                    await self._run_edit()
                    kind, rest = self._capture.on_keys(rest) if rest \
                        else ("pass", b"")
                if kind == "pass" and rest:
                    await self.core.feed_input(rest)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - 泵死亡记日志后向外传播：
            # run() 对 _stop/泵任务的等待会感知（finally 还原终端后抛出），
            # 不允许裸抛打死 run() 的清理路径。前缀 \r\n：raw 态无 ONLCR，
            # 直接打 stderr 会阶梯错位
            print(f"\r\n[ot] 输入泵异常：{type(e).__name__}: {e}",
                  file=sys.stderr, flush=True)
            raise

    # --- 审批编辑流（截获层 e 键）---

    async def _run_edit(self) -> None:
        """审批编辑流。termios 交接顺序（Review Focus #5，测试钉死）：

        暂停泵 → _restore_input → prompt_toolkit 多行输入 → _set_raw_input
        → 恢复泵 → feed_msg。

        泵暂停 = _input_pump 内联 await 本协程（单泵串行，无并发抢 stdin）；
        异常/EOF/取消路径经 finally 同样恢复泵并重新置 raw，编辑结果为空
        时回待决态不发决策。结果过 approval.reclassify_edited：deny →
        reject（message="编辑后命令被策略拒绝"）+ 红行；approve 级 →
        approve；其余 → edit_decision(new)。
        """
        cap = self._capture
        original = cap.pending_command
        self._pump_paused = True
        self._status_was_active = self.status.active if self.status is not None \
            else False
        new: str | None = None
        try:
            try:
                # 摘 stdin 监听必须先于 _restore_input：cooked 模式下
                # add_reader 的 os.read 会阻塞冻结整 loop（审查 B1）
                self._suspend_stdin_reader()
                _restore_input(self._raw_state)
                self._raw_state = None
                if self.status is not None:
                    self.status.deactivate()   # 提示行前清屏（prompt 接管显示）
                new = await self._prompt_edit(original)
            except (EOFError, KeyboardInterrupt, Exception):  # noqa: BLE001
                new = None    # EOF/取消/异常 → 回待决态不发决策
        finally:
            # 重新置 raw（仅 tty；非 tty 生产路径即 pytest/管道，保持 None）
            self._raw_state = _set_raw_input() if sys.stdin.isatty() else None
            self._resume_stdin_reader()   # 先重挂监听再放泵（泵随后 await reader）
            self._pump_paused = False   # 恢复泵（feed_msg 之前，顺序钉死）
        if new is None or not new.strip():
            cap.cancel_edit()
            self._status_reactivate()   # 任务还在跑：状态行复活
            return
        d = reclassify_edited(new, self.core.policy)
        if d.level == "deny":
            self._capture_notice("✗ 编辑后的命令被策略拒绝")
            cap.send_reject("编辑后命令被策略拒绝")   # 任务将终止：状态行不复活
        elif d.level == "approve":
            cap.send_approve()
            self._status_reactivate()
        else:
            cap.send_edit(new)
            self._status_reactivate()

    def _status_reactivate(self) -> None:
        """编辑流结束后复活状态行（任务继续跑的路径）：reactivate 不清
        计时/计数（activate 会归零，审查 minor 4）。任务终止路径不调用。"""
        if self.status is not None and self._status_was_active:
            self.status.reactivate()

    async def _prompt_edit(self, original: str) -> str:
        """prompt_toolkit 多行编辑（termios 已交还 cooked）。风格对齐
        cli._make_prompt_session/_prompt_text（executor 内跑 session.prompt），
        但不 import cli——Task 6/7 会动 cli。Esc+Enter 提交（multiline
        惯例），Ctrl+D/Ctrl+C 取消（上层回待决态）。"""
        from prompt_toolkit import PromptSession
        session = PromptSession(multiline=True)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, lambda: session.prompt("编辑命令（Esc+Enter 提交 · "
                                         "Ctrl+D 取消）:\n",
                                         default=original))

    def _capture_notice(self, text: str) -> None:
        """截获层本地提示行（confirming 二次确认 / 编辑拒绝红字）：走渲染器
        _print 协议（擦状态行→写→重画），不经 PTY。"""
        self._renderer._print(Text(text, style="bold red"))

    # --- SIGWINCH ---

    def _install_winch(self) -> None:
        # win32 无 SIGWINCH：跳过（尺寸变化不感知，防御性降级）
        if sys.platform == "win32" or not hasattr(signal, "SIGWINCH"):
            return
        loop = asyncio.get_running_loop()
        try:
            loop.add_signal_handler(signal.SIGWINCH, self._on_winch)
            self._winch_installed = True
        except (NotImplementedError, ValueError, RuntimeError):
            pass    # 平台不支持 / 非主线程：无 SIGWINCH 也能跑

    def _remove_winch(self) -> None:
        if not self._winch_installed:
            return
        self._winch_installed = False
        try:
            asyncio.get_running_loop().remove_signal_handler(signal.SIGWINCH)
        except (NotImplementedError, RuntimeError, ValueError):
            pass

    def _on_winch(self) -> None:
        # 信号上下文不做 await：create_task 包装排队进核心
        rows, cols = _term_size()
        if self._console is not None:
            # _WriterFile 非 tty，rich 无法自探宽度：winch 时同步刷新，
            # 否则 resize 后 Panel/总结框仍按构造期宽度渲染
            try:
                self._console.width = cols
            except Exception:  # noqa: BLE001 - 假 console 不可写宽度时忽略
                pass
        asyncio.create_task(self.core.feed_msg(
            ClientMsg(type="resize", rows=rows, cols=cols)))


# --- raw 原语（自 rawmode.py 复制；rawmode.py 旧 CLI 还在用，Task 7 一并删）---

def _set_raw_input():
    if sys.platform == "win32":
        return None
    import termios
    import tty
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setraw(fd)
    return fd, old


def _restore_input(state) -> None:
    if state is None:
        return
    import termios
    fd, old = state
    termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _read_one_key() -> bytes | None:
    if sys.platform == "win32":
        import msvcrt
        return msvcrt.getwch().encode("utf-8", errors="replace")
    import os
    return os.read(sys.stdin.fileno(), 1)


def _term_size() -> tuple[int, int]:
    import shutil
    try:
        sz = shutil.get_terminal_size()
        return sz.lines, sz.columns
    except Exception:
        return 40, 120
