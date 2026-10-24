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
import os
import shutil
import string
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .config import app_dir

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_VIDEO_BYTES = 100 * 1024 * 1024
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
# 保存位置不在上面那串里：它不是「哪张背景」的状态，而是存储配置
DIR_KEY = "wallpapers-dir"


class WallpaperError(ValueError):
    """业务校验失败（HTTP 400）。"""


class WallpaperNotFound(LookupError):
    """壁纸不存在（HTTP 404）。"""


def _example_dir() -> str:
    """校验提示里的示例路径，跟着平台走——别在 macOS 上举 D: 的例子。"""
    if os.name == "nt":
        return "D:/media/wallpapers"
    return os.path.join(os.path.expanduser("~"), "Media", "wallpapers")


def _fs_roots() -> list[str]:
    """选择器的根位置：POSIX 只有一个 ``/``，Windows 要把盘符都列出来。"""
    if os.name != "nt":
        return [str(Path(os.sep))]
    return [f"{d}:{os.sep}" for d in string.ascii_uppercase if os.path.exists(f"{d}:{os.sep}")]


def _same_dir(a: Path, b: Path) -> bool:
    """两个路径是不是同一个目录。

    ``normcase`` 只在 Windows 折叠大小写，macOS 的 APFS 默认是大小写**不**敏感
    的——同一目录两种拼法会被当成两个，白触发一次迁移。``samefile`` 让操作系统
    自己判（认大小写敏感性、符号链接、8.3 短名），两个平台都对。
    """
    if _norm(a) == _norm(b):
        return True
    try:
        return a.is_dir() and b.is_dir() and os.path.samefile(a, b)
    except OSError:
        return False


def _absolute(path: Path) -> Path:
    """回显/落库用的绝对路径：``~`` 与环境变量先展开，再补成绝对路径。

    设置里存过 ``~/.openterminal/wallpapers`` 这类写法时，``dir_info`` 也得
    回显真实路径——前端拿它当输入框的值，透传 ``~`` 出去就等于显示假路径。
    """
    return Path(os.path.abspath(os.path.expandvars(os.path.expanduser(str(path)))))


def default_wallpapers_dir() -> Path:
    """默认保存位置：``~/.openterminal/wallpapers``。"""
    return _absolute(app_dir() / "wallpapers")


def _norm(path: Path) -> str:
    """比较用的归一化形式（Windows 下盘符大小写不该被当成两个目录）。"""
    return os.path.normcase(os.path.normpath(str(path)))


def _configured_dir() -> Path:
    """用户设置的保存位置；没设就用默认目录。"""
    conn = _connection()
    try:
        row = conn.execute(
            "SELECT value FROM wallpaper_state WHERE key=?", (DIR_KEY,)).fetchone()
    finally:
        conn.close()
    value = (row["value"] if row else "").strip()
    return _absolute(Path(value)) if value else default_wallpapers_dir()


def wallpapers_dir() -> Path:
    """媒体根目录：跟着设置里的保存位置走。

    拿不到配置的目录就退回默认目录，而不是抛错——盘符被拔掉时不该连设置页
    都打不开，媒体 404 就够了。
    """
    for candidate in (_configured_dir(), default_wallpapers_dir()):
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError:
            continue
    return default_wallpapers_dir()


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


# --------------------------------------------------------------------------
# 保存位置：默认 ~/.openterminal/wallpapers，用户可自定义
# --------------------------------------------------------------------------

def dir_info() -> dict:
    configured = _configured_dir()
    default = default_wallpapers_dir()
    return {
        "dir": str(_absolute(configured)),
        "dir_default": str(default),
        "dir_custom": not _same_dir(configured, default),
        "dir_example": _example_dir(),
    }


def set_wallpapers_dir(raw: str) -> dict:
    """改保存位置。

    先把已有媒体搬到新目录再落库：元数据里只存文件名，根目录一换不搬文件，
    已有的背景就全成孤儿。搬不动就整体回滚，路径保持原样。
    """
    if not isinstance(raw, str):
        raise WallpaperError("保存位置必须是文本")
    target = _resolve_dir(raw)
    current = _configured_dir()
    if not _same_dir(target, current):
        _migrate_media(current, target)
        conn = _connection()
        try:
            conn.execute(
                "INSERT INTO wallpaper_state(key, value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (DIR_KEY, str(target)),
            )
            conn.commit()
        finally:
            conn.close()
    return dir_info()


def _resolve_dir(raw: str) -> Path:
    text = raw.strip()
    if not text:
        return default_wallpapers_dir()   # 空串 = 恢复默认
    expanded = Path(os.path.expandvars(os.path.expanduser(text)))
    if not expanded.is_absolute():
        raise WallpaperError(f"保存位置必须是绝对路径，例如 {_example_dir()}")
    path = _absolute(expanded)
    if path.exists() and not path.is_dir():
        raise WallpaperError("保存位置必须是目录")
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise WallpaperError(f"无法使用该目录：{exc}") from exc
    return path


