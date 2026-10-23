"""壁纸媒体与元数据：文件落 ``~/.openterminal/wallpapers``，元数据落 SQLite。

为什么不在浏览器里存：IndexedDB / localStorage 都是**浏览器私有**的，换个
浏览器、换个配置、清一次站点数据就全没了（真机踩过：上传的 MP4 换浏览器
就消失）。这里改成「文件进应用目录 + 结构化字段进 connections.db」，浏览器
只负责加载，不持久化任何壁纸数据。

分两层是刻意的：
- **媒体文件**（原图/视频 + 缩略图）放文件系统——大对象进 SQLite 既撑库又
  没法流式读；挂成静态路由后 Range 请求免费拿到，视频拖进度条才流畅。
- **结构化数据**（哪张在用、铺放方式/透明度/亮度/是否静音）进 SQLite——
  和 model_profiles、skill_state、mcp_servers 同一个库，一处备份全带走。
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from .config import app_dir

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_VIDEO_BYTES = 64 * 1024 * 1024
IMAGE_KINDS = {"png": "image", "jpg": "image", "jpeg": "image", "webp": "image"}
VIDEO_KINDS = {"mp4": "video", "webm": "video"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS wallpapers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  thumb TEXT,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  added_at REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wallpaper_state(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

# 结构化状态的键（与前端原有 ot-wallpaper-* 一一对应，去掉前缀）
STATE_KEYS = ("wallpaper", "wallpaper-custom", "wallpaper-image",
              "wallpaper-options", "wallpaper-video-paused")


class WallpaperError(ValueError):
    """业务校验失败（HTTP 400）。"""


class WallpaperNotFound(LookupError):
    """壁纸不存在（HTTP 404）。"""


def wallpapers_dir() -> Path:
    d = app_dir() / "wallpapers"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _connection():
    from .connections.db import connect

    conn = connect()
    conn.executescript(_SCHEMA)
    return conn


# --------------------------------------------------------------------------
# 媒体文件
# --------------------------------------------------------------------------

def _kind_for(filename: str) -> str:
    ext = Path(filename or "").suffix.lower().lstrip(".")
    if ext in IMAGE_KINDS:
        return IMAGE_KINDS[ext]
    if ext in VIDEO_KINDS:
        return VIDEO_KINDS[ext]
    raise WallpaperError("只支持 PNG / JPEG / WebP 图片，或 MP4 / WebM 视频")


def _ext_for(filename: str) -> str:
    ext = Path(filename or "").suffix.lower().lstrip(".")
    return ext if ext else "bin"


# --------------------------------------------------------------------------
# 增删
# --------------------------------------------------------------------------

def add_wallpaper(name: str, media: bytes, *, filename: str = "",
                  thumb: bytes | None = None) -> dict:
    """落一张自定义背景：先写文件再写元数据，免得库里留孤儿行。"""
    kind = _kind_for(filename or name)
    limit = MAX_VIDEO_BYTES if kind == "video" else MAX_IMAGE_BYTES
    if not media:
        raise WallpaperError("上传内容为空")
    if len(media) > limit:
        raise WallpaperError(
            f"{'视频' if kind == 'video' else '图片'}不能超过 {limit // (1024 * 1024)} MB")

    wallpaper_id = uuid.uuid4().hex[:12]
    ext = _ext_for(filename or name)
    media_name = f"{wallpaper_id}.{ext}"
    thumb_name = f"{wallpaper_id}-thumb.webp" if thumb else None

    root = wallpapers_dir()
    (root / media_name).write_bytes(media)
    if thumb:
        (root / thumb_name).write_bytes(thumb)

    conn = _connection()
    try:
        conn.execute(
            "INSERT INTO wallpapers(id, name, file, thumb, kind, size, added_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (wallpaper_id, (name or media_name).strip() or media_name,
             media_name, thumb_name, kind, len(media), time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    return get_wallpaper(wallpaper_id)


def delete_wallpaper(wallpaper_id: str) -> dict:
    row = _fetch(wallpaper_id)
    root = wallpapers_dir()
    for name in (row["file"], row["thumb"]):
        if name:
            (root / name).unlink(missing_ok=True)
    conn = _connection()
    try:
        conn.execute("DELETE FROM wallpapers WHERE id=?", (wallpaper_id,))
        conn.commit()
    finally:
        conn.close()
    return {"deleted": True, "id": wallpaper_id}


def _fetch(wallpaper_id: str):
    conn = _connection()
    try:
        row = conn.execute(
            "SELECT * FROM wallpapers WHERE id=?", (wallpaper_id,)).fetchone()
    finally:
        conn.close()
    if row is None:
        raise WallpaperNotFound("背景不存在")
    return row


def _to_dict(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "size": row["size"],
        "added_at": row["added_at"],
        "url": f"/wallpapers/{row['file']}",
        # 没缩略图就直接用媒体本身（图片便宜；视频靠浏览器取首帧）
        "thumb_url": f"/wallpapers/{row['thumb'] or row['file']}",
    }


def get_wallpaper(wallpaper_id: str) -> dict:
    return _to_dict(_fetch(wallpaper_id))


def list_wallpapers() -> list[dict]:
    conn = _connection()
    try:
        rows = conn.execute(
            "SELECT * FROM wallpapers ORDER BY added_at DESC").fetchall()
    finally:
        conn.close()
    return [_to_dict(row) for row in rows]


def media_path(wallpaper_id: str, *, thumb: bool = False) -> Path:
    row = _fetch(wallpaper_id)
    name = (row["thumb"] or row["file"]) if thumb else row["file"]
    path = wallpapers_dir() / name
    if not path.is_file():
        raise WallpaperNotFound("背景文件不见了")
    return path


# --------------------------------------------------------------------------
# 结构化状态：哪张在用 + 铺放参数
# --------------------------------------------------------------------------

def get_state() -> dict:
    conn = _connection()
    try:
        rows = conn.execute("SELECT key, value FROM wallpaper_state").fetchall()
    finally:
        conn.close()
    raw = {row["key"]: row["value"] for row in rows}
    options = {}
    try:
        options = json.loads(raw.get("wallpaper-options") or "{}")
    except ValueError:
        options = {}
    return {
        "wallpaper": raw.get("wallpaper") or "aurora",
        "custom": raw.get("wallpaper-custom") == "true",
        "image": raw.get("wallpaper-image") or "",
        "options": options if isinstance(options, dict) else {},
        "video_paused": raw.get("wallpaper-video-paused") == "true",
    }


def set_state(patch: dict) -> dict:
    """只写给到的字段；没给的保持原样。"""
    if not isinstance(patch, dict):
        raise WallpaperError("状态必须是对象")
    values: dict[str, str] = {}
    if "wallpaper" in patch:
        values["wallpaper"] = str(patch["wallpaper"] or "aurora")
    if "custom" in patch:
        values["wallpaper-custom"] = "true" if patch["custom"] else "false"
    if "image" in patch:
        values["wallpaper-image"] = str(patch["image"] or "")
    if "options" in patch:
        options = patch["options"] or {}
        if not isinstance(options, dict):
            raise WallpaperError("options 必须是对象")
        values["wallpaper-options"] = json.dumps(options, ensure_ascii=False)
    if "video_paused" in patch:
        values["wallpaper-video-paused"] = "true" if patch["video_paused"] else "false"

    conn = _connection()
    try:
        for key, value in values.items():
            conn.execute(
                "INSERT INTO wallpaper_state(key, value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
        conn.commit()
    finally:
        conn.close()
    return get_state()
