"""raw 终端透传：键盘 → PTY/SSH 通道，通道输出 → 屏幕；Ctrl+O 退出。

输出统一走 session._read_some()（LocalPtySession/SshPtySession 都实现），
因此对本地与 SSH 目标同样有效；输入侧 POSIX 用 termios 置 raw + 阻塞读，
Windows 用 msvcrt。
"""

from __future__ import annotations

import asyncio
import sys

CTRL_O = b"\x0f"


async def run_raw(session, initial: bytes | None = None) -> None:
    """进入 raw 终端模式；initial 为进入后先发送的字节（如交互命令的行）。"""
    loop = asyncio.get_running_loop()
    old_attrs = _set_raw_input()
    await session.resize(*_term_size())
    stop = asyncio.Event()

    async def pump_output() -> None:
        while not stop.is_set():
            try:
                data = await session._read_some(0.2)
            except asyncio.TimeoutError:
                continue
            except (ConnectionError, EOFError):
                break
            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()

    async def pump_input() -> None:
        if initial:
            await session.send_raw(initial)
        while not stop.is_set():
            ch = await loop.run_in_executor(None, _read_one_key)
            if ch is None or ch == CTRL_O:
                stop.set()
                break
            await session.send_raw(ch)

    output_task = asyncio.create_task(pump_output())
    input_task = asyncio.create_task(pump_input())
    await input_task
    stop.set()
    output_task.cancel()
    await asyncio.gather(output_task, return_exceptions=True)
    _restore_input(old_attrs)
    sys.stdout.write("\r\n")
    sys.stdout.flush()


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
