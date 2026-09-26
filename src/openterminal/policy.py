"""命令分级：auto（只读自动）/ approve（高危审批）/ deny（灾难拒绝）。"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass
from typing import Literal

Level = Literal["auto", "approve", "deny"]

_SEP_RE = re.compile(r"&&|\|\||;|\|")
_SUBST_RE = re.compile(r"\$\((.*?)\)|`([^`]*)`", re.S)
_REDIRECT_RE = re.compile(r">>?\s*([^\s;|&><]+)")
_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

_READ_VERBS = frozenset({
    "ls", "cat", "pwd", "echo", "ps", "head", "tail", "grep", "find", "df", "du",
    "free", "uptime", "whoami", "command", "which", "wc", "sort", "uniq", "diff",
    "stat", "date", "env", "printenv", "uname", "hostname", "id", "realpath",
    "basename", "dirname", "md5sum", "sha256sum", "file", "type", "lsblk",
    "lscpu", "free", "ip", "ifconfig", "netstat", "ss", "lsof", "journalctl",
    # PowerShell 只读 cmdlet（Windows 目标）：不列则本地任务步步进审批
    "Get-Location", "Get-ChildItem", "Get-Content", "Get-Item",
    "Get-ItemProperty", "Get-Process", "Get-Service", "Get-Date",
    "Get-TimeZone", "Get-Command", "Get-Help", "Get-Member", "Get-Alias",
    "Get-Variable", "Get-History", "Get-PSDrive", "Get-PSProvider",
    "Get-ComputerInfo", "Get-NetIPAddress", "Get-NetAdapter", "Get-NetRoute",
    "Test-Path", "Select-String", "Select-Object", "Where-Object", "Sort-Object",
    "Measure-Object", "Format-Table", "Format-List", "Format-Wide",
    "Out-String", "Out-Host", "Write-Output", "Write-Host", "group",
    "Measure-Command", "Compare-Object", "dir", "tree", "attrib",
})
_GIT_READ = frozenset({
    "status", "log", "diff", "show", "branch", "remote", "rev-parse", "blame",
    "ls-files", "describe", "shortlog", "whatchanged",
})
# ip 的修改型子命令：出现即视为改动网络配置（show 类仍自动）
_IP_MUTATE = frozenset({
    "add", "del", "delete", "set", "flush", "replace", "change", "append",
})
# 删除/改动文件类命令：进审批面板时展示明确风险理由
_DELETE_REASON = {
    "rm": "删除文件", "rmdir": "删除目录", "unlink": "删除文件/链接",
    "shred": "不可恢复地删除文件",
}
# docker 只读子命令：纯查看容器/镜像/网络/卷状态
_DOCKER_READ = frozenset({
    "ps", "images", "inspect", "logs", "events", "port", "top", "stats",
    "version", "info", "diff", "history", "search", "wait", "list", "ls", "df",
})
# docker 的对象管理组：第二个词决定读写（ls/inspect 查看，create/rm 改动）
_DOCKER_GROUPS = frozenset({
    "container", "image", "network", "volume", "system", "node", "service",
    "stack", "secret", "config",
})
_ROOTISH = {"/", "/*", "~", "~/*", "$HOME", "$HOME/*"}
_DEVICE_RE = re.compile(r"^/dev/(sd|nvme|vd|disk)")
_BOOT_RE = re.compile(r"^/(boot|EFI)(/|$)")
_FORBIDDEN_VERBS = frozenset({"shutdown", "halt", "poweroff", "reboot"})


@dataclass
class Decision:
    level: Level
    reasons: list[str]


def _normalize(cmd: str) -> str:
    return re.sub(r"\s+", " ", cmd.strip())


def _drop_assignments(tokens: list[str]) -> list[str]:
    while tokens and _ASSIGN_RE.match(tokens[0]):
        tokens = tokens[1:]
    return tokens


def _classify_segment(seg: str) -> Decision:
    """对单条（无连接符）命令分级。"""
    reasons: list[str] = []

    # 重定向目标检查（可能 deny）
    for target in _REDIRECT_RE.findall(seg):
        if _DEVICE_RE.match(target) or _BOOT_RE.match(target):
            return Decision("deny", [f"重定向写入危险目标 {target}"])
        if target not in _ROOTISH:
            reasons.append("重定向覆盖文件")

    try:
        tokens = shlex.split(seg, posix=True)
    except ValueError:
        return Decision("approve", ["命令语法无法静态解析"])
    tokens = _drop_assignments(tokens)
    if not tokens:
        return Decision("auto", [])

    verb = os.path.basename(tokens[0])
    args = tokens[1:]
    joined = " ".join(args)

    # sudo：先看内部命令是否灾难，否则提权审批
    if verb == "sudo":
        inner = _classify_segment(" ".join(args))
        if inner.level == "deny":
            return inner
        return Decision("approve", ["sudo 提权执行"] + inner.reasons)

    # deny 规则
    if verb == "rm":
        flags = "".join(a for a in args if a.startswith("-") and not a.startswith("--"))
        recursive = "r" in flags or "R" in flags
        if recursive and any(a in _ROOTISH for a in args):
            return Decision("deny", ["递归删除根/家目录"])
    if verb.startswith("mkfs"):
        return Decision("deny", ["格式化文件系统"])
    if verb == "dd":
        if any(re.match(r"of=/dev/(sd|nvme|vd|disk)", a) for a in args):
            return Decision("deny", ["dd 直写块设备"])
    if ":(){" in seg.replace(" ", ""):
        return Decision("deny", ["fork 炸弹"])
    if verb in _FORBIDDEN_VERBS or (verb == "init" and "0" in args):
        return Decision("deny", ["关机/重启会中断远程会话"])
    if verb == "chmod" and any(a in tokens for a in ("-R", "-r")):
        if "777" in args and any(a in _ROOTISH for a in args):
            return Decision("deny", ["对根目录递归 777 授权"])

    # auto 规则
    if verb == "git":
        sub = args[0] if args else ""
        if sub in _GIT_READ:
            return Decision("auto", [])
        if sub == "config":
            # 读取（无参/--list/只给键名）自动；键值成对或带写入型 flag 即写配置
            rest = [a for a in args[1:] if not a.startswith("-")]
            write_flags = {"--unset", "--unset-all", "--add", "--replace-all",
                           "--edit"}
            if write_flags & set(args) or len(rest) >= 2:
                return Decision("approve", ["git config 写入配置"])
            return Decision("auto", [])
        return Decision("approve", ["git 写操作"])
    if verb == "find":
        if "-delete" in args or "-exec" in args:
            return Decision("approve", ["find 带删除/执行动作"])
        return Decision("auto", [])
    if verb == "env":
        rest = _drop_assignments(args)
        if not rest:
            return Decision("auto", [])
        return _classify_segment(" ".join(rest))
    if verb in ("docker", "podman"):
        # 查看（ps/logs/inspect/…）自动；run/exec/rm/stop 等改动容器
        # 环境的操作审批；exec 内嵌命令无法静态判定，保守审批
        sub = args[0] if args else ""
        rest = args[1:]
        if sub in _DOCKER_GROUPS:
            obj = rest[0] if rest else ""
            if obj in _DOCKER_READ or obj == "show":
                return Decision("auto", [])
            return Decision("approve", [f"{verb} {sub} 改动容器环境"])
        if sub == "compose":
            action = rest[0] if rest else ""
            # compose config 是查看/校验编排文件，与 docker config 对象组无关
            if action in _DOCKER_READ or action == "config":
                return Decision("auto", [])
            return Decision("approve", [f"{verb} compose 操作容器环境"])
        if sub in _DOCKER_READ:
            return Decision("auto", [])
        if not sub:
            return Decision("approve", [f"{verb} 缺少子命令，无法判定"])
        return Decision("approve", [f"{verb} {sub} 操作容器环境"])
    if verb == "ip" and args:
        # ip 的 show/查询自动；出现修改型子命令（add/del/set/…）即审批
        if any(a in _IP_MUTATE for a in args):
            return Decision("approve", ["ip 修改网络配置"])
        return Decision("auto", [])
    if verb == "ifconfig":
        # 无参/只给接口名 = 查看；更多参数 = 配置网卡
        if len(args) <= 1:
            return Decision("auto", [])
        return Decision("approve", ["ifconfig 配置网卡"])
    if verb == "hostname" and args:
        return Decision("approve", ["修改主机名"])
    if verb == "date" and any(a in ("-s", "--set") or a.startswith("-s")
                              for a in args):
        return Decision("approve", ["设置系统时间"])
    if verb in _READ_VERBS and not reasons:
        return Decision("auto", [])
    if verb in _DELETE_REASON:
        reasons.append(_DELETE_REASON[verb])

    # 兜底：无法判定一律审批
    if not reasons:
        reasons.append("非只读命令或无法判定")
    return Decision("approve", reasons)


class Policy:
    def __init__(
        self,
        *,
        mode: str = "tiered",
        auto_extra: list[str] | None = None,
        approve_extra: list[str] | None = None,
        deny_extra: list[str] | None = None,
    ) -> None:
        self.mode = mode
        self.auto_extra = {_normalize(c) for c in (auto_extra or [])}
        self.approve_extra = {_normalize(c) for c in (approve_extra or [])}
        self.deny_extra = {_normalize(c) for c in (deny_extra or [])}

    def _segments(self, command: str) -> list[str]:
        segs = [s.strip() for s in _SEP_RE.split(command) if s.strip()]
        for m in _SUBST_RE.finditer(command):
            inner = m.group(1) or m.group(2)
            if inner.strip():
                segs.append(inner.strip())
        return segs or [command]

    def classify(self, command: str) -> Decision:
        norm = _normalize(command)
        if norm in self.deny_extra:
            return Decision("deny", ["用户 deny_extra 规则"])
        if norm in self.auto_extra:
            return Decision("auto", [])
        if norm in self.approve_extra:
            return Decision("approve", ["用户 approve_extra 规则"])

        if self.mode == "deny-all":
            return Decision("deny", ["策略模式 deny-all"])
        if self.mode == "approve-all":
            return Decision("approve", ["策略模式 approve-all"])

        worst: Decision = Decision("auto", [])
        order = {"auto": 0, "approve": 1, "deny": 2}
        for seg in self._segments(norm):
            d = _classify_segment(seg)
            if order[d.level] > order[worst.level]:
                worst = d
        return worst
