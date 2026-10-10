"""目标系统画像：发行版/包管理器/服务管理器/可用工具。"""

from __future__ import annotations

import os
import sys
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path

_DEBIAN_LIKE = {"debian", "ubuntu", "raspbian", "linuxmint", "pop"}
_RHEL_LIKE = {"centos", "rhel", "fedora", "rocky", "almalinux", "ol", "amzn"}


@dataclass
class SysFacts:
    os_id: str
    version_id: str
    pretty_name: str
    uname_s: str
    kernel: str
    shell: str
    available: list[str] = field(default_factory=list)


@dataclass
class SystemProfile:
    host: str
    os_family: str
    distro: str
    version: str
    kernel: str
    pkg_manager: str
    service_mgr: str
    shell: str
    tools: dict[str, str] = field(default_factory=dict)


# 本地目标的画像：不跑探针（POSIX 探针语句在 PowerShell 下无哨兵输出，
# 会挂满超时），直接用平台常量。CLI 与 Web worker 共用。
if sys.platform == "win32":
    LOCAL_PROFILE = SystemProfile(
        host="local",
        os_family="windows", distro="Windows", version="", kernel="",
        pkg_manager="winget", service_mgr="sc", shell="powershell",
        tools={},
    )
else:
    LOCAL_PROFILE = SystemProfile(
        host="local",
        os_family="darwin" if sys.platform == "darwin" else "linux",
        distro="Local", version="", kernel="",
        pkg_manager="brew" if sys.platform == "darwin" else "apt",
        service_mgr="launchd" if sys.platform == "darwin" else "systemd",
        shell=os.environ.get("SHELL", "/bin/bash"), tools={},
    )


def profile_from_facts(host: str, f: SysFacts) -> SystemProfile:
    avail = set(f.available)
    if f.uname_s == "Darwin":
        family, pkg, svc = "darwin", "brew", "launchd"
    elif f.os_id in _DEBIAN_LIKE:
        family, pkg, svc = "debian", "apt", "systemd"
    elif f.os_id in _RHEL_LIKE:
        family = "rhel"
        # RHEL8+/Fedora/Rocky/Alma 默认 dnf；CentOS 7 只有 yum
        pkg = "dnf" if "dnf" in avail else ("yum" if "yum" in avail else "dnf")
        if f.os_id == "centos" and f.version_id.startswith("7"):
            pkg = "yum"
        svc = "systemd"
    elif f.os_id == "alpine":
        family, pkg, svc = "alpine", "apk", "openrc"
    elif f.os_id in {"arch", "manjaro"}:
        family, pkg, svc = "arch", "pacman", "systemd"
    elif "suse" in f.os_id:
        family, pkg, svc = "suse", "zypper", "systemd"
    else:
        family, pkg, svc = "unknown", "yum" if "yum" in avail else "apt", "systemd"

    tools: dict[str, str] = {}
    for t in ("python3", "python", "docker", "node", "git", "make"):
        if t in avail:
            tools[t] = "yes"
    return SystemProfile(
        host=host, os_family=family,
        distro=f.pretty_name or f.os_id, version=f.version_id,
        kernel=f.kernel, pkg_manager=pkg, service_mgr=svc,
        shell=f.shell, tools=tools,
    )


MANUAL_PRESETS: dict[str, dict] = {
    "ubuntu": {"os_family": "debian", "pkg_manager": "apt", "service_mgr": "systemd"},
    "debian": {"os_family": "debian", "pkg_manager": "apt", "service_mgr": "systemd"},
    "centos7": {"os_family": "rhel", "pkg_manager": "yum", "service_mgr": "systemd"},
    "rocky9": {"os_family": "rhel", "pkg_manager": "dnf", "service_mgr": "systemd"},
    "alpine": {"os_family": "alpine", "pkg_manager": "apk", "service_mgr": "openrc"},
    "arch": {"os_family": "arch", "pkg_manager": "pacman", "service_mgr": "systemd"},
    "macos": {"os_family": "darwin", "pkg_manager": "brew", "service_mgr": "launchd"},
}


_PROBE_STATEMENTS = [
    "[ -r /etc/os-release ] && . /etc/os-release || true",
    "printf '%s\\n' \"${ID:-}\" \"${VERSION_ID:-}\" \"${PRETTY_NAME:-}\"",
    "uname -s",
    "uname -r",
    "printf '%s\\n' \"${SHELL:-}\"",
    "for c in apt-get dnf yum apk pacman zypper brew systemctl docker python3 "
    "python node git make; do command -v \"$c\" >/dev/null 2>&1 && echo \"$c\"; done",
    "printf '%s\\n' \"__OT_PROBE_DONE__\"",
]


async def probe_profile(session, host: str) -> SystemProfile:
    """在会话上执行探测命令并解析为 SystemProfile。"""
    # 必须用 '; ' 连接：每条都是完整语句，拼成单行（不能用空格，否则上一条
    # 会把下一条当成自己的参数，整句语法错误导致哨兵不打印、run 超时）。
    res = await session.run("; ".join(_PROBE_STATEMENTS))
    lines = [l.strip() for l in res.output.splitlines()]
    if "__OT_PROBE_DONE__" in lines:
        lines = lines[: lines.index("__OT_PROBE_DONE__")]
    # 字段：os_id / version / pretty / uname_s / kernel / shell / tools...
    def get(i: int) -> str:
        return lines[i] if i < len(lines) else ""
    facts = SysFacts(
        os_id=get(0), version_id=get(1), pretty_name=get(2),
        uname_s=get(3), kernel=get(4), shell=get(5),
        available=lines[6:],
    )
    if facts.uname_s == "":
        facts.uname_s = "Linux"
    return profile_from_facts(host, facts)


def _toml_escape(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"')


def save_host_cache(path: Path, host: str, p: SystemProfile) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    block = ["\n[hosts.{}]".format(host.replace(".", "_")),
             f'host = "{_toml_escape(host)}"']
    for k, v in asdict(p).items():
        # host 已显式写入；tools 不进缓存（均跳过，避免 TOML 键重复）
        if k in ("tools", "host"):
            continue
        block.append(f'{k} = "{_toml_escape(str(v))}"')
    block.append("")
    with path.open("a", encoding="utf-8") as f:
        f.write("\n".join(block))


def load_host_cache(path: Path) -> dict[str, SystemProfile]:
    if not path.exists():
        return {}
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    out: dict[str, SystemProfile] = {}
    for _table, m in data.get("hosts", {}).items():
        host = m.get("host", _table)
        out[host] = SystemProfile(host=host, tools={}, **{k: v for k, v in m.items()
                                                          if k != "host"})
    return out
