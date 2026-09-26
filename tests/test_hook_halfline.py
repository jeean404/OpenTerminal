"""半行保存/恢复原语（hook 重绑 ^U/^Y）PTY 端到端验证。

真机根因：任务期 agent 命令注入的 \x15 原生 unix-line-discard 会把用户正在
敲的半行杀进 kill ring 且不恢复——打字内容被后续注入无声吞掉，只剩尾巴。
修复后 \x15 走 __ot_kill_line（存 __ot_saved）、\x19 走 __ot_yank_line
（存档非空才接回，空行零副作用）。这里在真 zsh（pty）里跑注入脚本验证
三个场景：杀行后接回、空行安全、命令执行期打字与注入交错。

需要 pty + zsh ≥5.x（READLINE/BUFFER 原语同款）；bash 5 有则一并跑。
"""

import os
import re
import select
import signal
import struct
import termios

import pytest

from openterminal.shell_integration import build_script


def _drain(fd, seconds):
    out = b""
    import time
    deadline = time.time() + seconds
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    return out


class ShellPty:
    def __init__(self, argv):
        import pty
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ["TERM"] = "xterm-256color"
            os.execvp(argv[0], argv)
        import fcntl
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.buf = _drain(self.fd, 1.0)

    def send(self, data: bytes, settle: float = 0.25):
        os.write(self.fd, data)
        self.buf += _drain(self.fd, settle)

    def visible(self) -> str:
        txt = self.buf.decode("utf-8", "replace")
        txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", txt)
        txt = re.sub(r"\x1b\][^\x07]*\x07", "", txt)
        txt = re.sub(r"\x1b[=>]", "", txt)
        return txt

    def close(self):
        try:
            os.write(self.fd, b"exit\r")
            _drain(self.fd, 0.2)
            os.close(self.fd)
        except OSError:
            pass
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


@pytest.fixture
def hooked_zsh(tmp_path):
    script = tmp_path / "ot_hook.zsh"
    script.write_text(build_script("zsh", 1), encoding="utf-8")
    sh = ShellPty(["/bin/zsh", "-f"])
    sh.send(f"source {script}\r".encode(), settle=0.6)
    yield sh
    sh.close()


def test_hook_halfline_kill_then_yank_restores(hooked_zsh):
    """杀行后 \x19 接回：「echo R1」被注入 \x15 收走 → echo MARK 执行 →
    \x19 接回 → 提交后 R1 真正执行（不是只剩尾巴丢掉前半行）。"""
    sh = hooked_zsh
    sh.send(b"echo R1", 0.3)
    sh.send(b"\x15", 0.3)          # 注入收纳：echo R1 进 __ot_saved，行清空
    sh.send(b"echo MARK\r", 0.5)   # 注入命令执行
    sh.send(b"\x19", 0.3)          # 注入收尾：接回 echo R1
    sh.send(b"\r", 0.6)            # 用户提交接回的行
    txt = sh.visible()
    assert "MARK" in txt
    assert re.search(r"[\r\n]R1[\r\n]", txt), "接回的命令应真正执行并输出 R1"


def test_hook_halfline_empty_line_no_killring_revival(hooked_zsh):
    """空行安全：行空时 \x15\x19 对不得把 kill ring 旧内容复活
    （原生对的实测事故：helloecho MARK）。先用原生 C-w 播几个 kill ring
    条目并清到空行，再在空行走一对 \x15\x19，后续命令不得掺旧内容。"""
    sh = hooked_zsh
    sh.send(b"hellow", 0.3)
    sh.send(b"\x17", 0.3)          # 原生 C-w：杀 "w" 进 kill ring
    sh.send(b"\x17", 0.3)          # 再杀 "hello"：行清空、kill ring 有货
    sh.send(b"\x15", 0.2)          # 空行存档（__ot_saved 为空）
    sh.send(b"echo M2\r", 0.4)
    sh.send(b"\x19", 0.2)          # 空档：不得 yank 出任何旧内容
    sh.send(b"echo OK3\r", 0.5)
    txt = sh.visible()
    assert "M2" in txt and "OK3" in txt
    assert "hellowecho" not in txt and "helloecho" not in txt
    assert "hellowM2" not in txt and "helloM2" not in txt


def test_hook_halfline_typing_during_command_survives(hooked_zsh):
    """任务期打字与注入交错（M1 主场景）：注入命令执行期间用户打字，
    收尾 \x19 把「注入前半行 + 执行期打字」原样接回。"""
    sh = hooked_zsh
    sh.send(b"echo foo", 0.3)
    sh.send(b"\x15", 0.2)              # 注入开始：echo foo 进存档
    sh.send(b"sleep 0.6\r", 0.1)       # 注入命令执行（慢）
    sh.send(b"XYZ", 0.4)               # 执行期用户打字（落 tty 队列）
    sh.send(b"\x19", 0.3)              # 注入收尾：接回
    sh.send(b"\r", 0.6)                # 用户提交拼好的行
    txt = sh.visible()
    assert re.search(r"[\r\n]fooXYZ[\r\n]", txt), \
        "注入前半行 + 执行期打字应拼接为 echo fooXYZ 的输出"


def test_hook_halfline_zsh_binding_present():
    """注入脚本必须重绑 ^U/^Y 为存档/接回原语（bash 侧同理）。"""
    z = build_script("zsh", 1)
    assert "bindkey '^U' __ot_kill_line" in z
    assert "bindkey '^Y' __ot_yank_line" in z
    b = build_script("bash", 1)
    assert '"\\C-u": __ot_kill_line' in b
    assert '"\\C-y": __ot_yank_line' in b
