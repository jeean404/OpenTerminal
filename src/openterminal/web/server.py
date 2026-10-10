"""ot web：FastAPI 服务 + uvicorn 启动。"""

from __future__ import annotations

import argparse
import asyncio
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..cmdset import extract_inline_secrets
from ..config import Config, TargetConfig
from ..connections import (
    RenameConflictError, build_target_list, cred_alias_eq,
    credential_referenced, delete_saved_target, display_name,
    find_saved_target, load_saved_targets, parse_user_at_host,
    rename_saved_target, upsert_saved_target,
)
from ..secrets_store import delete_password, store_password
from ..render import console
from .protocol import parse_client
from .worker import TabWorker

FRONTEND_DIR = Path(__file__).parent / "frontend"


def _conn_fields(payload: dict) -> tuple[str | None, str | None, int | None]:
    """表单 payload → (host, user, port)。

    新表单直接给 host/user/port 字段；兼容旧的 {target: "user@host:port"}
    字符串（脚本/旧前端）。
    """
    if (payload.get("host") or "").strip():
        host = str(payload["host"]).strip()
        user = (payload.get("user") or "").strip() or None
        port = payload.get("port")
        try:
            port = int(port) if port not in (None, "") else None
        except (TypeError, ValueError):
            port = None
        return host, user, port
    text = str(payload.get("target", "")).strip()
    host, user, port = parse_user_at_host(text)
    return (host or None), user, port


def _store_form_password(payload: dict, host: str, user: str | None,
                         port: int | None) -> None:
    """表单带密码时存入系统凭据库（keyring）；密码永不落 SQLite。"""
    password = payload.get("password") or ""
    if password:
        store_password(host, user, port, password)
def _resolve_target_name(cfg: Config, text: str) -> str:
    """目标名或 ad-hoc user@host 都解析成目标名。

    记住的连接（connections.db）按 name 直接注册（含 host/user/port），
    否则 ad-hoc user@host 重建临时目标。
    """
    if text in cfg.targets or text in {"local", "default"}:
        return text
    for t in load_saved_targets():
        if t.name == text:
            cfg.targets[text] = t
            return text
    host, user, port = parse_user_at_host(text)
    name = text if user is None and port is None else host
    cfg.targets.setdefault(
        name, TargetConfig(name=name, mode="ssh", host=host, user=user, port=port))
    return name


