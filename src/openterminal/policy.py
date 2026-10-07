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
# 黑洞目标：重定向进这些只是丢弃流，一个文件都不碰。
# 不放行的话 PowerShell 的 `2>$null`（真机上模型查 docker 服务的惯用写法）
# 会被判「重定向覆盖文件」，整条只读查询顶成待审批、任务合法挂起，
# 页面停在「AI 正在思考」（bug2 的卡死点，见 b2-round1.png 审批卡）。
# 大小写不敏感：PowerShell/Windows 的 $null、NUL 都吃。
_NULL_SINKS = frozenset({"/dev/null", "$null", "null", "nul"})
# Windows 目标上模型调命令常带可执行后缀：where.exe / docker.exe / net.exe。
# 不归一就落不进对应的只读/子命令表，一律兜底审批。
_EXE_SUFFIX_RE = re.compile(r"\.(?:exe|com|cmd|bat|ps1)$", re.I)
# 控制流词：真命令在 (...) 条件与 {...} 块体里，裸看首词只会兜底审批。
_CTRL_VERBS = frozenset({
    "if", "while", "foreach", "for", "switch", "else", "elseif", "try", "trap",
    "foreach-object",   # PowerShell 的 ForEach { … } 走同一条块体重判
})
# 条件/块体里的非命令片段：裸字面量、变量读取、成员读取（`ForEach { $_.Name }`）。
# 判成命令就把整段兜底成审批——真机 `Get-Service *docker* | ForEach { $_.Name }`
# 就是这么被顶成待审批的。
_LITERAL_PIECE_RE = re.compile(
    r"^(?:\d+|\$?true|\$?false|\$(?:_|[A-Za-z][\w]*)(?:\.[\w]+)*)$", re.I)
_PIECE_RE = re.compile(r"\(([^()]*)\)|\{([^{}]*)\}", re.S)
_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