# 选文件夹要弹**资源管理器那个样子**的现代框：IFileDialog + FOS_PICKFOLDERS
# （左侧导航树 + 地址栏面包屑 + 名称/修改日期/类型/大小），不是老式纯树形框。
# C# 经 Add-Type 编译调 COM；实测编译约 120ms、PowerShell 启动约 230ms，可接受。
# 加载不了就退回 WinForms 的经典框，至少还能选目录。
_PS_CSHARP = r"""
using System;
using System.Runtime.InteropServices;

namespace OtDirPick
{
    public static class Picker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
        private class DialogRCW { }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid,
                [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            void Compare(IShellItem psi, uint hint, out int piOrder);
        }

        [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr hwndParent);
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint pfos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
            void AddPlace(IShellItem psi, int fdap);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
            void Close(int hr);
            void SetClientGuid([MarshalAs(UnmanagedType.LPStruct)] Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr pFilter);
            void GetResults(out IntPtr ppenum);
            void GetSelectedItems(out IntPtr ppsai);
        }

        [DllImport("kernel32.dll")] private static extern ushort GetUserDefaultUILanguage();
        [DllImport("kernel32.dll")] private static extern ushort SetThreadUILanguage(ushort langid);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr pbc,
            ref Guid riid, out IShellItem item);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowW(string cls, string title);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool SetWindowTextW(IntPtr hWnd, string text);
        [DllImport("user32.dll")]
        private static extern IntPtr GetDlgItem(IntPtr hDlg, int id);

        // FOS_NOVALIDATE | FOS_PATHMUSTEXIST | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
        private const uint Options = 0x100 | 0x800 | 0x20 | 0x40000;
        private const uint FileSysPath = 0x80058000;

        public static string OkLabel = "Select Folder";
        public static string NameLabel = "Folder:";
        public static string CancelLabel = "Cancel";

        public static void SetLabels(string ok, string name, string cancel)
        {
            if (!String.IsNullOrEmpty(ok)) OkLabel = ok;
            if (!String.IsNullOrEmpty(name)) NameLabel = name;
            if (!String.IsNullOrEmpty(cancel)) CancelLabel = cancel;
        }

        // IFileDialog 只给了 OK 按钮与「文件夹」标签的 setter，取消按钮没有；而这
        // 个进程里底部那条会退回英文资源（实测线程 UI 语言明明是 0x0804）。起个
        // 后台线程按**自己设的标题**认出窗口，把取消按钮文案改掉。
        private static void RelabelCancel(string title, string text)
        {
            for (int i = 0; i < 400; i++)
            {
                IntPtr hwnd = FindWindowW(null, title);
                if (hwnd != IntPtr.Zero)
                {
                    IntPtr btn = GetDlgItem(hwnd, 2);   // IDCANCEL
                    if (btn != IntPtr.Zero) { SetWindowTextW(btn, text); return; }
                }
                System.Threading.Thread.Sleep(50);
            }
        }

        public static string Pick(string start, string title)
        {
            SetThreadUILanguage(GetUserDefaultUILanguage());
            var dlg = (IFileOpenDialog)new DialogRCW();
            try
            {
                dlg.SetOptions(Options);
                if (!String.IsNullOrEmpty(title)) dlg.SetTitle(title);
                dlg.SetOkButtonLabel(OkLabel);
                dlg.SetFileNameLabel(NameLabel);
                if (!String.IsNullOrEmpty(title))
                {
                    var t = new System.Threading.Thread(() => RelabelCancel(title, CancelLabel));
                    t.IsBackground = true;
                    t.Start();
                }
                if (!String.IsNullOrEmpty(start))
                {
                    Guid iid = typeof(IShellItem).GUID;
                    IShellItem item;
                    if (SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out item) == 0)
                        dlg.SetFolder(item);
                }
                if (dlg.Show(IntPtr.Zero) != 0) return null;
                IShellItem picked;
                dlg.GetResult(out picked);
                string p;
                picked.GetDisplayName(FileSysPath, out p);
                return p;
            }
            finally { Marshal.ReleaseComObject(dlg); }
        }
    }
}
"""

# 退出码：0 选中 / 3 用户取消 / 1 弹不出来。三者必须分开——取消不该再折腾界面，
# 弹不出来才是前端该接手的时候。
_PS_PICK = r"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$state = ""
$out = ""

try {
  if (-not ("OtDirPick.Picker" -as [type])) {
    Add-Type -TypeDefinition @'
{CSCODE}
'@
  }
  [OtDirPick.Picker]::SetLabels($env:OT_PICK_OK, $env:OT_PICK_NAME, $env:OT_PICK_CANCEL)
  $r = [OtDirPick.Picker]::Pick($env:OT_PICK_DIR_START, $env:OT_PICK_DIR_PROMPT)
  if ($null -eq $r) { $state = "cancelled" } else { $state = "picked"; $out = $r }
} catch {
  $state = ""
}

