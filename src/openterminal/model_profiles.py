"""Persisted model connection profiles for the Web UI."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from .connections.db import connect
from .connections.secrets import (
    delete_model_api_key,
    load_model_api_key,
    store_model_api_key,
)
from .config import ModelConfig

_SCHEMA = """
CREATE TABLE IF NOT EXISTS model_profiles(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_profile_state(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(_SCHEMA)


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        _ensure_schema(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def list_profiles(*, with_keys: bool = True) -> tuple[list[dict], str | None]:
    with _connection() as conn:
        rows = conn.execute(
            "SELECT id, name, provider, base_url, model "
            "FROM model_profiles ORDER BY name COLLATE NOCASE, id"
        ).fetchall()
        active = conn.execute(
            "SELECT value FROM model_profile_state WHERE key='active'"
        ).fetchone()
    profiles = []
    for row in rows:
        profile = dict(row)
        if with_keys:
            profile["has_api_key"] = load_model_api_key(profile["id"]) is not None
        profiles.append(profile)
    active_id = active["value"] if active else None
    if active_id and not any(p["id"] == active_id for p in profiles):
        active_id = None
    return profiles, active_id


def check_connection(data: dict) -> dict:
    """测试 URL + API Key 能不能连通：发一次最小调用，如实回报结果。

    api_key 留空且带了 profile_id 时用**已保存**的 key——用户不该为了测一下
    连接就把密钥复制出来再贴回去。返回 ``{ok, detail}`` 而不是抛异常：连不通
    是「测试结果」不是「请求出错」，前端据此在弹框里就地显示。
    """
    from .agent.model import build_chat_model

    provider = str(data.get("provider") or "").strip().lower()
    base_url = str(data.get("base_url") or "").strip()
    model = str(data.get("model") or "").strip()
    if provider not in {"anthropic", "openai"} or not model:
        raise ValueError("请先填写协议与模型名称")
    if not base_url and provider == "anthropic":
        raise ValueError("Anthropic 协议必须填写 URL")

    api_key = str(data.get("api_key") or "").strip() or None
    if api_key is None:
        pid = str(data.get("profile_id") or "").strip()
        if pid:
            api_key = load_model_api_key(pid)
    if not api_key:
        raise ValueError("请先填写 API Key")

    chat = build_chat_model(ModelConfig(
        provider=provider, base_url=base_url, model=model, api_key=api_key))
    try:
        reply = chat.invoke("ping")
    except Exception as exc:                     # noqa: BLE001
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
    text = str(getattr(reply, "content", "") or "").strip()
    first = text.splitlines()[0] if text else "（模型已应答）"
    return {"ok": True, "detail": first[:200]}


def save_profile(
    data: dict, profile_id: str | None = None, *, require_existing: bool = False,
) -> dict:
    name = str(data.get("name") or "").strip()
    provider = str(data.get("provider") or "").strip().lower()
    base_url = str(data.get("base_url") or "").strip()
    model = str(data.get("model") or "").strip()
    if not name or provider not in {"anthropic", "openai"} or not model:
        raise ValueError("名称、支持的协议和模型均为必填项")
    if not base_url and provider == "anthropic":
        raise ValueError("Anthropic 协议必须填写 URL")

    profile_id = profile_id or uuid.uuid4().hex
    api_key = data.get("api_key")
    clear_api_key = bool(data.get("clear_api_key"))
    previous_key = (
        load_model_api_key(profile_id) if api_key or clear_api_key else None
    )
    secret_changed = False
    try:
        with _connection() as conn:
            if require_existing and not conn.execute(
                "SELECT 1 FROM model_profiles WHERE id=?", (profile_id,)
            ).fetchone():
                raise LookupError("unknown model profile")
            duplicate = conn.execute(
                "SELECT 1 FROM model_profiles WHERE name=? AND id<>?",
                (name, profile_id),
            ).fetchone()
            if duplicate:
                raise ValueError(f"配置名称“{name}”已存在")
            if api_key:
                if not store_model_api_key(profile_id, str(api_key)):
                    raise RuntimeError("系统凭据库不可用，API Key 未保存")
                secret_changed = True
            if not api_key and clear_api_key:
                if previous_key and not delete_model_api_key(profile_id):
                    raise RuntimeError("系统凭据库不可用，API Key 未清除")
                secret_changed = bool(previous_key)
            conn.execute(
                "INSERT INTO model_profiles(id, name, provider, base_url, model) "
                "VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "name=excluded.name, provider=excluded.provider, "
                "base_url=excluded.base_url, model=excluded.model",
                (profile_id, name, provider, base_url, model),
            )
    except Exception:
        if secret_changed and api_key:
            if previous_key is None:
                delete_model_api_key(profile_id)
            else:
                store_model_api_key(profile_id, previous_key)
        elif secret_changed and clear_api_key and previous_key:
            store_model_api_key(profile_id, previous_key)
        raise

    return {
        "id": profile_id,
        "name": name,
        "provider": provider,
        "base_url": base_url,
        "model": model,
        "has_api_key": load_model_api_key(profile_id) is not None,
    }


def update_profile(data: dict, profile_id: str) -> dict:
    return save_profile(data, profile_id, require_existing=True)


def delete_profile(profile_id: str) -> bool:
    with _connection() as conn:
        conn.execute("BEGIN")
        deleted = conn.execute(
            "DELETE FROM model_profiles WHERE id=?", (profile_id,)
        ).rowcount
        conn.execute(
            "DELETE FROM model_profile_state WHERE key='active' AND value=?",
            (profile_id,),
        )
    if deleted:
        delete_model_api_key(profile_id)
    return bool(deleted)


def activate_profile(profile_id: str) -> bool:
    with _connection() as conn:
        exists = conn.execute(
            "SELECT 1 FROM model_profiles WHERE id=?", (profile_id,)
        ).fetchone()
        if not exists:
            return False
        conn.execute(
            "INSERT INTO model_profile_state(key, value) VALUES('active', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (profile_id,),
        )
    return True


def active_model_config(fallback: ModelConfig) -> ModelConfig:
    profiles, active_id = list_profiles(with_keys=False)
    if not active_id:
        return fallback
    profile = next(p for p in profiles if p["id"] == active_id)
    return ModelConfig(
        provider=profile["provider"],
        base_url=profile["base_url"],
        model=profile["model"],
        api_key=load_model_api_key(active_id),
        api_key_env="",
        models=[profile["model"]],
    )
