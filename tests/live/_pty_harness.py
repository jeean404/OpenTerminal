"""PTY live 测试 harness：PtyApp——把一个子进程放进真 pty 里驱动。

契约（计划 Task 8 Interfaces）：
- ``PtyApp(argv, env=None)``：pty.openpty + subprocess，slave 作子进程
  stdin/stdout/stderr（preexec_fn 里 setsid + TIOCSCTTY 把 slave 设为控制
  终端——交互程序/termios raw 态需要真 ctty）；
- ``send(data: bytes)``：master 侧写入（= 子进程键盘输入）；
- ``expect(pattern, timeout=10) -> re.Match``：对累积屏文本 regex 搜索，
  超时抛 AssertionError 并附最近 2000 字符屏文本——输出准确性取证；
- ``expect_absent(pattern, within=1.0)``：等待 within 秒（持续读流），
  期间新到的屏文本里不得出现 pattern（「无残留」断言的语义：任务收尾后
  不得再有新的状态行绘制——屏缓冲是累积的，历史绘制仍在其中）；
- ``screen() -> str``：累积屏文本（含 ANSI 转义序列，未清洗——断言按
  富文本实际字节做，取证不美化）；
- ``close()`` / 上下文管理器：先关 master（子进程 stdin 得到 EOF，走
  正常退出路径），宽限 5s 后升级 SIGKILL（杀进程组）。

读侧用独立线程持续排空 master：driver 进程输出量大（hook 注入分片回显
~700B/片），不排空会顶满 pty 输出缓冲 → 子进程写阻塞 → 死锁（同
test_hook_classify_live 的手法）。
"""
from __future__ import annotations

import fcntl
import os
import pty
import re
import signal
import struct
import subprocess
import termios
import threading
import time


class PtyApp:
    """在真 pty 里跑一个子进程，逐字节累积屏文本，regex 期待驱动。"""

    def __init__(self, argv: list[str], env: dict | None = None,
                 rows: int = 44, cols: int = 120) -> None:
        self._master, slave = pty.openpty()
        # 窗口尺寸：driver 侧 rich Console 宽度与 _term_size 都取自 pty
        # winsize（COLUMNS/LINES 已在测试 env 里剔除），固定尺寸让断言稳定
        fcntl.ioctl(slave, termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, cols, 0, 0))

        def _ctty() -> None:  # pragma: no cover - 子进程内执行
            os.setsid()
            try:
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            except (AttributeError, OSError):
                pass  # 平台无 TIOCSCTTY：raw 态/信号仍可用，仅缺 ctty 语义

        self._proc = subprocess.Popen(
            argv, stdin=slave, stdout=slave, stderr=slave,
            env=env if env is not None else dict(os.environ),
            preexec_fn=_ctty, close_fds=True)
        os.close(slave)  # 父进程只留 master；slave 是子进程的

        self._buf = bytearray()
        self._lock = threading.Lock()
        self._dead = False
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    # --- 读线程：持续排空 master ---

    def _pump(self) -> None:
        import select

        while not self._dead:
            try:
                r, _, _ = select.select([self._master], [], [], 0.05)
            except (OSError, ValueError):
                break
            if not r:
                continue
            try:
                chunk = os.read(self._master, 65536)
            except OSError:
                break   # master 关闭 / 子进程退出（EIO）
            if not chunk:
                break
            with self._lock:
                self._buf.extend(chunk)

    # --- 屏文本 ---

    def screen(self) -> str:
        with self._lock:
            return bytes(self._buf).decode("utf-8", "replace")

    def tail(self, n: int = 2000) -> str:
        return self.screen()[-n:]

    # --- 输入 ---

    def send(self, data: bytes) -> None:
        os.write(self._master, data)

    # --- 期待 ---

    def expect(self, pattern: "str | re.Pattern[str]",
               timeout: float = 10.0) -> "re.Match[str]":
        rx = pattern if isinstance(pattern, re.Pattern) else re.compile(pattern)
        deadline = time.monotonic() + timeout
        while True:
            m = rx.search(self.screen())
            if m is not None:
                return m
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"expect 超时（{timeout}s）：{rx.pattern!r} 未出现在屏上；"
                    f"最近 {2000} 字符屏文本：\n{self.tail(2000)!r}")
            time.sleep(0.05)

    def expect_optional(self, pattern: "str | re.Pattern[str]",
                        timeout: float = 3.0) -> "re.Match[str] | None":
        """等待 pattern 至多 timeout 秒；出现返回 Match，否则返回 None
        （用于「先探测再继续」的取证型断言：缺陷现场要在继续跑完后续
        步骤后一并上报，不能中途炸掉丢证据）。"""
        rx = pattern if isinstance(pattern, re.Pattern) else re.compile(pattern)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            m = rx.search(self.screen())
            if m is not None:
                return m
            time.sleep(0.05)
        return None

    def expect_absent(self, pattern: "str | re.Pattern[str]",
                      within: float = 1.0) -> None:
        """within 秒内新到的屏文本不得出现 pattern（见模块 docstring 的
        「无残留」语义）。命中即 AssertionError 并附命中处前后文。"""
        rx = pattern if isinstance(pattern, re.Pattern) else re.compile(pattern)
        with self._lock:
            start = len(self._buf)
        deadline = time.monotonic() + within
        while time.monotonic() < deadline:
            time.sleep(0.05)
        with self._lock:
            fresh = bytes(self._buf[start:]).decode("utf-8", "replace")
        m = rx.search(fresh)
        if m is not None:
            raise AssertionError(
                f"expect_absent 失败：{rx.pattern!r} 在 {within}s 内出现"
                f"于新输出；现场：\n{fresh[max(0, m.start() - 200):m.end() + 200]!r}")

    # --- 生命周期 ---

    def close(self, grace: float = 5.0) -> None:
        self._dead = True
        try:
            os.close(self._master)   # 子进程 stdin/stdout 得到 EOF → 正常退出路径
        except OSError:
            pass
        try:
            self._proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self._proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover
                pass
        self._reader.join(timeout=3)

    def __enter__(self) -> "PtyApp":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
