"""壁纸 REST 面：`/api/wallpapers*`。媒体本体走 `/wallpapers/*` 静态路由。

上传走 multipart 而不是 JSON+base64：视频最大 64 MB，base64 会白涨三分之一，
而且多一层编码纯属浪费。authFetch 见到 FormData 不再强塞 Content-Type
（让浏览器自己带 boundary）。
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from .. import wallpapers


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, wallpapers.WallpaperNotFound):
        return HTTPException(404, str(exc))
    if isinstance(exc, wallpapers.WallpaperError):
        return HTTPException(400, str(exc))
    return HTTPException(500, f"背景操作失败：{exc}")


async def _io(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except (wallpapers.WallpaperError, wallpapers.WallpaperNotFound) as exc:
        raise _http(exc) from exc
    except OSError as exc:
        raise HTTPException(500, f"磁盘操作失败：{exc}") from exc


def make_wallpapers_router(check_token) -> APIRouter:
    router = APIRouter(prefix="/api/wallpapers")

    @router.get("")
    async def list_wallpapers(request: Request):
        check_token(request.headers)
        return {
            "wallpapers": await _io(wallpapers.list_wallpapers),
            "state": await _io(wallpapers.get_state),
        }

    @router.post("")
    async def add_wallpaper(
        request: Request,
        file: UploadFile = File(...),
        name: str = Form(""),
        thumb: UploadFile | None = File(None),
    ):
        check_token(request.headers)
        media = await file.read()
        thumb_bytes = await thumb.read() if thumb is not None else None
        return await _io(
            wallpapers.add_wallpaper, name, media,
            filename=file.filename or name, thumb=thumb_bytes,
        )

    @router.delete("/{wallpaper_id}")
    async def delete_wallpaper(request: Request, wallpaper_id: str):
        check_token(request.headers)
        return await _io(wallpapers.delete_wallpaper, wallpaper_id)

    @router.put("/state")
    async def set_state(request: Request, payload: dict):
        check_token(request.headers)
        return await _io(wallpapers.set_state, payload)

    return router
