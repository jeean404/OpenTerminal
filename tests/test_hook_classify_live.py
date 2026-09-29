"""hook 分类真 shell 回归（bash/zsh）：真 PTY 里注入集成脚本，逐行提交，
按 OSC 6337 行报告的 KIND 断言分类。

守护「真命令 vs 自然语言」误判族（真机复现过）：多变量环境前缀、$VAR/$(…)/
重定向/花括号/反斜杠开头的真命令被误送 AI；read/wait/clear/kill + 英文虚词
的自然语言被就地执行（阻塞 stdin / 静默成功）。CMD 用例行会被真执行，故在
tmp 目录里跑、命令全部无副作用。

读侧必须用独立线程持续排空 PTY 输出：分片注入每片回显 ~700B，不排空会顶满
pty 输出缓冲 → shell 的 echo 阻塞 → readline 停摆 → 写侧死锁（真 worker 由
StreamRouter 常排空，本 harness 自行模拟）。
"""
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

import pytest

# 模块级跳过须在 import pty 之前：Windows 没有 pty/fcntl，
# 顶层导入会直接 ImportError，pytestmark 的 skipif 来不及生效
if sys.platform == "win32":
    pytest.skip("hook 分类真 shell 测试依赖 pty，仅 POSIX", allow_module_level=True)

import pty  # noqa: E402

from openterminal.shell_integration import build_script, injection_lines

REPORT_RE = re.compile(rb"\x1b\]6337;\d+;(CMD|AI|EXEC);([^\x07]*)\x07")

# (提交行, 期望 KIND)——CMD 行在 tmp cwd 内真执行，须无副作用
CASES = [
    ("echo hi", "CMD"),                              # 基线
    ("./ot_probe_exec.sh", "CMD"),                   # 可执行路径（相对 ./）
    ("/tmp/ot_no_such_probe.shx", "AI"),             # 不存在路径：hook 报 AI 交模型，不再由 worker 静默吞
    ("PYTHONPATH=. LOG_LEVEL=debug echo hi", "CMD"),  # 连续多变量环境前缀
    ("$OT_PROBE_BIN hi", "CMD"),                     # $VAR 展开后是可解析命令
    ("$(echo echo) hi", "CMD"),                      # 命令替换开头
    # 重定向开头：带命令形态（裸 ">f" 在原生 zsh 会 stall 会话——zsh 原生
    # 边界行为，与分类无关；裸形态由 headless bash 用例覆盖）
    (">ot_live_redir.tmp echo redirected", "CMD"),
    ("{ echo grouped; }", "CMD"),                    # 花括号组
    ("# ot live note", "CMD"),                       # 注释行：shell 按注释 eval
    ("\\echo escaped", "CMD"),                       # 反斜杠绕过 alias
    ("read -r line_in </dev/null", "CMD"),           # 真 read 命令不受虚词门影响
    ("kill -9 4000001", "CMD"),                      # 真 kill（不存在的 pid，仅报错无副作用）
    ("read the log and summarize", "AI"),            # 高危 NL：read 会阻塞 stdin
    ("clear up the mess in src", "AI"),              # 高危 NL：clear 静默成功无救援
    ("kill the stuck python process", "AI"),
    ("help me understand this repo", "AI"),
    ("grep 错误 app.log", "CMD"),                    # 含 CJK 参数的命令仍走终端
]


