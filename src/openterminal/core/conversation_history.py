"""Web 对话历史：完整 LangGraph 完成态与可回放消息保存在本机 SQLite。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

from ..config import TargetConfig, app_dir

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  target_key TEXT NOT NULL,
  target_name TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  snapshot_kind TEXT,
  snapshot BLOB,
  replay TEXT NOT NULL,
  ui_frames TEXT NOT NULL DEFAULT '[]',
  manual_sections TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_target
  ON conversations(target_key, updated_at DESC);
"""
_SCHEMA_VERSION = 2
_MAX_UI_FRAMES_CHARS = 8 * 1024 * 1024


def db_path() -> Path:
    return app_dir() / "conversation_history.db"


def connection_key(name: str, target: TargetConfig) -> str:
    """地址三元组稳定标识连接：改名保留历史，地址变更自动隔离。"""
    if target.mode == "local" or name in {"local", "default"}:
        payload = "local"
    else:
        payload = json.dumps(
            ["ssh", target.host or "", target.port or 22, target.user or ""],
            ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path))
    db.row_factory = sqlite3.Row
    db.executescript(_SCHEMA)
    columns = {row[1] for row in db.execute("PRAGMA table_info(conversations)")}
    if "ui_frames" not in columns:
        db.execute("ALTER TABLE conversations ADD COLUMN ui_frames TEXT NOT NULL DEFAULT '[]'")
        db.commit()
    return db