if ($state -eq "") {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = $env:OT_PICK_DIR_PROMPT
    $d.ShowNewFolderButton = $true
    if ($env:OT_PICK_DIR_START) { $d.SelectedPath = $env:OT_PICK_DIR_START }
    if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      $state = "picked"; $out = $d.SelectedPath
    } else {
      $state = "cancelled"
    }
  } catch {
    $state = "unavailable"
  }
}

if ($state -eq "picked") { [Console]::Out.Write($out); exit 0 }
if ($state -eq "cancelled") { exit 3 }
exit 1
"""
_PS_PICK = _PS_PICK.replace("{CSCODE}", _PS_CSHARP.strip())

_OSASCRIPT_PICK = 'POSIX path of (choose folder with prompt (system attribute "OT_PICK_DIR_PROMPT"))'

_PICK_PROMPTS = {
    "zh": "选择壁纸的保存位置",
    "en": "Choose where to save wallpapers",
}

# 底部按钮/标签：这个进程里资源会退回英文，一律显式钉成界面语言
_PICK_LABELS = {
    "zh": ("选择文件夹", "文件夹:", "取消"),
    "en": ("Select Folder", "Folder:", "Cancel"),
}

_PICK_CANCELLED = 3


def pick_dir_native(start: Path | None = None, lang: str = "zh",
                    timeout: float = 180.0) -> tuple[str, str]:
    """弹**系统**的文件夹选择框，返回 ``(结果, 路径)``。

    结果是 ``"picked"`` / ``"cancelled"`` / ``"unavailable"``。

    浏览器给不了真实路径（``webkitdirectory`` / File System Access 都只交句柄），
    所以只能由**服务端**——它就跑在用户这台机器上——去开原生对话框。桌面不在
    （SSH、容器、会话隔离、没装 zenity）时进程会立刻失败或一直挂着，一律超时
    兜回 ``unavailable``。

    三条都不能少：超时杀进程、区分「用户取消」与「弹不出来」、路径按 UTF-8 解。
    """
    prompt = _PICK_PROMPTS.get(lang, _PICK_PROMPTS["zh"])
    ok_label, name_label, cancel_label = _PICK_LABELS.get(lang, _PICK_LABELS["zh"])
    env = os.environ.copy()
    env["OT_PICK_DIR_PROMPT"] = prompt
    env["OT_PICK_OK"] = ok_label
    env["OT_PICK_NAME"] = name_label
    env["OT_PICK_CANCEL"] = cancel_label
    if start is not None:
        env["OT_PICK_DIR_START"] = str(start)

    if os.name == "nt":
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", _PS_PICK]
    elif sys.platform == "darwin":
        cmd = ["osascript", "-e", _OSASCRIPT_PICK]
    else:
        picker = next((p for p in ("zenity", "kdialog", "yad") if shutil.which(p)), None)
        if not picker:
            return "unavailable", ""
        cmd = ([picker, "--file-selection", "--directory",
                "--title", prompt] if picker == "zenity"
               else [picker, "--getexistingdirectory", str(start or Path.home())])

    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)   # 别闪一个控制台
    try:
        proc = subprocess.run(
            cmd, env=env, capture_output=True, timeout=timeout,
            creationflags=flags, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable", ""        # 弹不出来 / 用户晾着对话框不管
    except Exception:
        return "unavailable", ""

    if proc.returncode == _PICK_CANCELLED:
        return "cancelled", ""
    if proc.returncode != 0:
        return "unavailable", ""
    text = (proc.stdout or b"").decode("utf-8", errors="replace").strip()
    if not text:
        return "cancelled", ""          # macOS 取消也是非零，这里兜住空输出
    chosen = _absolute(Path(text))
    return "picked", str(chosen)


def _migrate_media(old: Path, target: Path) -> int:
    conn = _connection()
    try:
        rows = conn.execute("SELECT file, thumb FROM wallpapers").fetchall()
    finally:
        conn.close()
    names = dict.fromkeys(
        name for row in rows for name in (row["file"], row["thumb"]) if name)

    moved: list[tuple[Path, Path]] = []
    try:
        for name in names:
            src, dst = old / name, target / name
            if not src.is_file() or dst.is_file():
                continue   # 源不在（本来就丢了）或目标已有：都不动
            shutil.move(str(src), str(dst))
            moved.append((src, dst))
    except OSError as exc:
        for src, dst in reversed(moved):
            try:
                shutil.move(str(dst), str(src))
            except OSError:
                pass
        raise WallpaperError(f"已有背景迁移失败：{exc}") from exc
    try:
        old.rmdir()   # 搬空了顺手收掉；非空目录不动
    except OSError:
        pass
    return len(moved)
