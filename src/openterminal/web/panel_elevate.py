"""以另一个用户的身份开 SFTP：``sudo -u <用户> sftp-server`` 走 exec 通道。

SFTP 子系统**只能以 SSH 认证用户的身份操作文件**——协议里根本没有「切到 root」
这回事，所以「手里只有 xiaojian 的密码、要看的却是 root 的目录」在纯 SFTP 上无解。
出路是用 sudo 把 **sftp-server 本身** 拉起来：协议照样是 SFTP，只是服务进程换了
身份。于是 files_api 那 9 个文件操作一行都不用改，也不必到 shell 里重写读写/
改名/递归删——那种实现要处理引号、二进制与半截写入，比这里脆得多。

asyncssh 的 ``sftp.start_sftp_client`` 吃的是**任意** reader/writer（它内部就是拿
``open_session(subsystem='sftp')`` 的流去建 handler），把 exec 通道的 stdin/stdout
喂给它即可。它不在 ``asyncssh`` 顶层导出，只能从 ``asyncssh.sftp`` 取；那是库自己
在用的路径，行为与直连 SFTP 完全一致。取 ``conn._utf8_decode_errors`` 只影响路径名
解码，拿不到就按 strict。
"""

from __future__ import annotations

import asyncio
from contextlib import suppress

from asyncssh import sftp as _asftp

# 发行版把 sftp-server 放在不同前缀下；先问 PATH，再按这份清单找。
_SFTP_PATHS = (
    "/usr/lib/openssh/sftp-server",
    "/usr/libexec/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
    "/usr/local/libexec/openssh/sftp-server",
)
_PROBE_TIMEOUT = 20.0
_HANDSHAKE_TIMEOUT = 20.0


class ElevateError(Exception):
    """提权开 SFTP 失败。``code`` 供路由挑 HTTP 状态，文案可直接给用户看。"""

    def __init__(self, detail: str, code: str = "elevate_failed") -> None:
        super().__init__(detail)
        self.code = code


async def _run(conn, cmd: list[str], *, input_text: str | None = None):
    """跑一条命令，返回 (exit_status, stdout, stderr)，超时当提权失败。"""

    async def _go():
        return await conn.run(cmd, check=False, input=input_text, encoding="utf-8")

    try:
        result = await asyncio.wait_for(_go(), _PROBE_TIMEOUT)
    except asyncio.TimeoutError:
        raise ElevateError(
            f"执行 `{cmd[0]}` 超时（{_PROBE_TIMEOUT:.0f}s）", "elevate_timeout"
        ) from None
    status = result.exit_status
    return (status if status is not None else 1,
            (result.stdout or "").strip(),
            (result.stderr or "").strip())


async def find_sftp_server(conn) -> str:
    """定位 sftp-server 的绝对路径（sudo 下 PATH 常常不全，得逐个试）。"""
    candidates = " ".join(_SFTP_PATHS)
    script = (
        'p=$(command -v sftp-server 2>/dev/null) && [ -x "$p" ] && { echo "$p"; exit 0; }; '
        f'for p in {candidates}; do [ -x "$p" ] && {{ echo "$p"; exit 0; }}; done; '
        "exit 1"
    )
    status, out, err = await _run(conn, ["sh", "-c", script])
    if status != 0 or not out:
        raise ElevateError(
            "服务器上找不到 sftp-server，无法以其他用户身份浏览文件"
            + (f"（{err}）" if err else ""),
            "no_sftp_server",
        )
    return out.splitlines()[-1].strip()


async def _sudo_allows(conn, user: str) -> tuple[bool, str]:
    """免密 sudo 行不行得通 → (可免密, stderr)。"""
    status, _out, err = await _run(conn, ["sudo", "-n", "-u", user, "true"])
    return status == 0, err


def _needs_password(err: str) -> bool:
    text = err.lower()
    return ("password is required" in text
            or "password required" in text)


async def open_elevated_sftp(conn, user: str, password: str | None):
    """以 ``user`` 的身份拿一个 SFTP 客户端（协议不变，进程身份换了）。"""
    status, out, _err = await _run(conn, ["id", "-un"])
    login_user = out if status == 0 else ""
    if login_user and login_user == user:
        # 已经是目标身份，不必惊动 sudo
        return await conn.start_sftp_client()

    passwordless, sudo_err = await _sudo_allows(conn, user)
    if not passwordless and not _needs_password(sudo_err):
        raise ElevateError(
            f"无法以 {user} 身份执行命令：{sudo_err or 'sudo 被拒绝'}",
            "sudo_denied",
        )
    # 密码缺口要早报：别先去摸 sftp-server，白跑一趟还拖慢弹框
    if not passwordless and not password:
        raise ElevateError(
            f"sudo 需要 {login_user or '当前用户'} 的密码才能切换到 {user}",
            "sudo_password",
        )

    path = await find_sftp_server(conn)
    if passwordless:
        cmd = ["sudo", "-n", "-u", user, path]
        first_input = None
    else:
        cmd = ["sudo", "-S", "-p", "", "-u", user, path]
        # sudo 从 stdin 吃一行密码，剩下的交给 sftp-server 当协议——这行必须
        # 赶在 SFTP 握手之前写进去，否则会被当成协议首包
        first_input = (password + "\n").encode("utf-8")

    proc = await conn.create_process(cmd, encoding=None)
    if first_input is not None:
        proc.stdin.write(first_input)
        await proc.stdin.drain()

    async def _handshake():
        return await _asftp.start_sftp_client(
            conn,
            asyncio.get_running_loop(),
            getattr(conn, "_utf8_decode_errors", "strict"),
            proc.stdout,
            proc.stdin,
            "utf-8",
            "strict",
            _asftp.MIN_SFTP_VERSION,
        )

    try:
        return await asyncio.wait_for(_handshake(), _HANDSHAKE_TIMEOUT)
    except asyncio.TimeoutError:
        with suppress(Exception):
            proc.kill()
        raise ElevateError(
            f"以 {user} 身份启动 sftp-server 无响应"
            "（sudo 可能被 requiretty 之类拦住）",
            "elevate_timeout",
        ) from None
    except ElevateError:
        raise
    except Exception as exc:                     # noqa: BLE001
        with suppress(Exception):
            proc.kill()
        raise ElevateError(
            f"以 {user} 身份浏览文件失败：{exc}", "elevate_failed"
        ) from None