class _Pty:
    """读线程常排空的 PTY 会话。"""

    def __init__(self, shell: str, cwd: str, env: dict):
        args = ([shell, "--norc", "--noprofile", "-i"] if shell.endswith("bash")
                else [shell, "-f", "-i"])
        self.pid, self.fd = pty.fork()
        if self.pid == 0:                          # pragma: no cover - 子进程
            os.chdir(cwd)
            os.execvpe(shell, args, env)
        self.buf = bytearray()
        self.lock = threading.Lock()
        self._stop = False
        self._t = threading.Thread(target=self._pump, daemon=True)
        self._t.start()

    def _pump(self):
        while not self._stop:
            import select
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if not r:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            with self.lock:
                self.buf += chunk

    def write(self, data: bytes) -> None:
        os.write(self.fd, data)

    def wait_for(self, pred, timeout=6.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if pred(bytes(self.buf)):
                    return True
            time.sleep(0.05)
        return False

    def snapshot(self) -> bytes:
        with self.lock:
            return bytes(self.buf)

    def mark(self) -> int:
        with self.lock:
            return len(self.buf)

    def since(self, pos: int) -> bytes:
        with self.lock:
            return bytes(self.buf[pos:])

    def wait_quiet(self, gap=0.3, timeout=6.0) -> None:
        """输出静默 gate：shell 收尾（stty 还原/重绘）落定后再发行，否则
        按键会与收尾竞态——CR 先于字符被 readline 消费（真机同原理靠
        _drain_quiet 规避）。"""
        deadline = time.monotonic() + timeout
        last = -1
        quiet_since = None
        while time.monotonic() < deadline:
            with self.lock:
                n = len(self.buf)
            now = time.monotonic()
            if n == last:
                if quiet_since is None:
                    quiet_since = now
                elif now - quiet_since >= gap:
                    return
            else:
                quiet_since = None
                last = n
            time.sleep(0.05)

    def close(self):
        self._stop = True
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


@pytest.mark.parametrize("shell", ["bash", "zsh"])
def test_hook_classify_live(shell, tmp_path):
    if shutil.which(shell) is None:
        pytest.skip(f"{shell} not installed")
    if shell == "bash":
        import subprocess
        ver = subprocess.run([shell, "-c", 'echo "${BASH_VERSINFO[0]}"'],
                             capture_output=True, text=True).stdout.strip()
        if ver.isdigit() and int(ver) < 4:
            # bash 3.x（macOS 自带）readline 的 bind -x 回车回调拿不到
            # READLINE_LINE（最小复现：回调内恒空、字符在回调后才入行）——
            # hook _enter_ 路径在该版本本就不工作（HEAD 同样），非分类逻辑问题
            pytest.skip("bash <4: bind -x enter callback lacks READLINE_LINE")
    exe = tmp_path / "ot_probe_exec.sh"
    exe.write_text("#!/bin/sh\necho exec-ok\n")
    exe.chmod(0o755)
    env = dict(os.environ, OT_PROBE_BIN="echo", TERM="xterm-256color")
    env.pop("PS1", None)
    p = _Pty(shell, str(tmp_path), env)
    try:
        for chunk in injection_lines(shell, 1):
            p.write(chunk)
            time.sleep(0.12)
        # 首个提示符标记 = hook 在位
        assert p.wait_for(lambda b: b"]133;B" in b), f"{shell}: hook 注入后无提示符标记"
        for line, want in CASES:
            p.wait_quiet()
            pos = p.mark()
            p.write(line.encode() + b"\r")
            target = line.encode()

            def seen(b, target=target, want=want):
                return any(rep == target and kind.decode() == want
                           for kind, rep in REPORT_RE.findall(b))

            assert p.wait_for(seen, timeout=5.0), \
                f"{shell}: {line!r} 未等到 {want} 报告；尾部={p.since(pos)[-200:]!r}"
            kinds = [k.decode() for k, rep in REPORT_RE.findall(p.since(pos))
                     if rep == target]
            assert kinds[0] == want, f"{shell}: {line!r} -> {kinds[0]} != {want}"
            time.sleep(0.08)
    finally:
        p.close()


_DRIVER = r"""
source "$1" >/dev/null 2>&1
READLINE_LINE="$2"; READLINE_POINT=0
__ot_submit 2>/dev/null
"""


def test_hook_classify_headless_bash(tmp_path):
    """bash 分类分支无 readline 直调回归：手动设 READLINE_LINE 调 __ot_submit，
    从 stdout 抓 6337 报告判 KIND。

    live PTY 覆盖不到 macOS 自带 bash 3.2（bind -x 回车回调拿不到
    READLINE_LINE，见 live 用例 skip 理由），而分类逻辑与 readline 版本无关，
    故 headless 直调把 bash 分支也钉住（zsh 分支由 live 用例覆盖）。"""
    if shutil.which("bash") is None:
        pytest.skip("bash not installed")
    script = tmp_path / "hook.sh"
    script.write_text(build_script("bash", 1))
    exe = tmp_path / "ot_probe_exec.sh"
    exe.write_text("#!/bin/sh\necho exec-ok\n")
    exe.chmod(0o755)
    driver = tmp_path / "driver.sh"
    driver.write_text(_DRIVER)
    cases = CASES + [(">ot_pure_redir.tmp", "CMD")]   # 裸重定向：bash 正常执行
    for line, want in cases:
        r = subprocess.run(
            ["bash", str(driver), str(script), line],
            capture_output=True, text=True, timeout=15,
            cwd=str(tmp_path),
            env=dict(os.environ, OT_PROBE_BIN="echo", TERM="dumb"),
        )
        kinds = [k.decode() for k, rep in REPORT_RE.findall(r.stdout.encode())
                 if rep.decode() == line]
        assert kinds, f"{line!r} 无行报告；stdout={r.stdout[-200:]!r}"
        assert kinds[0] == want, f"{line!r} -> {kinds[0]} != {want}"
