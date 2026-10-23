"""真机验证用的 MCP stdio 服务器（用装好的 mcp SDK，走真协议，不是假货）。

工具故意取英文名 + 带句点的名字各一个，顺带验证工具名清洗那条约束：
Anthropic 要求工具名匹配 ^[a-zA-Z0-9_-]{1,128}$，带点的名字必须被改写。

用法：python fixtures/mcp_demo_server.py
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

server = FastMCP("ot-verify-tools", log_level="WARNING")


@server.tool()
def add(a: int, b: int) -> int:
    """把两个整数相加，返回它们的和。"""
    return a + b


@server.tool()
def shout(text: str) -> str:
    """把给定文字转成大写后返回。"""
    return text.upper()


@server.tool(name="search.web")
def search_web(query: str) -> str:
    """假装检索网页，返回一段固定的假结果。"""
    return f"results for {query}"


if __name__ == "__main__":
    server.run(transport="stdio")
