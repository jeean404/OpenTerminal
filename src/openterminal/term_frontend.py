"""CLI 终端前端（骨架）：核心 ↔ stdin/stdout 适配。

单管线核心（openterminal.core.PipelineCore）的零卡片终端前端：
- CliCore：emit_msg/emit_bytes/_emit_nowait 覆写为进前端串行渲染 outbox
  （核心自身 outbox/sender_loop 对 None sink 空转）；
- TermFrontend：raw 输入泵（键盘字节 → core.feed_input）、串行渲染
  outbox（("bytes", d) → writer 直写；("msg", m) → _on_msg 钩子）、
  初始 resize、SIGWINCH、closed 停止；finally 还原 termios + 移除
  信号处理（KeyboardInterrupt/渲染异常/EOF/正常 closed 四条退出路径
  都必须走完，否则用户 shell 留在 raw 态）。

设计见 docs/superpowers/specs/2026-09-27-cli-single-pipeline-design.md
§3.1/§3.2。本文件为 Task 3 骨架，桩位（后续任务接手点）：
- _on_msg / self._renderer / self.status：Task 4 接 CliRenderer +
  _StatusLine（("msg", m) 委托渲染器；bytes 前后接 status.erase()/
  redraw() 擦除协议；("tick", None) 分支重画状态行）；
- _CaptureLayer：Task 5 换成本地截获层（审批/rescue/认证/中断），
  当前 on_keys 恒 ("pass", data) 全量直通；enter_approval/enter_rescue/
  enter_auth 为 no-op（Task 4 渲染器会先按此形状调用）；
- _run_edit：Task 5 编辑流（("edit", None) 分支接线点已留注释）。

raw 原语四件（_set_raw_input/_restore_input/_read_one_key/_term_size）
自 rawmode.py 复制为私有函数——rawmode.py 旧 CLI 还在用，一个字节不动，
Task 7 删除旧管线时一并退场。
"""
from __future__ import annotations

import asyncio
import os
import signal
import sys

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
    """本地截获层桩（Task 5 实现审批/rescue/认证/Ctrl+C 语义）。

    当前恒 ("pass", data)：键盘字节全量直通 PTY，分类由 hook 终裁。
    Task 5 接手形状：on_keys(data) -> ("pass", 剩余直通字节) |
    ("edit", None)；enter_approval(risk)/enter_rescue()/enter_auth(kind)
    由渲染器在进入对应待决态时调用，exit_* 对应清除，state 为当前
    截获态（None = 无截获）。
    """

    def __init__(self, frontend: "TermFrontend") -> None:
        self._frontend = frontend
        self.state: str | None = None

    def on_keys(self, data: bytes) -> tuple[str, object]:
        return ("pass", data)

    def enter_approval(self, risk: str) -> None:
        pass

    def enter_rescue(self) -> None:
        pass

    def enter_auth(self, kind: str) -> None:
        pass


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
        self._renderer = None      # Task 4：CliRenderer（_on_msg 委托对象）
        self.status = None         # Task 4：_StatusLine
        self._console = console    # Task 4：rich Console（测试注入 StringIO）
        self._reader = reader if reader is not None \
            else self._make_default_reader()
        self._writer = writer if writer is not None else _default_writer
        self._winch_installed = False
        self._raw_state = None     # termios 状态（Task 5 编辑流交接复用）
        self._stdin_fd: int | None = None   # 默认 reader 注册的 fd（退出清理）

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
        给泵停摆。"""
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
            tasks = [render, pump]
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
        try:
            asyncio.get_running_loop().remove_reader(fd)
        except RuntimeError:
            pass    # loop 已关闭

    # --- 渲染：与 PTY 字节共用同一串行 outbox（不撕裂）---

    async def _render_loop(self) -> None:
        while True:
            kind, payload = await self._outbox.get()
            if kind == "bytes":
                # Task 4 擦除协议接线点：status.erase() → write →
                # status.redraw()（骨架期 status 未建，直写）
                self._writer(payload)
            elif kind == "msg":
                await self._on_msg(payload)
                if payload.type == "closed":
                    self._stop.set()   # 先渲染后停
                    return
            # kind == "tick"：Task 4 状态行 0.25s 重画（骨架期忽略）

    async def _on_msg(self, msg: ServerMsg) -> None:
        """结构化消息钩子（Task 4 委托 self._renderer.render(msg)）。"""
        return None

    # --- 输入泵 ---

    async def _input_pump(self) -> None:
        try:
            while not self._stop.is_set():
                data = await self._reader()
                if not data:            # b"" = EOF（管道关闭 / Ctrl+Z）
                    self._stop.set()
                    return
                kind, rest = self._capture.on_keys(data)
                if kind == "pass" and rest:
                    await self.core.feed_input(rest)
                # kind == "edit"：Task 5 接线（await self._run_edit()）
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - 泵死亡记日志后向外传播：
            # run() 对 _stop/泵任务的等待会感知（finally 还原终端后抛出），
            # 不允许裸抛打死 run() 的清理路径。前缀 \r\n：raw 态无 ONLCR，
            # 直接打 stderr 会阶梯错位
            print(f"\r\n[ot] 输入泵异常：{type(e).__name__}: {e}",
                  file=sys.stderr, flush=True)
            raise

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
