import asyncio

from openterminal.shell_session import BasePtySession
from openterminal.shell_session import (
    BEGIN_MARKER, END_MARKER, CommandResult, slice_capture, truncate_output,
    wrap_command,
    wrap_passthrough,
)


def test_wrap_single_line_and_sentinels():
    w = wrap_command("ls -la")
    assert w.endswith("\n")
    assert BEGIN_MARKER in w and END_MARKER in w
    assert '"$?"' in w and '"$PWD"' in w
    assert "\n" not in w[:-1]  # 整体一行，防止命令偷吃掉后续输入


def test_wrap_newlines_joined():
    assert "\n" not in wrap_command("a\nb")[:-1]


def test_wrap_passthrough_sentinel():
    # 直通包装：无 BEGIN 标记，printf 随机哨兵带退出码，单行 + \r 提交
    w = wrap_passthrough("sudo su -", "__OTRAWdeadbeef")
    assert w.startswith("sudo su - ; printf '__OTRAWdeadbeef_%s__\\n' \"$?\"")
    assert w.endswith("\r")
    assert "__OT_BEGIN__" not in w
    assert "\n" not in w[:-1]


def test_slice_happy_path():
    raw = (
        b"\r\nuser@host:~$ printf '__OT_BEGIN__\\n'; echo hello; "
        b"printf '__OT_END__%s__%s__\\n' \"$?\" \"$PWD\"\r\n"
        b"__OT_BEGIN__\r\n"
        b"hello\r\n"
        b"__OT_END__0__/home/user__\r\n"
        b"user@host:~$ "
    )
    out, code, cwd = slice_capture(raw)
    assert code == 0
    assert cwd == "/home/user"
    assert out == "hello"
    # 复合命令的回显行（含 printf）与 BEGIN 标记行本身都必须被切掉
    assert "__OT_BEGIN__" not in out and "__OT_END__" not in out


def test_slice_real_zsh_tty_geometry():
    # 本机 zsh 抓到的真实字节几何：zle 重绘把回显拆成多段（含字面 \n 两字符），
    # 真正的标记输出是独立的 __OT_BEGIN__\r\n 行。
    raw = (
        b"p\x08printf '__OT_BEGIN__\\n'; echo hello; "
        b"printf '__OT_END__%s__%s__\\n' \"$?\" \r\x1b[K \r \"$PWD\"\x1b[?2004l\r\r\n"
        b"__OT_BEGIN__\r\nhello\r\n"
        b"__OT_END__0__/Users/wujian/OpenTerminal__\r\n"
    )
    out, code, cwd = slice_capture(raw)
    assert out == "hello"
    assert code == 0
    assert cwd == "/Users/wujian/OpenTerminal"


def test_slice_nonzero_exit_and_ansi():
    raw = (
        b"some prior prompt noise "
        b"__OT_BEGIN__\n\x1b[31mboom\x1b[0m\n__OT_END__2__/tmp__\n"
    )
    out, code, cwd = slice_capture(raw)
    assert code == 2 and cwd == "/tmp"
    assert "boom" in out and "\x1b[31m" not in out


def test_slice_incomplete_returns_none():
    assert slice_capture(b"partial output no markers") is None
    assert slice_capture(b"__OT_BEGIN__\nstill running") is None


def test_truncate_head_tail():
    text = "".join(f"line{i}\n" for i in range(100))
    out, truncated = truncate_output(text, 80)
    assert truncated and len(out) <= 200
    assert "截断" in out


def test_command_result_defaults():
    r = CommandResult(output="x", exit_code=0, truncated=False, cwd="/tmp")
    assert r.reconnected is False


class ScriptedSession(BasePtySession):
    """按预设字节流驱动的假会话：跑 BasePtySession.run() 的主循环。"""

    def __init__(self, chunks):
        super().__init__(default_timeout=10, max_output_bytes=102400)
        self._chunks = list(chunks)
        self.interrupted = False

    async def _write_raw(self, data):
        pass

    async def _read_some(self, idle_timeout):
        if self._chunks:
            return self._chunks.pop(0)
        await asyncio.sleep(0.02)
        raise asyncio.TimeoutError()

    async def _interrupt(self):
        self.interrupted = True


async def test_sudo_password_prompt_interrupts_early():
    s = ScriptedSession([b"[sudo] password for user: "])
    r = await s.run("sudo apt update")
    assert s.interrupted
    assert r.exit_code == 130
    assert "检测到密码" in r.output and "Ctrl+R" in r.output


async def test_ssh_password_prompt_interrupts_early():
    s = ScriptedSession([b"user@host's password: "])
    r = await s.run("ssh -o BatchMode=yes user@host uptime")
    assert s.interrupted and r.exit_code == 130


async def test_plain_password_line_no_false_positive():
    # 非 sudo/su/ssh 命令的输出里出现 password 字样不触发
    s = ScriptedSession([
        b"Password: not a prompt, just log output\n",
        b"__OT_BEGIN__\r\nok\r\n__OT_END__0__/tmp__\r\n",
    ])
    r = await s.run("grep Password /var/log/example")
    assert r.exit_code == 0 and "ok" in r.output and not s.interrupted


async def test_password_text_then_more_output_does_not_interrupt():
    # sudo 前缀命令，但 password 字样是程序输出且后还有输出（非末位）→ 不触发
    s = ScriptedSession([
        b"password: x\n",
        b"__OT_BEGIN__\r\nok\r\n__OT_END__0__/tmp__\r\n",
    ])
    r = await s.run("sudo cat /etc/app.conf")
    assert r.exit_code == 0 and "ok" in r.output and not s.interrupted
