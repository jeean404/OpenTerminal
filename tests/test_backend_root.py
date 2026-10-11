"""文件根语义回归：真机「write_file ×失败」（2026-10-11）。

根因两层：
1. PtyShellBackend.aexecute 把命令回报的 cwd（SSH 远端 `/tmp`）直接灌进
   `self.cwd`——Windows 上 `Path("/tmp")` 是无盘符路径，`_resolve_path` 里
   `resolve()` 得到 `M:\\tmp\\...`、`relative_to(self.cwd)` 却以 `\\tmp` 为锚，
   于是每个文件工具都报「outside root directory: \\tmp」；
2. 文件根本就不该取远端 shell 的 cwd：那会把「下载到本机」写进本机的影子目录。

本文件跨平台跑（Windows/POSIX），不依赖 PTY。
"""

import sys
from pathlib import Path

from openterminal.agent.backend import PtyShellBackend
from openterminal.session.base import CommandResult


class _Sess:
    """鸭子类型 ShellSession：cwd 可换，run 回报另一个 cwd。"""

    def __init__(self, cwd: str, run_cwd: str | None = None):
        self.cwd = cwd
        self._run_cwd = run_cwd if run_cwd is not None else cwd

    async def run(self, command, *, timeout=None, on_output=None):
        return CommandResult(output="ok", exit_code=0, truncated=False,
                             cwd=self._run_cwd)


def test_remote_target_ignores_remote_cwd(tmp_path):
    """远端目标：session.cwd 是远端路径，文件根回退到用户主目录。"""
    b = PtyShellBackend(_Sess("/tmp", "/tmp"), remote_target=True)
    assert b.cwd == Path.home()


def test_local_cwd_becomes_root_when_it_is_a_real_local_dir(tmp_path):
    b = PtyShellBackend(_Sess(str(tmp_path)))
    assert b.cwd == tmp_path.resolve()


def test_non_local_cwd_falls_back_to_home():
    """本机不存在的目录（远端路径在本机的典型形态）不当根。"""
    b = PtyShellBackend(_Sess("/no/such/dir/ot-test"))
    assert b.cwd == Path.home()


async def test_file_tools_survive_execute_reporting_remote_cwd(tmp_path):
    """回归主用例：execute 回报远端 cwd 后，write_file/read_file 仍可用。

    修复前 self.cwd 被灌成 `Path('/tmp')`，写入报
    `outside root directory: \\tmp`（截图里的工具卡 ×失败）。
    """
    b = PtyShellBackend(_Sess(str(tmp_path), "/tmp"), root_dir=str(tmp_path))
    await b.aexecute("pwd")
    assert b.cwd == tmp_path.resolve(), "文件根不得随 execute 回报的 cwd 漂移"

    w = b.write("/smoke_print.sh", "#!/bin/bash\necho opentrimnal\n")
    assert w.error is None, w.error
    assert w.path == "/smoke_print.sh"
    assert (tmp_path / "smoke_print.sh").read_text(encoding="utf-8").startswith("#!/bin/bash")

    r = b.read("/smoke_print.sh")
    assert r.error is None
    assert "opentrimnal" in (r.file_data or {}).get("content", "")


def test_virtual_paths_land_under_root(tmp_path):
    """/Downloads/<名> 落在根目录下的 Downloads——「下载到本机」的落点。"""
    b = PtyShellBackend(_Sess(str(tmp_path)), root_dir=str(tmp_path))
    w = b.write("/Downloads/smoke_print.sh", "hi")
    assert w.error is None, w.error
    assert (tmp_path / "Downloads" / "smoke_print.sh").read_text(encoding="utf-8") == "hi"


def test_explicit_root_dir_is_honoured(tmp_path):
    b = PtyShellBackend(_Sess("/tmp"), root_dir=str(tmp_path))
    assert b.cwd == tmp_path.resolve()


def test_outside_root_still_returns_error_result(tmp_path):
    """越界路径仍包成 error 结果，不外抛（docs/bug.md 上传场景不变量）。"""
    b = PtyShellBackend(_Sess(str(tmp_path)), root_dir=str(tmp_path))
    r = b.write("/C:/Users/Administrator/Desktop/1.txt", "hi")
    assert r.error and r.path is None


def test_drive_letter_paths_cannot_escape_root(tmp_path):
    """/C:/... 过得了 deepagents 的 validate_path，拼接却会换锚跳出根目录。

    根落在 C: 盘（远端目标回退到主目录）时，这等于把「下载到本机」变成
    「写到 C: 盘任意位置」——实测能列真实桌面。必须同口径判越界。
    """
    b = PtyShellBackend(_Sess(str(tmp_path)), root_dir=str(tmp_path))
    for key in ("/C:/Users/Administrator/Desktop/1.txt",
                "C:\\Users\\Administrator\\Desktop\\1.txt",
                "\\\\?\\C:\\Users\\Administrator\\1.txt"):
        r = b.write(key, "hi")
        assert r.error and "outside root" in r.error, key
        assert r.path is None
