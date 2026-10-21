"""Web 文件面板：远程目录浏览/读写端点。

分层（本模块只做字节搬运，不碰终端输出通道）：

1. **通道** `_PanelConn`——面板自持的 SSH 连接：**直连**目标主机，
   不经终端会话的连接、不碰 PTY，终端零变化；终端断开面板照常工作。
   连接目标由用户在登录弹框里给（IP/端口/用户名/密码），默认值取自
   终端所在的那台机器（`files_identity`），但连接本身与终端无关。
2. **路径安全** `_clean_name``/``_join``——写入端点的文件名一律剥掉
   路径分隔符与 ``..``，绝不让上传的 ``Content-Disposition`` 文件名
   把落点拖出目标目录（真机取证：``../../tmp/x`` 曾直接落出目录）。
3. **端点**——统一经 ``_channel`` 取通道，失败映射成带 ``code`` 的可读
   JSON；未连接是 503/retry 而不是 500，前端据此自动等就绪后重列。

读写语义上的两个硬约束（都是真机踩过的）：

* 新建文件走 ``"x"``（FXF_EXCL）——``"w"`` 会把同名旧文件截成 0 字节；
* 上传/保存一律「临时文件 + 改名」原子替换：``open(path,'wb')`` 一打开
  就把旧文件截成 0 字节，中途失败时用户原文件已经没了；改成先写
  ``*.otpart`` 再改名上去，失败只清临时文件，原文件原样保留。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import posixpath
import stat as stat_mod
from contextlib import suppress
from typing import Any
from urllib.parse import quote as urlquote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

_CHUNK = 128 * 1024
# 在线编辑的读取/写入上限：编辑器走浏览器内存，超限拒绝并提示用下载
_EDIT_LIMIT = 2 * 1024 * 1024


# --- 错误信封 -------------------------------------------------------------

class PanelError(HTTPException):
    """面板错误：detail 给人看，code 给前端分派，retry 说值不值得自动重试。"""

    def __init__(self, status: int, code: str, detail: str,
                 *, retry: bool = False, **extra: Any) -> None:
        super().__init__(status, detail)
        self.code = code
        self.retry = retry
        self.extra = extra

    def payload(self) -> dict:
        return {"detail": self.detail, "code": self.code,
                "retry": self.retry, **self.extra}


# --- 面板连接：异常与连接建立 --------------------------------------------

class ConnError(Exception):
    """面板连接的可读失败基类（str(exc) 直接作为接口错误文案）。

    **不能叫 PanelError**：HTTP 错误信封已占了那个名字，同名会让后定义
    的类覆盖前一个，路由里的 ``PanelError(status, code, detail, retry=…)``
    全部走错类（TypeError/异常处理器注册错对象）。连接层的异常由
    ``connect_panel`` 抛出、路由映射成 HTTP 状态，与信封分工不同。
    """


class HostKeyChanged(ConnError):
    """known_hosts 已有记录但密钥不符——硬失败，绝不静默覆盖。"""


class AuthFailed(ConnError):
    """目标主机认证失败（密码/密钥均不可用）。"""


class HostKeyUnknown(ConnError):
    """未知主机密钥，等用户确认（TOFU）。携带指纹供前端展示。"""

    def __init__(self, host: str, algorithm: str, fingerprint: str) -> None:
        super().__init__(f"主机 {host} 密钥未知")
        self.host = host
        self.algorithm = algorithm
        self.fingerprint = fingerprint

    @property
    def detail(self) -> str:
        return (f"主机 {self.host} 的密钥未知（{self.algorithm} "
                f"SHA256:{self.fingerprint}），请确认后信任")


async def connect_panel(*, host: str, port: int | None,
                        user: str | None, password: str | None,
                        confirm_host_key: bool = False):
    """直连目标主机并打开 SFTP 客户端，返回 (conn, sftp)。

    **不走隧道、不碰终端**：面板自带一条 SSH 连接，与终端会话无关——
    这是「文件面板和终端完全独立」的落地点。代价是要求 web 服务所在
    机器能网络直达 ``host``（用户环境实测真机直连可达）。

    主机校验语义对齐主连接的 TOFU（ssh.py._trust_unknown_host）：
    known_hosts 已有记录但密钥不符 → HostKeyChanged（硬失败）；未知主机
    → 未确认时抛 HostKeyUnknown（携指纹交前端确认），确认后信任并写入
    known_hosts。不读 ~/.ssh/config：面板是独立通道，避免用户 config
    里的 ProxyCommand/别名把连接悄悄改道。
    """
    import asyncssh
    from ..session.ssh import (
        format_known_host_line, known_hosts_has_entry, known_hosts_path)

    kwargs: dict = {"keepalive_interval": 30}
    if user:
        kwargs["username"] = user
    if port:
        kwargs["port"] = port
    if password:
        kwargs["password"] = password
    try:
        conn = await asyncssh.connect(host, **kwargs)
    except asyncssh.HostKeyNotVerifiable:
        kh = known_hosts_path()
        if known_hosts_has_entry(kh, host, port):
            raise HostKeyChanged(
                f"主机 {host} 密钥与 known_hosts 记录不符"
                "（可能是重装系统或中间人），请人工核实") from None
        # 未知主机：摸一次服务器公钥取指纹（连接可复用）。
        # 探针要**单独**收异常：它跑在 HostKeyNotVerifiable 的 except 块里，
        # PermissionDenied 与之是兄弟类，外层 except 收不住（Python 语义），
        # 会一路漏到路由的 except Exception 变成 502 而不是 403 auth_failed。
        try:
            pconn = await asyncssh.connect(host, **dict(kwargs,
                                                        known_hosts=None))
        except asyncssh.PermissionDenied:
            raise AuthFailed(
                "认证失败：用户名或密码错误（或密钥不可用）") from None
        try:
            key = pconn.get_server_host_key()
            algo = (key.algorithm.decode() if isinstance(key.algorithm, bytes)
                    else str(key.algorithm))
            fp = base64.b64encode(
                hashlib.sha256(key.public_data).digest()).decode().strip("=")
            if not confirm_host_key:
                raise HostKeyUnknown(host, algo, fp)
            kh.parent.mkdir(parents=True, exist_ok=True)
            with kh.open("a", encoding="utf-8") as f:
                f.write(format_known_host_line(host, port, key))
        except BaseException:
            pconn.close()               # 未确认/落盘失败都不泄漏探针连接
            raise
        conn = pconn                    # 确认后的连接直接复用
    except asyncssh.PermissionDenied:
        raise AuthFailed("认证失败：用户名或密码错误（或密钥不可用）") from None
    sftp = await conn.start_sftp_client()
    return conn, sftp


class _PanelConn:
    """面板自持的 SSH 连接：SFTP 客户端懒缓存，连接关闭才重建。

    凭据（含密码）留在实例里供自动重连用——面板不跨进程存活，keyring
    只负责「首次不弹框就连上」，掉线重连用内存里的密码。

    ``need_password`` 是认证失败闩锁：密码错了就上闩，后续请求**不再拿
    旧密码去撞 sshd**（反复失败可能触发服务器的锁定策略），直接报
    auth_failed 让前端弹框换密码；用户重新连上才清闩。
    """

    def __init__(self) -> None:
        self.host = ""
        self.port: int | None = None
        self.user: str | None = None
        self.password: str | None = None
        self.conn = None            # asyncssh SSHClientConnection
        self.sftp_client = None     # asyncssh SFTPClient
        self.lock = asyncio.Lock()
        self.need_password = False  # 认证失败闩锁

    @property
    def alive(self) -> bool:
        return (self.conn is not None and self.sftp_client is not None
                and not self.conn.is_closed())

    def teardown(self) -> None:
        if self.sftp_client is not None:
            with suppress(Exception):
                self.sftp_client.exit()
            self.sftp_client = None
        if self.conn is not None:
            with suppress(Exception):
                self.conn.close()
            self.conn = None

    def forget_password(self) -> None:
        """凭据不可信时丢掉明文（认证失败/主动断开）。"""
        self.password = None

    async def sftp(self):
        """可用的 SFTP 客户端：连接关闭时用已存凭据重建。

        重建走默认 known_hosts 校验（首次连接确认后已落盘），不自动信任
        新指纹——重建是同一台主机，密钥变了就该报错而不是悄悄接受。

        失败分两类：``AuthFailed`` 上闩（不可重试，等换密码）；网络类
        异常原样抛出，由 ``_channel`` 映射成 503/retry 供前端自动退避。
        """
        if self.alive:
            return self.sftp_client
        async with self.lock:
            if self.alive:
                return self.sftp_client
            if self.need_password:
                raise AuthFailed("认证失败：请重新输入密码")
            self.teardown()
            try:
                self.conn, self.sftp_client = await connect_panel(
                    host=self.host, port=self.port, user=self.user,
                    password=self.password)
            except AuthFailed:
                self.forget_password()
                self.need_password = True
                raise
            return self.sftp_client



async def close_panel(worker) -> None:
    """释放面板连接（幂等：可从任意退出路径安全调用）。

    挂在 ``TabWorker`` 的 ``_disposables`` 钩子上，``close()`` 统一触发——
    旧实现只在 ``close_tab`` 一处调用，断线回收与 app 关闭两条路径都漏了，
    SSH 连接一直挂着不放。钩子结构让漏接在类型上不可能。
    """
    c = getattr(worker, "_panel_files", None)
    if c is None:
        return
    worker._panel_files = None
    async with c.lock:
        c.teardown()
        c.forget_password()


# --- 路径安全 -------------------------------------------------------------

def _clean_name(name: str) -> str:
    """文件名消毒：剥掉一切目录成分，只留最后一段。

    上传的 ``Content-Disposition`` 文件名由客户端说了算：``../../etc/x``
    或 ``/etc/x`` 都必须落成目标目录下的 ``x``（真机取证：未消毒时
    ``../../tmp/PWNED.txt`` 真的落到了 /tmp/PWNED.txt）。
    """
    name = (name or "").replace("\\", "/")
    name = posixpath.basename(name.rstrip("/"))
    return "" if name in ("", ".", "..") else name


def _norm(path: str) -> str:
    """远端路径规范化：塌掉 ``.``/``..``，但保留用户显式给的绝对/相对语义。"""
    p = (path or "").replace("\\", "/").strip()
    if not p:
        return "."
    if p.startswith("~"):               # SFTP 不做 shell 展开，~ 交给服务端原样
        return p
    abs_path = p.startswith("/")
    p = posixpath.normpath(p)
    return ("/" + p.lstrip("/")) if abs_path else p


def _join(dirname: str, name: str) -> str:
    """目录 + 消毒后的文件名 → 远端绝对/相对路径。"""
    name = _clean_name(name)
    if not name:
        raise PanelError(400, "bad_name", "文件名不合法")
    base = _norm(dirname)
    return name if base == "." else posixpath.join(base, name)


def _is_dir(attrs) -> bool:
    if getattr(attrs, "permissions", None) is not None:
        return stat_mod.S_ISDIR(attrs.permissions)
    return getattr(attrs, "type", 0) == 2


# --- 原子写 ----------------------------------------------------------------

def _temp_name(remote: str) -> str:
    import secrets

    return f"{remote}.otpart-{secrets.token_hex(4)}"


async def _replace(sftp, tmp: str, remote: str) -> None:
    """临时文件改名顶替目标（POSIX rename-to-existing）。

    posix-rename 是 OpenSSH 扩展；不支持的服务器退回「删目标再改名」——
    仍比直接 open('wb') 安全：失败时临时文件还在，原文件没被截断。
    """
    try:
        await sftp.posix_rename(tmp, remote)
        return
    except Exception:                       # noqa: BLE001 - 扩展不可用再退
        pass
    with suppress(Exception):
        await sftp.remove(remote)
    await sftp.rename(tmp, remote)


# --- 通道 -----------------------------------------------------------------

class _Channel:
    """一次端点调用拿到的可用 SFTP（面板自己的直连，与终端无关）。"""

    def __init__(self, sftp, worker) -> None:
        self.sftp = sftp
        self.worker = worker


def files_identity(worker) -> dict:
    """终端所在的主机 + 以谁的身份连——**只用来给登录弹框预填默认值**。

    面板的连接与终端无关，但「IP 默认是终端连的最终服务器、用户名默认是
    终端当前用户」这条需求要从这里取。取值在 core/pipeline.py 的
    ``files_identity``：host/port 来自最内层未闭合 ssh 帧，user 优先取
    提示符里的用户名（`sudo su -` 后是 root）。fake/旧 worker 没有该属性
    时退回会话自身的连接目标。
    """
    ident = getattr(worker, "files_identity", None)
    if isinstance(ident, dict):
        return ident
    session = getattr(worker, "session", None)
    user = (getattr(worker, "_target_user", "")
            or getattr(session, "username", "") or "")
    return {"host": getattr(worker, "_target_host", "") or "",
            "port": None, "users": [user] if user else [],
            "effective_user": user, "nested": False,
            "mode": getattr(getattr(worker, "_target", None), "mode", "")}


def _cred_port(port: int | None) -> int | None:
    """凭据键的端口归一化：默认端口统一记成 None（键里不写 ``:22``）。

    ``display_name`` 只在 port 为真值时拼 ``:port``，于是同一身份会落在
    ``user@host`` 与 ``user@host:22`` 两个键下，单键直查永远 miss——这正是
    「记住过却仍弹框」的来源。写入归一到 None，读取走 ``load_password_alias``
    互查，两边就对上了。非默认端口必须精确（alias 明确不互查 2222 这类）。
    """
    return None if port in (None, 22) else port


def _has_password(host: str, user: str | None, port: int | None) -> bool:
    """凭据库里有没有该身份的密码（弹框据此提示「已记住，将自动连接」）。"""
    if not host:
        return False
    from ..connections.secrets import load_password_alias

    return bool(load_password_alias(host, user, _cred_port(port)))


def _conn_fields(payload: dict) -> tuple[str, str | None, int | None]:
    """四栏入参 → (host, user, port)；兼容旧前端的 target 字符串。

    端口只认纯数字（坏值退回 None＝默认 22），与 server._conn_fields 同
    语义，避免 "host:ssh" 这类被误切成端口。
    """
    from ..connections.models import parse_user_at_host

    host = (payload.get("host") or "").strip()
    user = (payload.get("user") or "").strip() or None
    raw = str(payload.get("port") or "").strip()
    port = int(raw) if raw.isdigit() else None
    if host:
        return host, user, port
    h, u, p = parse_user_at_host((payload.get("target") or "").strip())
    return h, u or user, (p if p is not None else port)


def _register_disposal(worker) -> None:
    """把释放钩子挂到 ``worker._disposables``（幂等）。

    ``close()`` 统一触发钩子——旧实现靠调用点记得调 ``close_cascade``，
    断线回收与 app 关闭两条路径都漏了，SSH 连接一直挂着不放。
    """
    hooks = getattr(worker, "_disposables", None)
    if hooks is None:
        hooks = []
        worker._disposables = hooks
    if any(getattr(h, "_ot_panel", False) for h in hooks):
        return

    async def _dispose() -> None:
        await close_panel(worker)

    _dispose._ot_panel = True
    hooks.append(_dispose)


async def _realpath(sftp, path: str) -> str:
    """绝对化路径（面包屑用）。个别服务器 realpath 失败就回退原样。"""
    with suppress(Exception):
        p = await sftp.realpath(path)
        return str(p)
    return path


# --- 路由 -----------------------------------------------------------------

def install_files_errors(app) -> None:
    """把 PanelError 渲染成带 code/retry 的 JSON。

    FastAPI 对 HTTPException 只吐 ``{"detail": ...}``，前端分派不出
    「该不该自动重试」。Starlette 按异常类的 MRO 找 handler，故注册到
    PanelError 上即可盖过默认的 HTTPException 处理器。
    """
    from fastapi.responses import JSONResponse as _JR

    @app.exception_handler(PanelError)
    async def _panel_error(_request, exc: PanelError):
        return _JR(status_code=exc.status_code, content=exc.payload())


def make_files_router(tabs: dict, check_token) -> APIRouter:
    router = APIRouter(prefix="/api/tabs/{tab_id}/files")

    def _worker(tab_id: str):
        worker = tabs.get(tab_id)
        if worker is None:
            raise PanelError(404, "no_tab", "会话不存在")
        return worker

    def _conn(worker):
        """面板自己的连接：没有就说明还没登录，前端该弹框。"""
        c = getattr(worker, "_panel_files", None)
        if c is None or not c.host:
            raise PanelError(409, "not_connected",
                             "未连接远程主机，请先登录", need_password=True)
        return c

    async def _channel(tab_id: str) -> _Channel:
        """端点公共入口：拿到面板那条直连的 SFTP。

        错误按 code 分三类，前端据此分派（**永远不回 401**——那是访问
        令牌的专属语义，撞上会莫名弹令牌框）：

        * ``auth_failed``（403）——密码不对，**不自动重试**，弹框换密码；
        * ``not_ready``（503, retry）——网络抖动，自动退避重连；
        * ``host_key_unknown``（428）/``host_key_changed``（400）——TOFU。
        """
        worker = _worker(tab_id)
        c = _conn(worker)
        try:
            sftp = await c.sftp()
        except AuthFailed as exc:
            raise PanelError(403, "auth_failed", str(exc),
                             need_password=True) from None
        except HostKeyUnknown as exc:
            raise PanelError(428, "host_key_unknown", exc.detail,
                             algorithm=exc.algorithm,
                             fingerprint=exc.fingerprint,
                             host=exc.host) from None
        except HostKeyChanged as exc:
            raise PanelError(400, "host_key_changed", str(exc)) from None
        except OSError as exc:
            raise PanelError(503, "not_ready", f"连接不可用: {exc}",
                             retry=True) from None
        except Exception as exc:            # noqa: BLE001 - 其余都算可重试
            raise PanelError(503, "not_ready",
                             f"打开 SFTP 失败: {type(exc).__name__}: {exc}",
                             retry=True) from None
        return _Channel(sftp, worker)

    def _code(exc) -> tuple[int, str]:
        import asyncssh

        if isinstance(exc, asyncssh.SFTPNoSuchFile):
            return 404, "not_found"
        return 400, "io"

    async def _io(what: str, coro):
        """SFTP 调用的统一异常映射（业务代码里不再堆 try/except）。"""
        import asyncssh

        try:
            return await coro
        except PanelError:
            raise
        except asyncssh.SFTPError as exc:
            status, code = _code(exc)
            raise PanelError(status, code, f"{what}: {exc}") from None
        except Exception as exc:            # noqa: BLE001
            raise PanelError(500, "io", f"{what}: {type(exc).__name__}: {exc}") from None

    # --- 状态：连着没有 + 登录弹框的默认值 -------------------------------

    def _defaults(ident: dict, worker) -> dict:
        """登录弹框的默认值：IP/端口＝终端最终服务器，用户＝终端当前用户。

        需求 1 的「默认值」全在这里产出。面板连哪台与它无关——它只回答
        「用户打开面板时表单该预填什么」。
        """
        host = ident.get("host") or ""
        # 本机终端没有「最终服务器」：pipeline 会给字面量 "local"，
        # 别把它当 IP 填进表单
        supported = (bool(host) and host != "local"
                     and ident.get("mode") != "local")
        port = ident.get("port")
        if not ident.get("nested") and port is None:
            port = getattr(getattr(worker, "_target", None), "port", None)
        user = (ident.get("effective_user")
                or (ident.get("users") or [""])[0]) or ""
        return {
            "host": host if supported else "",
            "port": (port if supported else None),
            "user": user if supported else "",
            "users": ident.get("users") or [],
            "nested": bool(ident.get("nested")),
            "supported": supported,
            "has_password": (_has_password(host, user, port)
                             if supported else False),
        }

    @router.get("/state")
    async def state(request: Request, tab_id: str):
        """面板状态：连着没有、连着哪台、登录弹框该填什么。

        **不依赖终端会话**——会话还没连上或已经断了也照常返回，面板自管
        连接（「文件面板和终端完全独立」的落地点）。``defaults`` 只供
        登录弹框预填。

        ``home`` 恒为 "."：SFTP 的默认目录就是登录用户的家目录（需求 3）。
        面板与终端是两套独立机制，不跟终端 cwd。
        """
        check_token(request.headers)
        worker = _worker(tab_id)
        defaults = _defaults(files_identity(worker), worker)
        c = getattr(worker, "_panel_files", None)
        if c is not None and c.alive:
            # supported 是「该不该有 📁 入口」的产品判据，与连没连无关
            return {"connected": True, "supported": defaults["supported"],
                    "reason": None,
                    "home": ".", "host": c.host, "port": c.port,
                    "user": c.user or "", "defaults": defaults}
        return {"connected": False, "supported": defaults["supported"],
                "reason": "not_connected", "home": ".",
                "host": "", "port": None, "user": "", "defaults": defaults}

    # --- 连接管理 --------------------------------------------------------

    @router.post("/connect")
    async def panel_connect(request: Request, tab_id: str, payload: dict):
        """登录远程主机（四栏：IP/端口/用户名/密码），直连不经隧道。

        ``password`` 留空表示「用记住的」——服务端按该身份查凭据库。
        读走 ``load_password_alias``（port=None/22 互查）、写归一到
        ``_cred_port``，两端键才对得上。

        **永远不回 401**：那是访问令牌的专属语义，前端见 401 就弹令牌框
        （真机反馈：用户被莫名要求填访问令牌）。认证失败回 403。
        """
        check_token(request.headers)
        worker = _worker(tab_id)
        host, user, port = _conn_fields(payload)
        if not host:
            raise PanelError(400, "bad_target", "请填写 IP 地址")
        password = payload.get("password") or None
        if not password:
            from ..connections.secrets import load_password_alias

            password = load_password_alias(host, user, _cred_port(port))
        import asyncssh

        c = getattr(worker, "_panel_files", None)
        if c is None:
            c = _PanelConn()            # 检查与赋值间无 await，事件循环内原子
            worker._panel_files = c
        async with c.lock:
            c.teardown()                # 重连语义：先弃旧连接
            c.need_password = False     # 新一轮凭据，解闩
            try:
                conn, sftp = await connect_panel(
                    host=host, port=port, user=user, password=password,
                    confirm_host_key=bool(payload.get("confirm_host_key")))
            except HostKeyUnknown as exc:
                return JSONResponse(
                    status_code=428,
                    content={"detail": exc.detail, "algorithm": exc.algorithm,
                             "fingerprint": exc.fingerprint, "host": exc.host})
            except HostKeyChanged as exc:
                raise PanelError(400, "host_key_changed", str(exc)) from None
            except AuthFailed as exc:
                c.forget_password()
                raise PanelError(403, "auth_failed", str(exc),
                                 need_password=True) from None
            except (OSError, asyncssh.Error) as exc:
                raise PanelError(502, "connect_failed",
                                 f"连接失败: {exc}") from None
            c.host, c.port, c.user, c.password = host, port, user, password
            c.conn, c.sftp_client = conn, sftp
            if payload.get("remember") and password:
                from ..connections.secrets import store_password

                store_password(host, user, _cred_port(port), password)
            _register_disposal(worker)
        return {"ok": True, "host": host, "port": port, "user": user or ""}

    @router.post("/disconnect")
    async def panel_disconnect(request: Request, tab_id: str):
        check_token(request.headers)
        await close_panel(_worker(tab_id))
        return {"ok": True}

    # --- 面板端点（统一走面板自己的直连） --------------------------------

    @router.get("/list")
    async def list_dir(request: Request, tab_id: str, path: str = "."):
        check_token(request.headers)
        ch = await _channel(tab_id)
        target = _norm(path)
        entries = await _io("列目录失败", ch.sftp.readdir(target))
        out = []
        for entry in entries:
            if entry.filename in (".", ".."):
                continue
            attrs = entry.attrs
            out.append({
                "name": entry.filename,
                "is_dir": _is_dir(attrs),
                "size": attrs.size or 0,
                "mtime": attrs.mtime or 0,
            })
        out.sort(key=lambda e: (not e["is_dir"], e["name"]))
        return {"path": await _realpath(ch.sftp, target), "entries": out}

    @router.post("/upload")
    async def upload(request: Request, tab_id: str, path: str = ".",
                     name: str = ""):
        check_token(request.headers)
        ch = await _channel(tab_id)
        remote = _join(path, name)
        tmp = _temp_name(remote)
        written = 0
        try:
            # 先写临时文件再改名：中途失败只清临时文件，用户原文件原样保留
            async with ch.sftp.open(tmp, "wb") as f:
                async for chunk in request.stream():
                    if chunk:
                        await f.write(chunk)
                        written += len(chunk)
            await _replace(ch.sftp, tmp, remote)
        except PanelError:
            with suppress(Exception):
                await ch.sftp.remove(tmp)
            raise
        except asyncio.CancelledError:
            # 客户端取消上传：连接断开时处理器可能被取消，仍要清掉临时文件
            with suppress(Exception):
                await ch.sftp.remove(tmp)
            raise
        except Exception as exc:            # noqa: BLE001
            with suppress(Exception):
                await ch.sftp.remove(tmp)
            import asyncssh

            if isinstance(exc, asyncssh.SFTPError):
                status, code = _code(exc)
                raise PanelError(status, code, f"上传失败: {exc}") from None
            raise PanelError(500, "io",
                             f"上传失败: {type(exc).__name__}: {exc}") from None
        return {"ok": True, "path": remote, "size": written}

    @router.get("/download")
    async def download(request: Request, tab_id: str, path: str):
        check_token(request.headers)
        ch = await _channel(tab_id)
        target = _norm(path)
        attrs = await _io("下载失败", ch.sftp.stat(target))
        name = posixpath.basename(target.rstrip("/")) or "download"
        headers = {
            "Content-Disposition":
                f"attachment; filename*=UTF-8''{urlquote(name)}"}
        if getattr(attrs, "size", None) is not None:
            headers["Content-Length"] = str(attrs.size)

        async def gen():
            async with ch.sftp.open(target, "rb") as f:
                while chunk := await f.read(_CHUNK):
                    yield chunk

        return StreamingResponse(gen(), media_type="application/octet-stream",
                                 headers=headers)

    @router.post("/mkdir")
    async def mkdir(request: Request, tab_id: str, path: str):
        check_token(request.headers)
        ch = await _channel(tab_id)
        await _io("创建文件夹失败", ch.sftp.mkdir(_norm(path)))
        return {"ok": True, "path": _norm(path)}

    @router.post("/create")
    async def create_file(request: Request, tab_id: str, path: str):
        check_token(request.headers)
        ch = await _channel(tab_id)
        target = _norm(path)
        import asyncssh

        # 先探再建：存在的判据不猜异常文案（不同服务器措辞不一），只信 stat。
        try:
            await ch.sftp.stat(target)
        except Exception:                   # noqa: BLE001 - 不存在/不可判都往下走
            pass
        else:
            raise PanelError(409, "exists", f"已存在同名文件：{target}",
                             exists=True)
        try:
            # "x" = FXF_WRITE|FXF_CREAT|FXF_EXCL：已存在即失败，绝不截断。
            # 旧实现用 "wb"（FXF_TRUNC），换个老实的 SFTP 服务器就把同名旧
            # 文件清成 0 字节——「新建文件」变成数据损坏。
            async with ch.sftp.open(target, "x") as f:
                await f.write(b"")
        except asyncssh.SFTPError as exc:
            # 竞态兜底：stat 与 open 之间被别人建出来了
            if isinstance(exc, asyncssh.SFTPFailure):
                try:
                    await ch.sftp.stat(target)
                except Exception:           # noqa: BLE001
                    pass
                else:
                    raise PanelError(409, "exists",
                                     f"已存在同名文件：{target}",
                                     exists=True) from None
            status, code = _code(exc)
            raise PanelError(status, code, f"创建文件失败: {exc}") from None
        except Exception as exc:            # noqa: BLE001
            raise PanelError(500, "io",
                             f"创建文件失败: {type(exc).__name__}: {exc}") from None
        return {"ok": True, "path": target}

    @router.get("/read")
    async def read_file(request: Request, tab_id: str, path: str):
        check_token(request.headers)
        ch = await _channel(tab_id)
        target = _norm(path)
        attrs = await _io("读取文件失败", ch.sftp.stat(target))
        if getattr(attrs, "size", 0) and attrs.size > _EDIT_LIMIT:
            raise PanelError(400, "too_large",
                             f"文件过大（{_EDIT_LIMIT // 1024 // 1024}MB 上限），"
                             "不支持在线编辑，请下载后编辑")
        data = await _io("读取文件失败", _read_all(ch.sftp, target))
        return {"path": target, "name": posixpath.basename(target.rstrip("/")),
                "size": len(data),
                "content": bytes(data).decode("utf-8", errors="replace")}

    async def _read_all(sftp, path: str) -> bytes:
        async with sftp.open(path, "rb") as f:
            return await f.read(_EDIT_LIMIT + 1)

    @router.post("/write")
    async def write_file(request: Request, tab_id: str, path: str):
        check_token(request.headers)
        body = await request.body()
        if len(body) > _EDIT_LIMIT:
            raise PanelError(400, "too_large",
                             f"内容过大（{_EDIT_LIMIT // 1024 // 1024}MB 上限），"
                             "不支持在线保存")
        ch = await _channel(tab_id)
        target = _norm(path)
        await _io("保存文件失败", _write_all(ch.sftp, target, body))
        return {"ok": True, "path": target, "size": len(body)}

    async def _write_all(sftp, path: str, body: bytes) -> None:
        tmp = _temp_name(path)
        try:
            async with sftp.open(tmp, "wb") as f:
                await f.write(body)
            await _replace(sftp, tmp, path)
        except Exception:                   # noqa: BLE001
            with suppress(Exception):
                await sftp.remove(tmp)
            raise

    @router.post("/delete")
    async def delete_path(request: Request, tab_id: str, path: str):
        check_token(request.headers)
        ch = await _channel(tab_id)
        target = _norm(path)
        attrs = await _io("删除失败", ch.sftp.stat(target))
        is_dir = _is_dir(attrs)
        if is_dir:
            await _io("删除失败", ch.sftp.rmtree(target))   # 前端确认框已明示递归
        else:
            await _io("删除失败", ch.sftp.remove(target))
        return {"ok": True, "path": target, "is_dir": is_dir}

    return router
