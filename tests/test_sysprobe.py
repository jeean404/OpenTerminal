from openterminal.sysprobe import SysFacts, profile_from_facts, MANUAL_PRESETS


def facts(id_="ubuntu", version="22.04", pretty="Ubuntu 22.04 LTS",
          uname_s="Linux", kernel="5.15.0", shell="/bin/bash", avail=None):
    return SysFacts(id_, version, pretty, uname_s, kernel, shell,
                    avail or ["apt-get", "systemctl", "python3"])


def test_ubuntu():
    p = profile_from_facts("h", facts())
    assert (p.os_family, p.pkg_manager, p.service_mgr) == ("debian", "apt", "systemd")


def test_centos7_uses_yum():
    f = facts("centos", "7", "CentOS Linux 7", avail=["yum", "systemctl"])
    p = profile_from_facts("h", f)
    assert (p.os_family, p.pkg_manager) == ("rhel", "yum")


def test_rocky9_uses_dnf():
    f = facts("rocky", "9.2", avail=["dnf", "yum", "systemctl"])
    p = profile_from_facts("h", f)
    assert (p.os_family, p.pkg_manager) == ("rhel", "dnf")


def test_alpine():
    f = facts("alpine", "3.19", avail=["apk"], shell="/bin/ash")
    p = profile_from_facts("h", f)
    assert (p.os_family, p.pkg_manager, p.service_mgr) == ("alpine", "apk", "openrc")


def test_macos():
    f = facts("macos", "14", "macOS 14", uname_s="Darwin", kernel="23.0",
              avail=["brew"])
    p = profile_from_facts("mbp", f)
    assert (p.os_family, p.pkg_manager, p.service_mgr) == ("darwin", "brew", "launchd")
    assert p.host == "mbp"


def test_arch_and_suse():
    p = profile_from_facts("h", facts("arch", avail=["pacman", "systemctl"]))
    assert (p.os_family, p.pkg_manager) == ("arch", "pacman")
    p2 = profile_from_facts("h", facts("opensuse-leap", avail=["zypper", "systemctl"]))
    assert p2.os_family == "suse" and p2.pkg_manager == "zypper"


def test_manual_presets_complete():
    for name in ("ubuntu", "debian", "centos7", "rocky9", "alpine", "arch", "macos"):
        m = MANUAL_PRESETS[name]
        assert {"os_family", "pkg_manager", "service_mgr"} <= set(m)


def test_host_cache_roundtrip(tmp_path):
    from openterminal.sysprobe import load_host_cache, save_host_cache
    p = profile_from_facts("prod-web", facts())
    path = tmp_path / "hosts.toml"
    save_host_cache(path, "prod-web", p)
    loaded = load_host_cache(path)
    assert "prod-web" in loaded
    assert loaded["prod-web"].pkg_manager == "apt"
    assert loaded["prod-web"].host == "prod-web"


def test_probe_command_is_valid_posix():
    # 多行压平为单行时必须以 ';' 分隔（回归：空格连接会让语句粘连，
    # 整句语法错误导致哨兵不打印、run 超时 120s）。
    import subprocess
    import sys

    import pytest

    from openterminal.sysprobe import _PROBE_STATEMENTS

    if sys.platform == "win32":
        pytest.skip("POSIX shell 语法检查")
    cmd = "; ".join(_PROBE_STATEMENTS)
    r = subprocess.run(["/bin/sh", "-c", cmd], capture_output=True, timeout=10)
    assert "__OT_PROBE_DONE__" in r.stdout.decode()


def test_probe_profile_parses_fake_session():
    import asyncio

    from openterminal.shell_session import CommandResult
    from openterminal.sysprobe import probe_profile

    class FakeSession:
        def __init__(self):
            self.sent = ""

        async def run(self, command, **kwargs):
            self.sent = command
            out = "\n".join([
                "", "", "",            # os-release 三字段（macOS 为空）
                "Darwin", "24.6.0", "/bin/zsh",
                "brew", "python3", "git", "__OT_PROBE_DONE__",
            ])
            return CommandResult(output=out, exit_code=0, truncated=False, cwd="/tmp")

    async def scenario():
        fs = FakeSession()
        p = await probe_profile(fs, "local")
        return fs, p

    fs, p = asyncio.run(scenario())
    assert "\n" not in fs.sent                      # 单行
    assert "done; " in fs.sent                      # for 循环与后续语句正确分隔
    assert p.os_family == "darwin" and p.pkg_manager == "brew"
    assert p.kernel == "24.6.0" and p.shell == "/bin/zsh"
