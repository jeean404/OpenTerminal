"""远端 Linux 持久 shell：asyncssh + PTY 通道，断线重连一次。"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from .shell_session import BasePtySession

if TYPE_CHECKING:
    from .connections import JumpHost


def known_hosts_path() -> Path:
    """asyncssh 默认校验的 known_hosts 文件。"""
    return Path.home() / ".ssh" / "known_hosts"


def known_hosts_has_entry(path: Path, host: str, port: int | None = None) -> bool:
    """known_hosts 中是否已有该主机（[host]:port 形式也认）。

    不支持解析哈希后的主机名（|1|...），那种条目返回 False。
    """
    if not path.exists():
        return False
    wanted = {host}
    if port and port != 22:
        wanted.add(f"[{host}]:{port}")
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("@"):
            continue
        names = line.split()[0].split(",")
        if wanted & set(names):
            return True
    return False


def format_known_host_line(host: str, port: int | None, key) -> str:
    """按 OpenSSH known_hosts 格式拼一行（非标准端口用 [host]:port）。"""
    name = f"[{host}]:{port}" if port and port != 22 else host
    algorithm = key.algorithm.decode() if isinstance(key.algorithm, bytes) else key.algorithm
    blob = binascii.b2a_base64(key.public_data).decode().strip()
    return f"{name} {algorithm} {blob}\n"


def _default_host_key_prompt(message: str) -> bool:
    return input(message).strip().lower() in {"y", "yes"}


class SshPtySession(BasePtySession):
    def __init__(
        self,
        host: str,
        *,
        username: str | None = None,
        port: int | None = None,
        config_files: tuple[str, ...] = ("~/.ssh/config",),
        rows: int = 40,
        cols: int = 120,
        host_key_prompt: Callable[[str], bool] | None = None,
        password: str | None = None,
        password_prompt: Callable[[str], str | None] | None = None,
        jump: JumpHost | None = None,
        jump_password: str | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self.host = host
        self.username = username
        self.port = port
        # password：系统凭据库里的记住密码，先于交互提示尝试；
        # last_password：本次连接实际使用的密码（连接成功后供 CLI 存回凭据库）
        self.password = password
        self.last_password = password
        self.jump = jump
        self.jump_password = jump_password
        self.last_jump_password = jump_password
        self._jump_conn = None
        self._ask_password = password_prompt or self._default_password_prompt
        self.config_files = [str(Path(p).expanduser()) for p in config_files]
        self.rows, self.cols = rows, cols
        self._ask_host_key = host_key_prompt or _default_host_key_prompt
        self._conn = None
        self._proc = None

    @staticmethod
    def _default_password_prompt(label: str) -> str:
        import getpass

        return getpass.getpass(label)

    async def _maybe_await(self, fn, *args):
        if asyncio.iscoroutinefunction(fn):
            return await fn(*args)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, fn, *args)

    async def _connect_one(self, *, host, username, port, password,
                           tunnel=None, record_last=None):
        import getpass

        import asyncssh

        kwargs: dict = {"keepalive_interval": 30}
        if self._config_paths:
            kwargs["config"] = self._config_paths
        if username:
            kwargs["username"] = username
        if port:
            kwargs["port"] = port
        if password:
            kwargs["password"] = password
        # 加密私钥口令：保持 getpass（Web 端为已知限制：走服务进程控制台）
        kwargs["passphrase"] = lambda: getpass.getpass(f"密钥口令 ({host}): ")
        if tunnel is not None:
            kwargs["tunnel"] = tunnel

        async def _open(tofu_allowed: bool, tried_password: bool):
            try:
                return await asyncssh.connect(host, **kwargs)
            except asyncssh.PermissionDenied:
                if tried_password:
                    raise
                label = f"{(username + '@') if username else ''}{host} 密码: "
                pw = await self._maybe_await(self._ask_password, label)
                kwargs["password"] = pw
                if record_last is not None:
                    record_last(pw)
                return await _open(tofu_allowed=True, tried_password=True)
            except asyncssh.HostKeyNotVerifiable:
                if not tofu_allowed:
                    raise
                return await self._trust_unknown_host(host, port, kwargs, _open)

        return await _open(tofu_allowed=True, tried_password=False)

    def _set_target_password(self, pw: str) -> None:
        self.last_password = pw

    def _set_jump_password(self, pw: str) -> None:
        self.last_jump_password = pw

    async def start(self) -> None:
        self._config_paths = [p for p in self.config_files if Path(p).exists()]
        # 重连用 last_*_password：构造时的 password 是旧值/None，现场重输的
        # 密码只落在 last_password；否则断线重连会重新要密码（见 _recover_connection）
        if self.jump is not None:
            self._jump_conn = await self._connect_one(
                host=self.jump.host, username=self.jump.user, port=self.jump.port,
                password=self.last_jump_password,
                record_last=self._set_jump_password,
            )
            tunnel = self._jump_conn
        else:
            self._jump_conn = None
            tunnel = None
        self._conn = None
        try:
            self._conn = await self._connect_one(
                host=self.host, username=self.username, port=self.port,
                password=self.last_password, tunnel=tunnel,
                record_last=self._set_target_password,
            )
        except Exception:
            # 目标连不上：不能带着一条活着的跳板机连接泄漏（Web 长跑会累积）
            if self._jump_conn is not None:
                self._jump_conn.close()
                self._jump_conn = None
            raise
        self._proc = await self._conn.create_process(
            term_type="xterm-256color",
            # asyncssh term_size 语义是 (width, height)：传 (rows, cols) 会
            # 把远端 tty 变成 120 行×40 列（stty size 打出 "120 40"），
            # vim/less 等全屏程序按远端尺寸绘制后又被前端 xterm 折行
            term_size=(self.cols, self.rows),
            encoding=None,  # 字节流：stdin/stdout 与 PTY 透传数据均按 bytes 处理
        )
        # pwd 探测走 _run_locked（不加锁）：start() 会在 _recover_connection
        # 内被调用，彼时 _run_lock 已被外层 run() 持有——asyncio.Lock 不可
        # 重入，再走 run() 会与自身死锁。start() 串行调用，无并发竞争。
        probe = await self._run_locked("pwd")
        self.cwd = probe.cwd or ""

    async def _trust_unknown_host(self, host, port, kwargs, open_conn) -> object:
        """TOFU：未知主机 → 取指纹询问用户 → 接受则写入 known_hosts 并复用连接。

        已有条目却校验失败（主机密钥变更）时硬失败，绝不静默覆盖。
        """
        import asyncssh

        kh = known_hosts_path()
        if known_hosts_has_entry(kh, host, port):
            raise asyncssh.HostKeyNotVerifiable(
                f"主机 {host} 密钥与 {kh} 中记录不符（可能是重装系统或中间人），"
                "请人工核实后手动更新 known_hosts"
            )
        # 临时不校验以取得服务器公钥（同时可能完成密码认证，连接直接复用）。
        # _open 闭包按引用读取 kwargs，因此原地改写即可。
        saved = dict(kwargs)
        kwargs.update(known_hosts=None)
        conn = await open_conn(tofu_allowed=False, tried_password=False)
        key = conn.get_server_host_key()
        algorithm = (
            key.algorithm.decode() if isinstance(key.algorithm, bytes) else key.algorithm
        )
        fp = base64.b64encode(hashlib.sha256(key.public_data).digest()).decode().strip("=")
        message = (
            f"主机 {host} 的密钥未知（{algorithm} SHA256:{fp}）。\n"
            "信任并写入 known_hosts？[y/N]: "
        )
        accepted = await self._maybe_await(self._ask_host_key, message)
        if not accepted:
            conn.close()
            raise asyncssh.HostKeyNotVerifiable("用户拒绝信任未知主机密钥")
        kh.parent.mkdir(parents=True, exist_ok=True)
        with kh.open("a", encoding="utf-8") as f:
            f.write(format_known_host_line(host, port, key))
        # 后续本进程内重连沿用已建立的连接；下次 start() 会重新走默认校验。
        kwargs.clear()
        kwargs.update(saved)
        return conn

    async def _write_raw(self, data: bytes) -> None:
        if self._proc is None:
            raise ConnectionError("SSH 进程未启动")
        self._proc.stdin.write(data)
        await self._proc.stdin.drain()

    async def _read_some(self, idle_timeout: float) -> bytes:
        if self._proc is None:
            raise ConnectionError("SSH 进程未启动")
        data = await asyncio.wait_for(self._proc.stdout.read(65_536), idle_timeout)
        if not data:
            raise EOFError("SSH 通道 EOF")
        return data

    async def _interrupt(self) -> None:
        if self._proc is not None:
            self._proc.stdin.write(b"\x03")
            await self._proc.stdin.drain()

    async def _recover_connection(self) -> bool:
        await self.close()
        for _ in range(1):  # 只自动重连一次
            try:
                await self.start()
                await self._notify_reconnect()
                return True
            except Exception:
                return False
        return False

    async def resize(self, rows: int, cols: int) -> None:
        self.rows, self.cols = rows, cols
        if self._proc is not None:
            # asyncssh change_terminal_size 是同步方法（发 window-change 请求）
            self._proc.change_terminal_size(cols, rows)

    async def send_raw(self, data: bytes) -> None:
        await self._write_raw(data)

    async def close(self) -> None:
        if self._proc is not None:
            try:
                self._proc.close()
            except Exception:
                pass
        for conn in (self._conn, self._jump_conn):
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
        self._proc = self._conn = self._jump_conn = None
