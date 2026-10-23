"""把启用中的 MCP 服务器接进 agent 的工具表。

走 `langchain-mcp-adapters` 的 `MultiServerMCPClient`：它负责协议握手、
`tools/list` 与 `tools/call`，我们只做「哪些服务器」「叫什么名字」两件事。
库本身不是 async context manager（`async with` 直接抛 NotImplementedError），
用法固定是 `client = MultiServerMCPClient(...)  tools = await client.get_tools()`。

三个约定：

- **单服务器失败不拖垮整体**：一个坏掉的 MCP 服务器不该让整个 agent 建不起来，
  故逐台 `get_tools(server_name=...)` 各自兜异常。
- **工具名必须过 API 正则**：见 mcp_servers.sanitize_tool_token。
- **导入惰性**：langchain-mcp-adapters / mcp 属 AI 栈，只在真正建 agent 时才
  import（与 deepagents 同批，见 core/ai_flow 的 _load_agent_stack）。
"""

from __future__ import annotations

import asyncio
import logging

from ..mcp_servers import sanitize_tool_token, unique_tool_key

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 20.0


def _rename(tool, used: set[str]):
    """把工具名压成 API 允许的形式并消歧（同名工具在多服务器下会撞）。"""
    safe = unique_tool_key(getattr(tool, "name", "") or "tool", used)
    if safe == tool.name:
        return tool
    try:
        return tool.model_copy(update={"name": safe})
    except Exception:  # noqa: BLE001 - 改名失败就用原名，别为这个丢工具
        return tool


async def _server_tools(client, key: str, *, timeout: float) -> list:
    try:
        return await asyncio.wait_for(client.get_tools(server_name=key), timeout)
    except Exception as exc:  # noqa: BLE001 - 任何一台坏掉都不该打死整体装配
        logger.warning("MCP 服务器 %s 工具拉取失败：%s", key, exc)
        return []


def _make_client(connections: dict):
    """导入 + 构造都同步且不便宜，故由调用方丢进线程池（别冻住事件循环）。"""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    return MultiServerMCPClient(connections, tool_name_prefix=True)


async def gather_mcp_tools(*, timeout: float = DEFAULT_TIMEOUT) -> list:
    """启用中的全部 MCP 工具；没有配置或全失败时返回空表（agent 照常能建）。"""
    from ..mcp_servers import enabled_connections

    connections = enabled_connections()
    if not connections:
        return []
    client = await asyncio.to_thread(_make_client, connections)
    tools: list = []
    used: set[str] = set()
    for key in connections:
        for tool in await _server_tools(client, key, timeout=timeout):
            tools.append(_rename(tool, used))
    return tools


async def probe_server(server: dict, *, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """设置页「连接测试」：拉一次 tools/list 回给界面，失败把原因说清楚。"""
    from ..mcp_servers import to_connection

    key = sanitize_tool_token(server["name"])
    client = await asyncio.to_thread(
        _make_client, {key: to_connection(server)})
    try:
        tools = await asyncio.wait_for(client.get_tools(server_name=key), timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"{int(timeout)} 秒内没有响应，服务器可能未启动或地址不通"}
    except Exception as exc:  # noqa: BLE001 - 把真实原因回给用户，别吞
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    # 与 gather_mcp_tools 同一条改名路径：界面看到的名字必须就是模型看到的，
    # 否则「连接测试」会把一个模型根本调不到的名字报给用户
    used: set[str] = set()
    renamed = [_rename(tool, used) for tool in tools]
    return {
        "ok": True,
        "tools": [
            {
                "name": tool.name,
                "description": (tool.description or "").strip(),
                "input_schema": getattr(tool, "args_schema", None)
                and _schema_of(tool) or {},
            }
            for tool in renamed
        ],
    }


def _schema_of(tool) -> dict:
    """StructuredTool.args_schema 可能是 pydantic 模型类，取它的 JSON Schema。"""
    schema = getattr(tool, "args_schema", None)
    if schema is None:
        return {}
    model_json_schema = getattr(schema, "model_json_schema", None)
    if callable(model_json_schema):
        try:
            return model_json_schema()
        except Exception:  # noqa: BLE001
            return {}
    return schema if isinstance(schema, dict) else {}
