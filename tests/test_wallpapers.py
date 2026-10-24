"""壁纸存储：文件进 ~/.openterminal/wallpapers，元数据与状态进 SQLite。

背景：旧版把媒体放 IndexedDB、状态放 localStorage，两者都是浏览器私有的——
换个浏览器就没了（真机踩过：上传的 MP4 换浏览器即消失）。这里钉住新契约：
**浏览器侧零持久化**，数据只认服务端。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from openterminal.config import Config
from openterminal.wallpapers import (
    MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, WallpaperError, WallpaperNotFound,
    add_wallpaper, delete_wallpaper, dir_info, get_state, list_wallpapers,
    media_path, set_state, set_wallpapers_dir, wallpapers_dir,
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


def test_video_size_limit_is_100mb():
    """视频上限 100 MB（含 MP4）——明确的契约值，别被无意改回 64。

    超限要在落盘**之前**就拒掉，否则删不掉的半截文件会留在 wallpapers 目录。
    """
    assert MAX_VIDEO_BYTES == 100 * 1024 * 1024
    with pytest.raises(WallpaperError, match="视频不能超过 100 MB"):
        add_wallpaper("big.mp4", bytes(MAX_VIDEO_BYTES + 1), filename="big.mp4")
    # 正文很小的 MP4 照旧放行：上限不是「必须够大」而是「不许更大」
    assert add_wallpaper("edge.mp4", MP4, filename="edge.mp4")["kind"] == "video"


def test_frontend_wallpaper_limits_match_backend():
    """前后端各写了一份上限常量（settings.js / wallpapers.py）。

    只改一边就会出现「前端拦下的后端本来收」或反过来的状态，用户看到的
    报错数字也和真实上限对不上。这里钉住两边一致。
    """
    import re
    from pathlib import Path

    import openterminal

    js = (Path(openterminal.__file__).parent / "web" / "frontend" / "static"
          / "settings.js").read_text(encoding="utf-8")
    pattern = "const (WALLPAPER_(?:IMAGE|VIDEO)_MAX_BYTES) = ([0-9]+) [*] 1024 [*] 1024;"
    got = {name: int(mb) * 1024 * 1024 for name, mb in re.findall(pattern, js)}
    assert got == {"WALLPAPER_IMAGE_MAX_BYTES": MAX_IMAGE_BYTES,
                   "WALLPAPER_VIDEO_MAX_BYTES": MAX_VIDEO_BYTES}


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

# --- 保存位置：跨平台 + 文件夹选择器 ---


@pytest.fixture()
def isolated_home(tmp_path, monkeypatch):
    """壁纸元数据进 SQLite，键在 app_dir() 下——换 HOME 就是干净的一套。"""
    monkeypatch.setenv("OPENTERMINAL_HOME", str(tmp_path))
    return tmp_path


def test_dir_info_echoes_a_real_path_even_for_tilde_form(isolated_home):
    """库里存过 `~/.openterminal/wallpapers` 这类写法也得回显**真实**路径。

    前端拿 dir 当输入框的值，透传 `~` 出去等于显示假路径——`~` 是 shell 的
    写法不是路径，macOS 与 Windows 一样。这正是「回显真实路径，哪怕是默认
    路径」的要求。
    """
    from openterminal import wallpapers as w

    conn = w._connection()
    conn.execute(
        "INSERT INTO wallpaper_state(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (w.DIR_KEY, "~/.openterminal/wallpapers"))
    conn.commit()
    conn.close()

    info = dir_info()
    assert "~" not in info["dir"], f"回显不能带 shell 简写: {info['dir']}"
    assert Path(info["dir"]).is_absolute(), info["dir"]
    # `~` 要展开成真实家目录下的路径——判据不依赖那个目录碰巧存不存在
    assert Path(info["dir"]) == Path.home() / ".openterminal" / "wallpapers"


def test_dir_info_always_echoes_the_default_path_too(isolated_home):
    """没自定义时也要给出默认的绝对路径，前端才不用自己猜。"""
    info = dir_info()
    for key in ("dir", "dir_default", "dir_example"):
        assert info[key], f"{key} 不能为空"
        assert "~" not in info[key], info[key]
    assert not info["dir_custom"]
    assert Path(info["dir_default"]).is_absolute(), info["dir_default"]
    assert wallpapers_dir() == Path(info["dir_default"]), "真用的就是报出来的默认目录"


def test_example_dir_matches_the_platform(isolated_home):
    """报错提示里的示例路径要跟平台一致——别在 macOS 上举 D: 的例子。"""
    example = dir_info()["dir_example"]
    assert not example.startswith("~"), example
    if os.name == "nt":
        assert ":" in example, f"Windows 示例该带盘符: {example}"
    else:
        assert example.startswith("/"), f"POSIX 示例该是绝对路径: {example}"
        assert ":" not in example, f"POSIX 示例不该出现盘符: {example}"


def test_bad_path_rejected_with_a_platform_example(isolated_home):
    with pytest.raises(WallpaperError) as exc:
        set_wallpapers_dir("relative/path")
    assert dir_info()["dir_example"] in str(exc.value), str(exc.value)


def test_same_dir_ignores_purely_case_differences(isolated_home):
    """同一目录的大小写变体不是「自定义」，不该白触发一次迁移。

    APFS（macOS 默认）大小写不敏感，而 ``normcase`` 在 POSIX 不折叠大小写
    ——单靠 normcase 会把 ``~/Media`` 与 ``~/media`` 当成两个目录。
    """
    default = dir_info()["dir_default"]
    Path(default).mkdir(parents=True, exist_ok=True)
    set_wallpapers_dir(str(default))          # 先落到默认
    assert not dir_info()["dir_custom"]

    set_wallpapers_dir(str(default).swapcase())
    assert not dir_info()["dir_custom"], "同一目录的不同大小写拼法不是自定义"
    assert not dir_info()["dir_custom"]


def test_same_dir_treats_one_dir_by_two_routes_as_one(isolated_home):
    """符号链接（Windows 上是连接点）指向同一目录：``normcase`` 认不出，``samefile`` 认得出。"""
    from openterminal import wallpapers as w

    real = isolated_home / "real"
    real.mkdir()
    link = isolated_home / "link"
    try:
        os.symlink(real, link, target_is_directory=True)
    except (OSError, NotImplementedError, ValueError):
        pytest.skip("本机不允许建目录符号链接")

    assert w._same_dir(real, link), "同一目录的两条路线应当判为同一个"


# --- 「浏览…」先走系统对话框 ---


def _fake_run(monkeypatch, *, returncode=0, stdout=b"", side_effect=None):
    """把 subprocess.run 换成假的：真弹框会卡住 CI，也会打扰用户桌面。"""
    import subprocess
    seen = {}

    def run(cmd, **kw):
        seen["cmd"] = cmd
        seen["kw"] = kw
        if side_effect:
            raise side_effect
        return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr=b"")

    monkeypatch.setattr(subprocess, "run", run)
    return seen


def test_pick_dir_native_returns_the_chosen_path(isolated_home, monkeypatch):
    from openterminal import wallpapers as w

    chosen = isolated_home / "picked-wallpapers"
    _fake_run(monkeypatch, stdout=str(chosen).encode("utf-8"))
    result, path = w.pick_dir_native()
    assert result == "picked"
    assert Path(path) == chosen, path
    assert Path(path).is_absolute()


def test_pick_dir_native_tells_cancel_from_unavailable(isolated_home, monkeypatch):
    """取消是「用户不要」，弹不出来是「换退路」——两者前端处理不同，不能混。"""
    from openterminal import wallpapers as w

    _fake_run(monkeypatch, returncode=3)
    assert w.pick_dir_native()[0] == "cancelled"

    _fake_run(monkeypatch, returncode=1)
    assert w.pick_dir_native()[0] == "unavailable"

    _fake_run(monkeypatch, side_effect=OSError("no gui"))
    assert w.pick_dir_native()[0] == "unavailable"


def test_pick_dir_native_survives_a_hung_dialog(isolated_home, monkeypatch):
    """桌面不在时对话框可能一直挂着：超时必须兜回来，别把请求吊死。"""
    import subprocess
    from openterminal import wallpapers as w

    _fake_run(monkeypatch, side_effect=subprocess.TimeoutExpired("powershell", 1))
    assert w.pick_dir_native(timeout=0.1)[0] == "unavailable"


def test_pick_dir_native_never_puts_the_path_on_the_command_line(isolated_home,
                                                                monkeypatch):
    """路径带中文/空格时拼进命令行会被引号转义咬掉，一律走环境变量。"""
    from openterminal import wallpapers as w

    start = isolated_home / "中 文 带空格" / "wallpapers"
    seen = _fake_run(monkeypatch, stdout=str(start).encode("utf-8"))
    w.pick_dir_native(start=start, lang="zh")

    assert str(start) not in " ".join(seen["cmd"]), "路径不得进命令行"
    env = seen["kw"]["env"]
    assert env["OT_PICK_DIR_START"] == str(start)
    assert env["OT_PICK_DIR_PROMPT"], "提示语必须传下去"
    assert seen["kw"]["timeout"] > 0, "必须带超时"
    if os.name == "nt":
        assert seen["kw"].get("creationflags"), "Windows 下别闪控制台窗口"


def test_pick_dir_native_prompt_follows_the_ui_language(isolated_home, monkeypatch):
    from openterminal import wallpapers as w

    zh = _fake_run(monkeypatch, stdout=b"")
    w.pick_dir_native(lang="zh")
    en = _fake_run(monkeypatch, stdout=b"")
    w.pick_dir_native(lang="en")
    assert zh["kw"]["env"]["OT_PICK_DIR_PROMPT"] == "选择壁纸的保存位置"
    assert en["kw"]["env"]["OT_PICK_DIR_PROMPT"] == "Choose where to save wallpapers"


def test_pick_dir_native_command_is_platform_shaped(isolated_home, monkeypatch):
    """Windows 走 PowerShell、macOS 走 osascript——换平台不至于发错指令。"""
    from openterminal import wallpapers as w

    seen = _fake_run(monkeypatch, stdout=b"")
    w.pick_dir_native()
    cmd = [str(c) for c in seen["cmd"]]
    if os.name == "nt":
        assert any("powershell" in c.lower() for c in cmd), cmd
    elif sys.platform == "darwin":
        assert "osascript" in cmd, cmd
    else:
        assert any(c in ("zenity", "kdialog", "yad") for c in cmd), cmd


def test_picker_is_the_modern_explorer_dialog():
    """要弹资源管理器那种框：IFileDialog + FOS_PICKFOLDERS，不是老式纯树形框。

    用户明确要的就是左侧导航树 + 地址栏 + 名称/修改日期/类型/大小四栏那个窗口，
    退回 WinForms 的 FolderBrowserDialog 只当加载不了时的兜底。
    """
    from openterminal import wallpapers as w

    cs = w._PS_CSHARP
    assert "IFileOpenDialog" in cs, "必须走 IFileDialog"
    assert "FOS_PICKFOLDERS" in cs or "0x20" in cs, "必须带 FOS_PICKFOLDERS"
    assert "SHCreateItemFromParsingName" in cs, "要能定到起始目录"
    # 兜底仍在，但只在现代框抛异常时才走
    assert "FolderBrowserDialog" in w._PS_PICK
    assert w._PS_PICK.index("OtDirPick.Picker") < w._PS_PICK.index("FolderBrowserDialog")


def test_picker_labels_are_chinese_in_chinese_ui():
    """这进程里对话框底部会退回英文资源，标签必须显式钉成界面语言。"""
    from openterminal import wallpapers as w

    ok, name, cancel = w._PICK_LABELS["zh"]
    assert (ok, name, cancel) == ("选择文件夹", "文件夹:", "取消")
    assert w._PICK_PROMPTS["zh"] == "选择壁纸的保存位置"
    # 英文界面也得给英文，别拿中文糊弄
    assert w._PICK_LABELS["en"][0] == "Select Folder"
    assert w._PICK_PROMPTS["en"] != w._PICK_PROMPTS["zh"]


def test_pick_dir_native_hands_labels_to_the_dialog(isolated_home, monkeypatch):
    from openterminal import wallpapers as w

    seen = _fake_run(monkeypatch, stdout=b"")
    w.pick_dir_native(lang="zh")
    env = seen["kw"]["env"]
    assert env["OT_PICK_OK"] == "选择文件夹"
    assert env["OT_PICK_NAME"] == "文件夹:"
    assert env["OT_PICK_CANCEL"] == "取消"


def test_pick_endpoint_reports_result_to_the_frontend(monkeypatch, isolated_home):
    from openterminal import wallpapers as w

    client = _client(monkeypatch)

    monkeypatch.setattr(w, "pick_dir_native", lambda *a, **k: ("picked", "/data/wp"))
    body = client.post("/api/wallpapers/dir/pick", params={"lang": "en"}).json()
    assert body == {"ok": True, "result": "picked", "path": "/data/wp"}

    monkeypatch.setattr(w, "pick_dir_native", lambda *a, **k: ("cancelled", ""))
    body = client.post("/api/wallpapers/dir/pick").json()
    assert body["ok"] is False and body["result"] == "cancelled"

    monkeypatch.setattr(w, "pick_dir_native", lambda *a, **k: ("unavailable", ""))
    body = client.post("/api/wallpapers/dir/pick").json()
    assert body["ok"] is False and body["result"] == "unavailable"

def test_wallpaper_dir_ui_is_just_the_path_and_browse():
    """UI 契约：保存位置只有「路径 + 浏览…」——没有保存按钮、没有弹框、没有文字。

    选完自动落库；系统对话框弹不出来就把光标交给输入框手填，不再叠自带选择器。
    """
    import re

    import openterminal

    front = Path(openterminal.__file__).parent / "web" / "frontend"
    html = (front / "index.html").read_text(encoding="utf-8")
    js = (front / "static" / "settings.js").read_text(encoding="utf-8")

    assert 'id="btn-wallpaper-dir-browse"' in html
    assert "btn-wallpaper-dir-reset" not in html, "恢复默认按钮应当已移除"
    assert "btn-wallpaper-dir-save" not in html, "保存按钮应当已移除——选完自动存"
    assert "wallpaper-dir-status" not in html, "不要状态文字"
    assert "openWallpaperDirPicker" not in js, "不要自带弹框"
    assert "modalShell" not in js.split("chooseWallpaperDir")[1][:2000],         "选文件夹这条路上不该再开模态框"
    assert "chooseWallpaperDir" in js and "dir/pick" in js
    assert "input.addEventListener(\"change\", save)" in js, "手填路径改完即存"
    # 占位符不得写死某一家的路径写法：示例路径由服务端按平台给
    assert not re.search(r'placeholder="[^"]*D:', html), "占位符别写死 Windows 路径"
    assert "dir_example" in js
