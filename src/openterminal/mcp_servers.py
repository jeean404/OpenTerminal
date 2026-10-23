"""MCP 服务器登记：SQLite CRUD + 转成 langchain-mcp-adapters 的连接配置。

存储照 model_profiles 的形状（id 主键 + state 表），传输配置按 MCP 的三种
常见形态分列：stdio（command/args/env）与远程（url/headers）。

两个真机坑写死在 `to_connection()` 里：

1. **`env` 是整体替换不是叠加**。`StdioServerParameters(env=...)` 一旦传就不再
   继承 `get_default_environment()`，用户只加一个 `FOO=bar` 就会连 PATH 一起
   丢掉、`npx` 直接找不到。故用户 env 叠在默认环境之上。
2. **工具名要过 Anthropic 的 `^[a-zA-Z0-9_-]{1,128}$`**。服务器名与工具名都
   可能带空格/点/中文，原样透传会被模型 API 直接拒掉，故统一清洗并消歧。
"""

from __future__ import annotations

import json
import re
import uuid

TRANSPORTS = ("stdio", "streamable_http", "sse")
TRANSPORT_LABELS = {
    "stdio": "本地进程 (stdio)",
    "streamable_http": "远程 HTTP",
    "sse": "远程 SSE",
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS mcp_servers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  url TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);
"""

# Anthropic 工具名约束；顺带限制长度，避免 server+tool 拼接超 128
_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")


class McpError(ValueError):
    """业务校验失败（HTTP 400）。"""


class McpNotFound(LookupError):
    """服务器不存在（HTTP 404）。"""


def _connection():
    from .connections.db import connect

    conn = connect()
    conn.executescript(_SCHEMA)
    return conn


def _loads(text: str, fallback):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return fallback


def sanitize_tool_token(value: str, *, limit: int = 48) -> str:
    """把任意名字压成 API 允许的工具名片段（保留语义前缀，够认即可）。"""
    cleaned = _SAFE_RE.sub("_", str(value or "")).strip("_")
    return (cleaned or "srv")[:limit]


def unique_tool_key(name: str, used: set[str]) -> str:
    key = sanitize_tool_token(name)
    base, n = key, 2
    while key in used:
        suffix = f"_{n}"
        key = f"{base[: 64 - len(suffix)]}{suffix}"
        n += 1
    used.add(key)
    return key


def _row_to_server(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "transport": row["transport"],
        "command": row["command"],
        "args": _loads(row["args"], []),
        "env": _loads(row["env"], {}),
        "url": row["url"],
        "headers": _loads(row["headers"], {}),
        "enabled": bool(row["enabled"]),
        "transport_label": TRANSPORT_LABELS.get(row["transport"], row["transport"]),
    }


def list_servers() -> list[dict]:
    conn = _connection()
    try:
        rows = conn.execute(
            "SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE, id"
        ).fetchall()
    finally:
        conn.close()
    return [_row_to_server(row) for row in rows]


def get_server(server_id: str) -> dict:
    conn = _connection()
    try:
        row = conn.execute(
            "SELECT * FROM mcp_servers WHERE id=?", (server_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise McpNotFound("MCP 服务器不存在")
    return _row_to_server(row)


def _clean(data: dict, *, server_id: str | None) -> dict:
    name = str(data.get("name") or "").strip()
    transport = str(data.get("transport") or "").strip()
    if not name:
        raise McpError("请填写服务器名称")
    if len(name) > 80:
        raise McpError("服务器名称不能超过 80 个字符")
    if transport not in TRANSPORTS:
        raise McpError("传输方式只能是 stdio / streamable_http / sse")

    command = str(data.get("command") or "").strip()
    url = str(data.get("url") or "").strip()
    if transport == "stdio":
        if not command:
            raise McpError("本地进程模式必须填写启动命令")
        if url:
            raise McpError("本地进程模式不需要 URL")
    else:
        if not url:
            raise McpError("远程模式必须填写 URL")
        if not url.startswith(("http://", "https://")):
            raise McpError("URL 必须以 http:// 或 https:// 开头")
        if command:
            raise McpError("远程模式不需要启动命令")

    args = data.get("args") or []
    if isinstance(args, str):
        args = [part for part in args.split() if part]
    if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
        raise McpError("参数必须是字符串列表")

    env = data.get("env") or {}
    headers = data.get("headers") or {}
    for field, label in ((env, "环境变量"), (headers, "请求头")):
        if not isinstance(field, dict) or any(
            not isinstance(k, str) or not isinstance(v, str) for k, v in field.items()
        ):
            raise McpError(f"{label}必须是字符串键值对")

    return {
        "id": server_id or uuid.uuid4().hex,
        "name": name,
        "transport": transport,
        "command": command,
        "args": list(args),
        "env": dict(env),
        "url": url,
        "headers": dict(headers),
    }


def save_server(data: dict, server_id: str | None = None, *,
                require_existing: bool = False) -> dict:
    fields = _clean(data, server_id=server_id)
    conn = _connection()
    try:
        if require_existing and not conn.execute(
            "SELECT 1 FROM mcp_servers WHERE id=?", (fields["id"],)
        ).fetchone():
            raise McpNotFound("MCP 服务器不存在")
        # 编辑表单不带 enabled 字段：没显式给就保留原值，别让「改个名字」
        # 顺手把停用中的服务器重新启用
        if "enabled" not in data:
            row = conn.execute(
                "SELECT enabled FROM mcp_servers WHERE id=?", (fields["id"],)
            ).fetchone()
            enabled = (row["enabled"] if row else 1)
        else:
            enabled = 1 if data.get("enabled") else 0
        duplicate = conn.execute(
            "SELECT 1 FROM mcp_servers WHERE name=? AND id<>?",
            (fields["name"], fields["id"]),
        ).fetchone()
        if duplicate:
            raise McpError(f"服务器名称“{fields['name']}”已存在")
        conn.execute(
            "INSERT INTO mcp_servers(id, name, transport, command, args, env, "
            "url, headers, enabled) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, "
            "transport=excluded.transport, command=excluded.command, "
            "args=excluded.args, env=excluded.env, url=excluded.url, "
            "headers=excluded.headers, enabled=excluded.enabled",
            (fields["id"], fields["name"], fields["transport"], fields["command"],
             json.dumps(fields["args"], ensure_ascii=False),
             json.dumps(fields["env"], ensure_ascii=False),
             fields["url"],
             json.dumps(fields["headers"], ensure_ascii=False), enabled),
        )
        conn.commit()
    finally:
        conn.close()
    return get_server(fields["id"])


def update_server(data: dict, server_id: str) -> dict:
    return save_server(data, server_id, require_existing=True)


def delete_server(server_id: str) -> bool:
    conn = _connection()
    try:
        deleted = conn.execute(
            "DELETE FROM mcp_servers WHERE id=?", (server_id,)
        ).rowcount
        conn.commit()
    finally:
        conn.close()
    return bool(deleted)


def set_enabled(server_id: str, enabled: bool) -> bool:
    conn = _connection()
    try:
        updated = conn.execute(
            "UPDATE mcp_servers SET enabled=? WHERE id=?",
            (1 if enabled else 0, server_id),
        ).rowcount
        conn.commit()
    finally:
        conn.close()
    return bool(updated)


# --------------------------------------------------------------------------
# 运行时侧：登记项 → langchain-mcp-adapters 的 Connection
# --------------------------------------------------------------------------

def to_connection(server: dict) -> dict:
    """转成 langchain_mcp_adapters.sessions.Connection。

    注意 `env` 的整体替换语义（见模块 docstring）：用户 env 必须叠在
    `get_default_environment()` 之上，否则 PATH 没了、`npx` 起不来。
    """
    if server["transport"] == "stdio":
        env = dict(server.get("env") or {})
        if env:
            from mcp.client.stdio import get_default_environment

            env = {**get_default_environment(), **env}
        return {
            "transport": "stdio",
            "command": server["command"],
            "args": list(server.get("args") or []),
            **({"env": env} if env else {}),
        }
    return {
        "transport": server["transport"],
        "url": server["url"],
        **({"headers": dict(server["headers"])} if server.get("headers") else {}),
    }


def enabled_connections() -> dict[str, dict]:
    """启用中的服务器 → {工具名前缀: Connection}。前缀已清洗，可直接拼工具名。"""
    used: set[str] = set()
    out: dict[str, dict] = {}
    for server in list_servers():
        if not server["enabled"]:
            continue
        out[unique_tool_key(server["name"], used)] = to_connection(server)
    return out


# --------------------------------------------------------------------------
# JSON 导入（Claude Desktop / .mcp.json 风格）
# --------------------------------------------------------------------------

_TYPE_ALIAS = {
    "": None,
    "stdio": "stdio", "local": "stdio",
    "http": "streamable_http", "https": "streamable_http",
    "streamable_http": "streamable_http", "streamable-http": "streamable_http",
    "streamablehttp": "streamable_http",
    "sse": "sse",
}


def extract_servers_config(data) -> dict:
    """从 JSON 文本/对象里取出 {名称: 配置}。

    收两种形态：标准的 ``{"mcpServers": {...}}`` 包装，以及裸的 ``{名称: {...}}``
    ——后者就是把包装层去掉的同一份东西，没必要让用户多包一层。
    """
    if isinstance(data, str):
        text = data.strip()
        if not text:
            raise McpError("请粘贴 MCP 配置 JSON")
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise McpError(f"JSON 解析失败：{exc}") from exc
    if not isinstance(data, dict):
        raise McpError("JSON 顶层必须是对象")
    # 包装键「存在但为空」要与「没有该键」区分开：空字典是 falsy，用 or 会把
    # {"mcpServers": {}} 误当裸映射解析，报出「远程模式必须填写 URL」这种
    # 让人摸不着头脑的错
    if "mcpServers" in data or "mcp_servers" in data:
        block = data.get("mcpServers") or data.get("mcp_servers")
    else:
        block = data
    if not isinstance(block, dict) or not block:
        raise McpError(
            '没找到服务器配置，应形如 {"mcpServers": {"名称": {...}}} 或 {"名称": {...}}')
    return {str(name): entry for name, entry in block.items()}


def _normalize_entry(name: str, entry: dict) -> dict:
    """把一条外部配置转成本库字段；传输方式从 command/url 推断，显式给则优先。"""
    if not isinstance(entry, dict):
        raise McpError(f"「{name}」的配置必须是对象")
    raw = str(entry.get("transport") or entry.get("type") or "").strip().lower()
    if raw == "websocket":
        raise McpError(f"「{name}」暂不支持 websocket 传输，请用 http 或 sse")
    transport = _TYPE_ALIAS.get(raw)
    if raw and transport is None:
        raise McpError(f"「{name}」的传输方式 {raw!r} 无法识别")
    if transport is None:
        transport = "stdio" if entry.get("command") else "streamable_http"
    return {
        "name": name,
        "transport": transport,
        "command": str(entry.get("command") or "").strip(),
        "args": entry.get("args") or [],
        "env": entry.get("env") or {},
        "url": str(entry.get("url") or "").strip(),
        "headers": entry.get("headers") or {},
        "enabled": entry.get("enabled", True),
    }


def import_config(data) -> dict:
    """导入一份配置：同名更新、新名新增，一次可多条。

    **先全量校验再落库**：任一条非法就一条都不写，否则导入一半比报错更难收拾。
    """
    raw = extract_servers_config(data)
    existing = {s["name"]: s for s in list_servers()}

    planned = []
    for name, entry in raw.items():
        payload = _normalize_entry(name, entry)
        payload["id"] = existing[name]["id"] if name in existing else None
        planned.append(payload)

    # 只校验不落库；_clean 会做传输方式/字段的交叉校验
    for payload in planned:
        _clean(payload, server_id=payload["id"])

    added, updated = [], []
    for payload in planned:
        saved = save_server(
            payload, payload["id"], require_existing=bool(payload["id"]))
        (updated if payload["id"] else added).append(saved)
    return {"added": added, "updated": updated}
