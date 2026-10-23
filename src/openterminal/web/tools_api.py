"""设置页「工具」模块的 REST 面：`/api/mcp-servers*`。

与 skills_api 同一约定：先 `_check_token`，业务错映射成 400/404，401 只留给
访问令牌。连接测试（probe）是真的去连一次 MCP 服务器拉 tools/list，失败时把
真实原因回给界面——这类错最忌讳只报「失败」两个字。
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request

from .. import mcp_servers


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, mcp_servers.McpNotFound):
        return HTTPException(404, str(exc))
    if isinstance(exc, mcp_servers.McpError):
        return HTTPException(400, str(exc))
    return HTTPException(500, f"MCP 操作失败：{exc}")


async def _io(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except (mcp_servers.McpError, mcp_servers.McpNotFound) as exc:
        raise _http(exc) from exc


def make_tools_router(check_token) -> APIRouter:
    router = APIRouter(prefix="/api/mcp-servers")

    @router.get("")
    async def list_servers(request: Request):
        check_token(request.headers)
        return {"servers": await _io(mcp_servers.list_servers)}

    @router.post("")
    async def add_server(request: Request, payload: dict):
        check_token(request.headers)
        return await _io(mcp_servers.save_server, payload)

    @router.put("/{server_id}")
    async def edit_server(request: Request, server_id: str, payload: dict):
        check_token(request.headers)
        return await _io(mcp_servers.update_server, payload, server_id)

    @router.delete("/{server_id}")
    async def remove_server(request: Request, server_id: str):
        check_token(request.headers)
        if not await _io(mcp_servers.delete_server, server_id):
            raise HTTPException(404, "MCP 服务器不存在")
        return {"ok": True}

    @router.post("/{server_id}/enabled")
    async def set_enabled(request: Request, server_id: str, payload: dict):
        check_token(request.headers)
        if "enabled" not in payload:
            raise HTTPException(400, "缺少 enabled 字段")
        if not await _io(mcp_servers.set_enabled, server_id, bool(payload.get("enabled"))):
            raise HTTPException(404, "MCP 服务器不存在")
        return {"ok": True, "enabled": bool(payload.get("enabled"))}

    @router.post("/{server_id}/probe")
    async def probe(request: Request, server_id: str):
        """连一次服务器拉 tools/list。连接失败仍回 200 + ok=false，因为这是
        「测试结果」不是「请求失败」——界面要展示具体原因。"""
        check_token(request.headers)
        server = await _io(mcp_servers.get_server, server_id)
        from ..agent.mcp import probe_server

        return await probe_server(server)

    return router
