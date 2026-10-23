"""壁纸存储：文件进 ~/.openterminal/wallpapers，元数据与状态进 SQLite。

背景：旧版把媒体放 IndexedDB、状态放 localStorage，两者都是浏览器私有的——
换个浏览器就没了（真机踩过：上传的 MP4 换浏览器即消失）。这里钉住新契约：
**浏览器侧零持久化**，数据只认服务端。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from openterminal.config import Config
from openterminal.wallpapers import (
    WallpaperError, WallpaperNotFound, add_wallpaper, delete_wallpaper,
    get_state, list_wallpapers, media_path, set_state, wallpapers_dir,
)
from openterminal.web.server import create_app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64


def _client(monkeypatch) -> TestClient:
    import openterminal.web.server as web_server

    class FakeWorker:
        tab_id = "fake-tab"

        def __init__(self, cfg, target):
            pass

        async def close(self):
            pass

    monkeypatch.setattr(web_server, "TabWorker", FakeWorker)
    return TestClient(create_app(Config.load()))


# --- 存哪：服务端，不在浏览器 ---

def test_media_lands_on_disk_not_in_the_browser():
    """核心契约：换个浏览器/清站点数据都不该丢——数据在应用目录里。"""
    saved = add_wallpaper("我的背景.png", PNG, filename="我的背景.png", thumb=PNG)
    on_disk = wallpapers_dir() / saved["url"].rsplit("/", 1)[-1]
    assert on_disk.is_file(), "媒体文件必须落在 ~/.openterminal/wallpapers"
    assert on_disk.stat().st_size == len(PNG)
    # 列表是从服务端读出来的，与任何浏览器状态无关
    assert [w["id"] for w in list_wallpapers()] == [saved["id"]]


def test_thumb_is_stored_alongside_media():
    saved = add_wallpaper("a.png", PNG, filename="a.png", thumb=PNG)
    thumb = wallpapers_dir() / saved["thumb_url"].rsplit("/", 1)[-1]
    assert thumb.is_file()
    assert thumb.name != (wallpapers_dir() / saved["url"].rsplit("/", 1)[-1]).name


def test_urls_are_served_from_the_static_mount():
    saved = add_wallpaper("a.mp4", MP4, filename="a.mp4")
    assert saved["url"].startswith("/wallpapers/")
    assert saved["kind"] == "video"


def test_delete_removes_row_and_files():
    saved = add_wallpaper("gone.png", PNG, filename="gone.png", thumb=PNG)
    media = media_path(saved["id"])
    delete_wallpaper(saved["id"])
    assert not media.exists(), "删了就得把文件也清掉，别留孤儿"
    assert list_wallpapers() == []
    with pytest.raises(WallpaperNotFound):
        media_path(saved["id"])


# --- 校验 ---

def test_kind_is_inferred_from_extension():
    assert add_wallpaper("a.png", PNG, filename="a.png")["kind"] == "image"
    assert add_wallpaper("a.webm", MP4, filename="a.webm")["kind"] == "video"
    with pytest.raises(WallpaperError, match="只支持"):
        add_wallpaper("a.txt", b"x", filename="a.txt")


def test_size_limit_differs_for_image_and_video():
    with pytest.raises(WallpaperError, match="图片不能超过"):
        add_wallpaper("big.png", b"\x00" * (13 * 1024 * 1024), filename="big.png")
    assert add_wallpaper("big.mp4", MP4, filename="big.mp4")["kind"] == "video"


def test_empty_upload_rejected():
    with pytest.raises(WallpaperError, match="为空"):
        add_wallpaper("a.png", b"", filename="a.png")


# --- 结构化状态 ---

def test_state_defaults_and_partial_update():
    state = get_state()
    assert state["wallpaper"] == "aurora"
    assert state["custom"] is False

    set_state({"wallpaper": "ocean", "custom": True, "image": "abc",
               "options": {"fit": "cover", "opacity": 55}})
    state = get_state()
    assert state["wallpaper"] == "ocean"
    assert state["custom"] is True
    assert state["image"] == "abc"
    assert state["options"]["opacity"] == 55

    # 只给一个字段时其余保持原样
    set_state({"video_paused": True})
    state = get_state()
    assert state["wallpaper"] == "ocean", "没给的字段不该被抹掉"
    assert state["video_paused"] is True


def test_state_survives_a_new_connection():
    """状态在 SQLite 里——重开连接就该还在，这正是「换浏览器还在」的前提。"""
    set_state({"wallpaper": "nebula", "custom": True, "image": "xyz"})
    assert get_state()["wallpaper"] == "nebula"


# --- REST + 静态路由 ---

def test_api_roundtrip_and_static_serving(monkeypatch):
    client = _client(monkeypatch)
    files = {"file": ("bg.png", PNG, "image/png")}
    created = client.post("/api/wallpapers", files=files, data={"name": "bg.png"})
    assert created.status_code == 200
    saved = created.json()

    listed = client.get("/api/wallpapers").json()
    assert [w["id"] for w in listed["wallpapers"]] == [saved["id"]]

    # 静态路由真能取到字节
    body = client.get(saved["url"])
    assert body.status_code == 200
    assert body.content == PNG

    # Range 请求：视频拖进度条靠它，206 + Content-Range
    rng = client.get(saved["url"], headers={"Range": "bytes=0-9"})
    assert rng.status_code == 206
    assert rng.content == PNG[:10]
    assert rng.headers["content-range"].startswith("bytes 0-9/")

    state = client.put("/api/wallpapers/state", json={"custom": True,
                                                      "image": saved["id"]})
    assert state.status_code == 200
    assert state.json()["image"] == saved["id"]

    assert client.delete(f"/api/wallpapers/{saved['id']}").status_code == 200
    assert client.get(saved["url"]).status_code == 404


def test_api_rejects_bad_upload(monkeypatch):
    client = _client(monkeypatch)
    bad = client.post("/api/wallpapers",
                      files={"file": ("x.txt", b"hi", "text/plain")})
    assert bad.status_code == 400
    assert client.delete("/api/wallpapers/nope").status_code == 404