def create_app(cfg: Config, *, token: str = "") -> FastAPI:
    tabs: dict[str, TabWorker] = {}
    # 断线回收任务：浏览器刷新/断网后 ws 关闭，但 PTY/远端 shell 还活着；
    # 给一段宽限期（可重连），到点仍无人挂上就真正回收
    reapers: dict[str, asyncio.Task] = {}
    _REAPER_GRACE = 300.0   # 5 分钟

    async def _reap_later(tab_id: str) -> None:
        await asyncio.sleep(_REAPER_GRACE)
        reapers.pop(tab_id, None)
        worker = tabs.get(tab_id)
        # attach 时会取消本任务；这里再核一层 sink 兜底
        if worker is not None and worker._sink is None:
            tabs.pop(tab_id, None)
            await worker.close()

    def _cancel_reaper(tab_id: str) -> None:
        t = reapers.pop(tab_id, None)
        if t is not None:
            t.cancel()

    @asynccontextmanager
    async def lifespan(_app):
        yield
        for t in reapers.values():
            t.cancel()
        for w in list(tabs.values()):
            await w.close()

    app = FastAPI(title="OpenTerminal Web", lifespan=lifespan)

    @app.middleware("http")
    async def _revalidate_static(request, call_next):
        resp = await call_next(request)
        # 前端资源强制每次校验（未变走 ETag 304），避免升级后浏览器沿用旧 JS/CSS
        if request.url.path.startswith(("/static/", "/vendor/")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    def _check_token(headers) -> None:
        if token and headers.get("x-ot-token") != token:
            raise HTTPException(401, "token 缺失或不正确")

    app.mount("/static", StaticFiles(directory=FRONTEND_DIR / "static"), name="static")
    app.mount("/vendor", StaticFiles(directory=FRONTEND_DIR / "vendor"), name="vendor")

    @app.get("/")
    async def index():
        return FileResponse(FRONTEND_DIR / "index.html")

    @app.get("/api/targets")
    async def targets(request: Request):
        _check_token(request.headers)
        return _target_payload()

    @app.post("/api/tabs")
    async def create_tab(request: Request, payload: dict):
        _check_token(request.headers)
        target = payload.get("target")
        if not target:
            raise HTTPException(400, "target required")
        name = _resolve_target_name(cfg, target)
        worker = TabWorker(cfg, name)
        tabs[worker.tab_id] = worker
        return {"tab_id": worker.tab_id}

    @app.post("/api/tabs/{tab_id}/close")
    async def close_tab(request: Request, tab_id: str):
        _check_token(request.headers)
        worker = tabs.pop(tab_id, None)
        if worker is not None:
            await worker.close()
        return {"ok": True}

    @app.post("/api/saved")
    async def add_saved(request: Request, payload: dict):
        _check_token(request.headers)
        host, user, port = _conn_fields(payload)
        if not host:
            raise HTTPException(400, "host required")
        name = (payload.get("name") or "").strip() or display_name(host, user, port)
        commands = None
        resp: dict = {"ok": True, "name": name}
        if "commands" in payload:
            commands, failed = extract_inline_secrets(payload["commands"])
            resp["commands"] = commands
            if failed:
                resp["warning"] = "凭据库不可用，以下密码未保存: " + ", ".join(failed)
        upsert_saved_target(name=name, host=host, port=port, user=user,
                            commands=commands)
        # 内存注册表同步失效:cfg.targets 里缓存的是旧配置(含命令集),
        # 不弹出的话下次连接仍用缓存(真机:改了命令集连了却没生效)
        cfg.targets.pop(name, None)
        _store_form_password(payload, host, user, port)
        return resp

    @app.put("/api/saved/{name}")
    async def edit_saved(request: Request, name: str, payload: dict):
        _check_token(request.headers)
        old = find_saved_target(name)
        if old is None:
            raise HTTPException(404, "unknown target")
        host, user, port = _conn_fields(payload)
        if not host:
            raise HTTPException(400, "host required")
        new_name = (payload.get("name") or "").strip() or name
        commands = None
        resp: dict = {"ok": True, "name": new_name}
        if "commands" in payload:
            commands, failed = extract_inline_secrets(payload["commands"])
            resp["commands"] = commands
            if failed:
                resp["warning"] = "凭据库不可用，以下密码未保存: " + ", ".join(failed)
        try:
            removed = rename_saved_target(name, name=new_name, host=host,
                                          port=port, user=user,
                                          commands=commands)
        except RenameConflictError:
            # 新名字撞上另一条既有条目：拒绝写入（不再静默合并覆盖）
            raise HTTPException(409, f"名称 {new_name} 已被另一条连接占用")
        if removed is None:
            # find 与 rename 之间条目被并发删除
            raise HTTPException(404, "unknown target")
        # 内存注册表同步失效(旧名可能已缓存/新名可能撞旧缓存)
        cfg.targets.pop(name, None)
        cfg.targets.pop(new_name, None)
        if not cred_alias_eq((removed.host, removed.user, removed.port),
                             (host, user, port)):
            # 地址变了（port None/22 视同没变——凭据键别名，改端口写法不
            # 该作废密码）。表单密码留空 = 「留空不修改」：旧凭据原样保留
            # （旧实现删了不写，静默丢）；带新密码才清旧键，且仅当无其他
            # 条目共享——三条跳板条目共用 pe@跳板 键，删一毁三（§2-6）
            if (payload.get("password") or "") and not credential_referenced(
                    removed.host, removed.user, removed.port):
                delete_password(removed.host, removed.user, removed.port)
        _store_form_password(payload, host, user, port)
        return resp

    @app.delete("/api/saved/{name}")
    async def remove_saved(request: Request, name: str):
        _check_token(request.headers)
        removed = delete_saved_target(name)
        if removed is None:
            raise HTTPException(404, "unknown target")
        if not credential_referenced(removed.host, removed.user, removed.port):
            # 共享键防误删：还有别的条目共用同一凭据（别名语义）就不动，
            # 凭据仍服务其余条目；无引用才清（不留孤儿密码）
            delete_password(removed.host, removed.user, removed.port)
        cfg.targets.pop(name, None)  # 内存注册表同步反注册
        return {"ok": True}

    @app.websocket("/ws/{tab_id}")
    async def ws(ws: WebSocket, tab_id: str):
        # token 校验：header 或 query（浏览器 WebSocket 无法设自定义 header，
        # 前端以 ?token= 携带）
        q_token = ws.query_params.get("token", "")
        if token and ws.headers.get("x-ot-token") != token and q_token != token:
            await ws.close(code=4401)
            return
        worker = tabs.get(tab_id)
        if worker is None:
            await ws.close(code=4404)
            return
        await ws.accept()
        sink = _WebSink(ws)
        _cancel_reaper(tab_id)     # 重连成功：撤销待回收
        worker.attach(sink)
        try:
            while True:
                frame = await ws.receive()
                kind = frame.get("type")
                if kind == "websocket.disconnect":
                    break
                raw = frame.get("bytes")
                if raw is None:
                    raw = frame.get("text")
                if raw is None:
                    continue
                try:
                    await worker.handle_client(parse_client(raw))
                except Exception:  # noqa: BLE001 - 单条消息异常不打死连接
                    continue
        except WebSocketDisconnect:
            pass
        finally:
            worker.detach(sink)
            if worker._sink is None:
                # 断线/刷新：宽限期内前端可重连；到点仍无人挂上则关闭
                # worker（PTY/远端 shell 随之释放），否则每次刷新都泄漏一份
                reapers[tab_id] = asyncio.create_task(_reap_later(tab_id))

    return app


class _WebSink:
    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws

    async def send_bytes(self, data: bytes) -> None:
        await self._ws.send_bytes(data)

    async def send_text(self, text: str) -> None:
        await self._ws.send_text(text)


def _target_payload() -> dict:
    tl = build_target_list()
    return {
        "local": tl.local,
        "direct": [
            {"name": t.name, "host": t.host, "user": t.user, "port": t.port,
             "commands": "\n".join(t.commands)}
            for t in tl.direct
        ],
    }


def run_web(cfg: Config, argv: list[str] | None = None) -> None:
    import faulthandler
    import signal
    import uvicorn

    if hasattr(faulthandler, "register") and hasattr(signal, "SIGUSR1"):
        faulthandler.register(signal.SIGUSR1)  # 临时排障：kill -USR1 <pid> 转储所有线程栈（POSIX）
    argv = argv if argv is not None else []
    p = argparse.ArgumentParser(prog="ot web")
    p.add_argument("--host", default=cfg.web.host)
    p.add_argument("--port", type=int, default=cfg.web.port)
    p.add_argument("--token", default=cfg.web.token)
    p.add_argument("--no-open", action="store_true")
    args = p.parse_args(argv)

    if args.host != "127.0.0.1" and not args.token:
        console.print(
            "[bold red]绑定非本机地址（--host {}) 时必须设置 --token 或 "
            "config.toml [web] token，否则拒绝启动。[/]".format(args.host))
        raise SystemExit(2)

    app = create_app(cfg, token=args.token)
    if not args.no_open:
        webbrowser.open(f"http://127.0.0.1:{args.port}/")
    console.print(f"[bold green]OpenTerminal Web[/] http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port)
