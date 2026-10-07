#!/usr/bin/env python3
"""终端 demo 录制：pty.fork 起 serve_terminal.py，脚本化按键并把全部
输出字节按时间戳记成 asciinema v2 格式的 .cast（无需安装 asciinema）。

用法::

    python tools/demo-recorder/record_terminal.py /tmp/ot-term.cast

剧情与 record.cjs（web 版）对齐：plain 彩色命令 → 自然语言任务 → 思考/
分析流式 → 审批面板停顿 → Enter 执行 → 真输出 + 总结卡 → /exit 收尾。
等待一律事件驱动（wait_for 输出子串），不停死等固定秒数。
"""
from __future__ import annotations

import fcntl
import json
import os
import pathlib
import pty
import select
import struct
import sys
import time
import termios

REPO = pathlib.Path(__file__).resolve().parents[2]
SERVE = REPO / "tools" / "demo-recorder" / "serve_terminal.py"

ROWS, COLS = 30, 100
READY_MARK = "shell 集成已就绪"             # ready 提示语：interactive=1 才出现；
                                           # 注入期（探针+27 分片）打字会混进注入流
APPROVAL_MARK = "待审批"                    # term_frontend 审批框标题
FINAL_MARK = "聚合完成"                     # DemoRunner 总结卡首句
TASK_TEXT = "看看 /tmp/ot-demo 下哪些目录最占空间，给我一张表"


class Recorder:
    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.t0 = time.monotonic()
        self.events: list[list] = []
        self._seen = ""                      # 输出尾部缓冲（wait_for 用）

    def _record(self, data: bytes) -> None:
        self.events.append([round(time.monotonic() - self.t0, 4), "o",
                            data.decode("utf-8", errors="replace")])

    def _pump(self, seconds: float) -> None:
        """读 fd 若干秒，边读边记账；EOF/EIO 静默（子进程收尾竞态）。"""
        deadline = time.monotonic() + seconds
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                return
            r, _, _ = select.select([self.fd], [], [], min(remain, 0.05))
            if not r:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                raise EOFError("pty closed")
            if data == b"":
                raise EOFError("pty closed")
            self._record(data)
            self._seen = (self._seen + data.decode("utf-8", errors="replace"))[-8192:]

    def wait_for(self, marker: str, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while marker not in self._seen:
            if time.monotonic() > deadline:
                raise TimeoutError(f"等待 {marker!r} 超时（已见尾部："
                                   f"{self._seen[-200:]!r}）")
            self._pump(0.1)

    def type(self, text: str, delay: float = 0.035) -> None:
        for ch in text:
            os.write(self.fd, ch.encode("utf-8"))
            self._pump(delay)

    def press(self, key: str) -> None:
        os.write(self.fd, key.encode("utf-8"))
        self._pump(0.25)


def main() -> None:
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ot-term.cast")

    pid, fd = pty.fork()
    if pid == 0:                              # child：demo CLI（stdio=pty slave）
        os.chdir(REPO)
        os.environ.setdefault("OPENTERMINAL_HOME", "/tmp/ot-demo-home")
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        # 中性用户名：_connect 对 local 目标用 getpass.getuser() 填 ready 行，
        # 而它优先读环境变量——比 ZDOTDIR 提示符更隐蔽的一处泄漏
        for k in ("USER", "LOGNAME", "USERNAME"):
            os.environ[k] = "demo"
        os.execv(sys.executable, [sys.executable, str(SERVE)])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    rec = Recorder(fd)
    exit_code = 0
    try:
        rec.wait_for(READY_MARK, timeout=90)          # hook 注入完成才算就绪：
        rec._pump(1.4)                                # 注入期打字会混进注入流

        # beat 1：plain 命令，彩色输出
        rec.type("ls /tmp/ot-demo", delay=0.03)
        rec.press("\r")
        rec._pump(2.6)

        # beat 2：自然语言任务 → 思考流 + 分析卡流式
        rec.type(TASK_TEXT, delay=0.045)
        rec.press("\r")

        # beat 3：审批面板——停顿让观看者读清命令，再 Enter 执行
        rec.wait_for(APPROVAL_MARK, timeout=30)
        rec._pump(2.4)
        rec.press("\r")

        # beat 4：真命令输出落地 + 总结卡
        rec.wait_for(FINAL_MARK, timeout=30)
        rec._pump(4.0)

        # 收尾：/exit 退出（前端斜杠命令，关会话）
        rec.type("/exit", delay=0.03)
        rec.press("\r")
        rec._pump(2.0)
    except EOFError:
        pass                                         # /exit 后正常收场
    except BaseException as e:
        print(f"record 失败：{type(e).__name__}: {e}", file=sys.stderr)
        exit_code = 1
    finally:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
        os.close(fd)

    header = {"version": 2, "width": COLS, "height": ROWS,
              "timestamp": int(time.time()),
              "env": {"SHELL": "zsh", "TERM": "xterm-256color"}}
    with open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(header) + "\n")
        for ev in rec.events:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    dur = rec.events[-1][0] if rec.events else 0
    print(f"{out}  {len(rec.events)} events, {dur:.1f}s")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