_READ_VERBS = frozenset({
    "ls", "cat", "pwd", "echo", "ps", "head", "tail", "grep", "find", "df", "du",
    "free", "uptime", "whoami", "command", "which", "where", "wc", "sort", "uniq", "diff",
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
    "Out-String", "Out-Host", "Out-Null", "Write-Output", "Write-Host", "group",
    "Measure-Command", "Compare-Object", "dir", "tree", "attrib",
    # 短别名（系统提示词「PowerShell 优先短别名（Sort/Select/Where）」）：
    # 不收进来的话模型听话用了别名，只读查询照样落兜底审批。
    # ForEach/% 不在此列：它们是块体执行器，走 _CTRL_VERBS 逐段重判。
    "Select", "Where", "Measure", "ft", "fl", "fw", "sls",
    "gi", "gci", "gc", "gps", "gsv", "gcm", "gdr", "gmo", "gv", "rvpa",
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
    "help",
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
# 只读查询型首选项：只打印列表/状态/版本/用法，不改动状态。
# 不放行的话，模型探测 `wsl -l -v` / `docker --version` 会把整条「查看容器」
# 顶成待审批，任务合法挂起、页面停在「AI 正在思考」（真机 bug2 的卡死点）。
# 用法见 _classify_segment：只在「首项是查询旗标 且 后面全是选项」时放行，
# 带目标/负载的（`umount -l /mnt`、`rm -l file`）落回逐词判定。
_READ_VERBS_L = frozenset(v.lower() for v in _READ_VERBS)
_QUERY_LEAD = frozenset({
    "-l", "--list", "--status", "--info", "--show", "--print", "--dump",
    "-V", "--version", "-h", "--help", "help", "--usage", "-?",
})


def _docker_action(word: str) -> str:
    """docker 子命令/对象动作的旗标写法归一：-v/--version → version。

    `docker --version`、`docker container --help` 这类查询被落进改动分支，
    整条命令就进审批了。"""
    return {
        "-v": "version", "--version": "version",
        "-h": "help", "--help": "help",
    }.get(word, word)


_ORDER = {"auto": 0, "approve": 1, "deny": 2}


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


# 重定向词：`>`、`>>`、`2>file`、`&>`、`2>&1` 这些都不是命令参数。
# 目标文件已在 _classify_segment 的 _REDIRECT_RE 里审过，这里只管从词表里
# 剥掉尾巴，否则 `wsl -l -v 2>NUL` 的 `2>NUL` 顶掉「全是选项」的放行。
_REDIR_TOKEN_RE = re.compile(r"^(?:\d+|&)?>>?")


def _drop_redirects(tokens: list[str]) -> list[str]:
    return [t for t in tokens if not _REDIR_TOKEN_RE.match(t)]


def _classify_segment(seg: str) -> Decision:
    """对单条（无连接符）命令分级。"""
    reasons: list[str] = []

    # 重定向目标检查（可能 deny）。黑洞目标直接跳过：丢弃流既不 deny
    # 也不算「覆盖文件」，否则只读命令被自己的 2>$null 顶成待审批。
    for target in _REDIRECT_RE.findall(seg):
        if target.lower() in _NULL_SINKS:
            continue
        if _DEVICE_RE.match(target) or _BOOT_RE.match(target):
            return Decision("deny", [f"重定向写入危险目标 {target}"])
        if target not in _ROOTISH:
            reasons.append("重定向覆盖文件")

    try:
        tokens = shlex.split(seg, posix=True)
    except ValueError:
        return Decision("approve", ["命令语法无法静态解析"])
    tokens = _drop_redirects(_drop_assignments(tokens))
    if not tokens:
        return Decision("auto", [])

    verb = _EXE_SUFFIX_RE.sub("", os.path.basename(tokens[0]))
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

    # 控制流：取括号条件 + 花括号块体逐段重判，取最严。条件/块体都空才落回
    # 兜底（`for x in a b; do ...; done` 这种无括号写法维持原判定）。
    if verb.lower() in _CTRL_VERBS:
        raw = [q.strip() for a, b in _PIECE_RE.findall(seg)
               for q in (a, b) if q.strip()]
        if raw and not any(not _LITERAL_PIECE_RE.match(q) for q in raw):
            # 条件/块体全是字面量与成员读取（`ForEach { $_.Name }`）：
            # 没有任何可执行动作，兜底审批只会白挂一次。
            return Decision("auto", [])
        pieces = [q for q in raw if not _LITERAL_PIECE_RE.match(q)]
        if pieces:
            worst = Decision("auto", [])
            # 块体里也可能 `a; b` 并排：先按分隔符拆开再逐段重判，
            # 否则 shlex 把 `Name;` 当一个词，改动作藏在分号后会被看漏。
            for q in pieces:
                for sub in _SEP_RE.split(q):
                    sub = sub.strip()
                    if not sub:
                        continue
                    d = _classify_segment(sub)
                    if _ORDER[d.level] > _ORDER[worst.level]:
                        worst = d
            return worst

    # 只读查询：首项是查询旗标、后面全是选项（无目标/无负载）→ 纯查询。
    # 放 deny 之后，保证 `rm -rf / --help` / `shutdown -h now` 仍被拦。
    if args and args[0] in _QUERY_LEAD and all(a.startswith("-") for a in args[1:]):
        return Decision("auto", [])

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
        sub = _docker_action(args[0]) if args else ""
        rest = args[1:]
        if sub in _DOCKER_GROUPS:
            obj = _docker_action(rest[0]) if rest else ""
            if obj in _DOCKER_READ or obj == "show":
                return Decision("auto", [])
            return Decision("approve", [f"{verb} {sub} 改动容器环境"])
        if sub == "compose":
            action = _docker_action(rest[0]) if rest else ""
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
    # sc：PowerShell 里 `sc` 是 Set-Content 的别名——`sc query com.docker.service`
    # 实为「把 com.docker.service 写进文件 query」（真机 2026-10-07 仓库根的
    # query/start 两个空名文件就是这么来的）。cmd 的 sc.exe 才是服务控制器。
    # shell 上下文不进策略，一律按写文件审批，绝不当只读服务查询放行。
    if verb == "sc":
        return Decision("approve", ["sc 在 PowerShell 里是 Set-Content（写文件）"])
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
    # PowerShell/Windows 命令名大小写不敏感（get-service == Get-Service）
    if (verb in _READ_VERBS or verb.lower() in _READ_VERBS_L) and not reasons:
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
