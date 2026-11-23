"""WebSocket 消息协议：dataclass + 序列化（纯函数，可单测）。

单管线契约（设计文档 §5）：
- 客户端 → 服务端：JSON 文本（控制）或二进制帧（键盘字节直发）。
- 服务端 → 客户端：JSON 文本（控制/卡片事件）或二进制帧（PTY 字节直写主
  xterm，唯一显示管线）。
"""

from __future__ import annotations

import base64
import json
import re

from ..core import ClientMsg, ServerMsg  # noqa: F401 —— 再导出（旧 import 路径继续可用）

_IMAGE_URL_RE = re.compile(
    r"data:(image/png|image/jpeg|image/webp);base64,([A-Za-z0-9+/]+={0,2})\Z")
_MAX_IMAGE_COUNT = 4
_MAX_IMAGE_BYTES = 4 * 1024 * 1024
_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024


def parse_client(frame: bytes | str) -> ClientMsg:
    """客户端帧 → ClientMsg。二进制帧视为 raw 键盘字节（直发 PTY）。"""
    if isinstance(frame, (bytes, bytearray)):
        return ClientMsg(type="raw", data=bytes(frame))
    obj = json.loads(frame)
    return ClientMsg(
        type=obj.get("type", ""),
        text=obj.get("text", ""),
        decision=obj.get("decision"),
        auth_kind=obj.get("auth_kind", ""),
        remember=bool(obj.get("remember", False)),
        model=obj.get("model", ""),
        cols=obj.get("cols", 0),
        rows=obj.get("rows", 0),
        pad=obj.get("pad", 0),
        mirror=obj.get("mirror"),
        dirty=bool(obj.get("dirty", False)),
        accept=bool(obj.get("accept", False)),
        images=obj.get("images"),
    )


def validate_image_data_urls(images: object) -> list[str]:
    """Validate image_submit data URLs before forwarding them to a model."""
    if not isinstance(images, list) or not 1 <= len(images) <= _MAX_IMAGE_COUNT:
        raise ValueError(f"图片数量需为 1 至 {_MAX_IMAGE_COUNT} 张")

    total_bytes = 0
    validated = []
    signatures = {
        "image/png": lambda data: data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": lambda data: data.startswith(b"\xff\xd8\xff"),
        "image/webp": lambda data: (len(data) >= 12 and data[:4] == b"RIFF"
                                    and data[8:12] == b"WEBP"),
    }
    for image in images:
        if not isinstance(image, str):
            raise ValueError("图片数据格式无效")
        match = _IMAGE_URL_RE.fullmatch(image)
        if match is None:
            raise ValueError("仅支持 PNG、JPG 和 WebP 图片")
        mime, encoded = match.groups()
        if len(encoded) > ((_MAX_IMAGE_BYTES + 2) // 3) * 4:
            raise ValueError("单张图片不能超过 4 MB")
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise ValueError("图片 Base64 数据无效") from exc
        if not data or len(data) > _MAX_IMAGE_BYTES:
            raise ValueError("单张图片不能超过 4 MB")
        if not signatures[mime](data):
            raise ValueError("图片内容与文件格式不匹配")
        total_bytes += len(data)
        if total_bytes > _MAX_TOTAL_IMAGE_BYTES:
            raise ValueError("图片总大小不能超过 8 MB")
        validated.append(image)
    return validated


def encode_server(msg: ServerMsg) -> str:
    """序列化 ServerMsg；None/空串/0 字段一并省略，消息保持紧凑。"""
    return json.dumps(
        {k: v for k, v in msg.__dict__.items() if v not in (None, "", 0)},
        ensure_ascii=False)