class ConversationHistory:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path

    def start(
        self, *, target_key: str, target_name: str, title: str,
        parent_id: str | None = None, model: str = "",
    ) -> str:
        conversation_id = uuid.uuid4().hex
        now = int(time.time())
        with _connect(self.path) as db:
            db.execute(
                "INSERT INTO conversations("
                "id,parent_id,target_key,target_name,title,status,model,"
                "snapshot_kind,snapshot,replay,ui_frames,manual_sections,"
                "schema_version,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (conversation_id, parent_id, target_key, target_name,
                 title.strip() or "新对话", "interrupted", model, None, None,
                 "[]", "[]", "[]", _SCHEMA_VERSION, now, now))
        return conversation_id

    def save_complete(
        self, conversation_id: str, values: dict, manual_sections: list[str],
        *, model: str = "",
    ) -> None:
        serializer = JsonPlusSerializer()
        kind, snapshot = serializer.dumps_typed(values)
        replay = json.dumps(_replay_messages(values), ensure_ascii=False)
        now = int(time.time())
        with _connect(self.path) as db:
            cursor = db.execute(
                "UPDATE conversations SET status='completed',model=?,"
                "snapshot_kind=?,snapshot=?,replay=?,manual_sections=?,"
                "schema_version=?,updated_at=? WHERE id=?",
                (model, kind, snapshot, replay,
                 json.dumps(manual_sections, ensure_ascii=False),
                 _SCHEMA_VERSION, now, conversation_id))
            if cursor.rowcount != 1:
                raise LookupError(f"unknown conversation: {conversation_id}")

    def mark_interrupted(self, conversation_id: str, title: str | None = None) -> None:
        with _connect(self.path) as db:
            if title:
                cursor = db.execute(
                    "UPDATE conversations SET status='interrupted',title=?,updated_at=? "
                    "WHERE id=?", (title.strip() or "新对话", int(time.time()),
                                   conversation_id))
            else:
                cursor = db.execute(
                    "UPDATE conversations SET status='interrupted',updated_at=? "
                    "WHERE id=?", (int(time.time()), conversation_id))
            if cursor.rowcount != 1:
                raise LookupError(f"unknown conversation: {conversation_id}")

    def save_ui_frames(self, conversation_id: str, frames: list[dict]) -> None:
        encoded = json.dumps(frames, ensure_ascii=False, separators=(",", ":"))
        if len(encoded) > _MAX_UI_FRAMES_CHARS:
            raise ValueError("界面回放数据超过 8 MB 上限")
        with _connect(self.path) as db:
            cursor = db.execute(
                "UPDATE conversations SET ui_frames=?,updated_at=? WHERE id=?",
                (encoded, int(time.time()), conversation_id))
            if cursor.rowcount != 1:
                raise LookupError(f"unknown conversation: {conversation_id}")

    def set_pending_title(self, conversation_id: str, title: str) -> None:
        with _connect(self.path) as db:
            db.execute(
                "UPDATE conversations SET title=?,updated_at=? WHERE id=?",
                (title.strip() or "新对话", int(time.time()), conversation_id))

    def list(self, target_key: str, *, limit: int = 100) -> list[dict]:
        with _connect(self.path) as db:
            rows = db.execute(
                "SELECT id,parent_id,title,status,model,created_at,updated_at,"
                "snapshot_kind FROM conversations WHERE target_key=? "
                "ORDER BY updated_at DESC LIMIT ?",
                (target_key, limit)).fetchall()
        return [dict(r) | {"continuable": r["snapshot_kind"] is not None}
                for r in rows]

    def get(self, conversation_id: str) -> dict | None:
        with _connect(self.path) as db:
            row = db.execute(
                "SELECT id,parent_id,target_key,target_name,title,status,model,"
                "snapshot_kind,replay,ui_frames,manual_sections,schema_version,created_at,"
                "updated_at FROM conversations WHERE id=?",
                (conversation_id,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["messages"] = json.loads(result.pop("replay"))
        result["ui_frames"] = json.loads(result["ui_frames"])
        result["manual_sections"] = json.loads(result["manual_sections"])
        result["continuable"] = bool(result["snapshot_kind"])
        return result

    def load_snapshot(self, conversation_id: str) -> tuple[dict, list[str]]:
        with _connect(self.path) as db:
            row = db.execute(
                "SELECT snapshot_kind,snapshot,manual_sections,schema_version "
                "FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        if row is None:
            raise LookupError(f"unknown conversation: {conversation_id}")
        if row["schema_version"] > _SCHEMA_VERSION:
            raise ValueError("该历史记录版本不兼容，不能安全恢复")
        if row["snapshot_kind"] is None or row["snapshot"] is None:
            raise ValueError("该对话没有可继续的完成态")
        values = JsonPlusSerializer().loads_typed(
            (row["snapshot_kind"], row["snapshot"]))
        if not isinstance(values, dict):
            raise ValueError("历史上下文格式无效")
        return values, json.loads(row["manual_sections"])

    def delete(self, conversation_id: str) -> bool:
        with _connect(self.path) as db:
            return db.execute(
                "DELETE FROM conversations WHERE id=?", (conversation_id,)
            ).rowcount == 1


def terminal_node(agent) -> str:
    ends = [edge.source for edge in agent.get_graph().edges
            if edge.target == "__end__"]
    unique = list(dict.fromkeys(ends))
    if len(unique) != 1:
        raise RuntimeError("Agent 终点不唯一，不能安全恢复历史上下文")
    return unique[0]


async def restore_completed(agent, config: dict, values: dict) -> None:
    await agent.aupdate_state(config, values, as_node=terminal_node(agent))
    snapshot = await agent.aget_state(config)
    if snapshot.next:
        raise RuntimeError("恢复后的 Agent 仍有待执行节点，已拒绝继续")


def _content_text(content: Any) -> Any:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        blocks = []
        for item in content:
            if not isinstance(item, dict):
                blocks.append(str(item))
                continue
            block_type = item.get("type")
            if block_type == "text":
                blocks.append(str(item.get("text", "")))
            elif block_type in {"image_url", "image"}:
                url = item.get("image_url") or item.get("url")
                if isinstance(url, dict):
                    url = url.get("url")
                blocks.append({"type": "image", "url": str(url or "")})
            else:
                blocks.append(str(item))
        return blocks
    return str(content)


def _replay_messages(values: dict) -> list[dict]:
    replay = []
    for message in values.get("messages", []):
        if isinstance(message, HumanMessage):
            role = "user"
        elif isinstance(message, AIMessage):
            role = "assistant"
        elif isinstance(message, ToolMessage):
            role = "tool"
        else:
            continue
        item = {
            "role": role,
            "content": _content_text(message.content),
        }
        if getattr(message, "tool_call_id", None):
            item["tool_call_id"] = message.tool_call_id
        if getattr(message, "name", None):
            item["name"] = message.name
        if getattr(message, "tool_calls", None):
            item["tool_calls"] = message.tool_calls
        replay.append(item)
    return replay
