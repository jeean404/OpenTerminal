"""MCP 服务器登记（mcp_servers.py）：CRUD、校验与连接配置转换。"""

from __future__ import annotations

import pytest

from openterminal import mcp_servers
from openterminal.mcp_servers import (
    McpError, McpNotFound, delete_server, enabled_connections, get_server,
    list_servers, save_server, set_enabled, to_connection, unique_tool_key,
    update_server,
)

from mcp.client.stdio import get_default_environment


def _stdio(**overrides) -> dict:
    payload = {
        "name": "文件系统",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"],
        "env": {},
    }
    payload.update(overrides)
    return payload


def _http(**overrides) -> dict:
    payload = {
        "name": "远程服务",
        "transport": "streamable_http",
        "url": "https://example.com/mcp",
        "headers": {"Authorization": "Bearer token"},
    }
    payload.update(overrides)
    return payload


def test_crud_roundtrip():
    created = save_server(_stdio())
    assert created["id"] and created["enabled"] is True
    assert created["transport_label"].startswith("本地进程")

    listed = {s["name"]: s for s in list_servers()}
    assert "文件系统" in listed

    edited = update_server(_stdio(name="改过的名字"), created["id"])
    assert edited["name"] == "改过的名字"
    assert get_server(created["id"])["name"] == "改过的名字"

    assert delete_server(created["id"]) is True
    assert delete_server(created["id"]) is False
    with pytest.raises(McpNotFound):
        get_server(created["id"])


def test_duplicate_name_rejected():
    save_server(_stdio())
    with pytest.raises(McpError, match="已存在"):
        save_server(_stdio(command="node"))


def test_validation_per_transport():
    with pytest.raises(McpError, match="启动命令"):
        save_server(_stdio(command=""))
    with pytest.raises(McpError, match="URL"):
        save_server(_http(url="example.com/mcp"))
    with pytest.raises(McpError, match="不需要 URL"):
        save_server(_stdio(url="https://example.com"))
    with pytest.raises(McpError, match="不需要启动命令"):
        save_server(_http(command="npx"))


def test_args_accepts_space_separated_string():
    saved = save_server(_stdio(args="-y some-pkg --flag"))
    assert saved["args"] == ["-y", "some-pkg", "--flag"]


def test_to_connection_merges_env_over_defaults():
    """回归：StdioServerParameters(env=...) 是整体替换。用户只加一个变量时
    必须叠在默认环境之上，否则 PATH 丢失、npx 起不来。"""
    server = save_server(_stdio(env={"MY_TOKEN": "x"}))
    connection = to_connection(server)
    assert connection["transport"] == "stdio"
    assert connection["env"]["MY_TOKEN"] == "x"
    assert connection["env"]["PATH"] == get_default_environment()["PATH"]


def test_to_connection_omits_env_when_empty():
    server = save_server(_stdio())
    connection = to_connection(server)
    assert "env" not in connection, "没配环境变量时别传 env，交给 SDK 的默认环境"


def test_to_connection_remote_shape():
    server = save_server(_http())
    connection = to_connection(server)
    assert connection == {
        "transport": "streamable_http",
        "url": "https://example.com/mcp",
        "headers": {"Authorization": "Bearer token"},
    }


def test_enabled_connections_skips_disabled_and_sanitizes_keys():
    """键名是工具名前缀，必须过 Anthropic 的工具名正则。"""
    first = save_server(_stdio(name="文件系统 A"))
    second = save_server(_stdio(name="second server"))
    third = save_server(_http(name="远程", url="https://example.com/sse",
                              transport="sse", headers={}))
    set_enabled(third["id"], False)

    keys = enabled_connections()
    # 停用的那台不该出现；键名是工具名前缀，必须只含 [A-Za-z0-9_-]
    assert set(keys) == {"A", "second_server"}
    for key in keys:
        assert all(ch.isalnum() or ch in "_-" for ch in key), key


def test_unique_tool_key_disambiguates():
    used: set[str] = set()
    assert unique_tool_key("工具", used) == "srv"
    assert unique_tool_key("工具", used) == "srv_2"
    assert unique_tool_key("search.web", used) == "search_web"


def test_enable_flag_roundtrip():
    server = save_server(_stdio())
    assert server["enabled"] is True
    set_enabled(server["id"], False)
    assert get_server(server["id"])["enabled"] is False
    assert enabled_connections() == {}
    set_enabled(server["id"], True)
    assert get_server(server["id"])["enabled"] is True


def test_update_missing_server_raises():
    with pytest.raises(McpNotFound):
        update_server(_stdio(), "missing-id")


def test_sanitize_keeps_meaningful_prefix():
    assert mcp_servers.sanitize_tool_token("My Server 2.0") == "My_Server_2_0"
    assert mcp_servers.sanitize_tool_token("") == "srv"
