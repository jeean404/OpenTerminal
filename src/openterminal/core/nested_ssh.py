"""嵌套 SSH 帧解析：跳板机/嵌套登录的帧记账与目标解析（Task 2 自
core.py 原样搬入）。

纯分析、无 I/O；跨域状态经 core 读：_open_cmds/_open_cmd_at（用户命令
记账，Task 4 归 ExecEvents）、_last_mark_at（hook 活性时间戳，Task 5 归
HookGate）、_target_host（PipelineCore 自持）。方法名去前导下划线做
组件公开接口，语义与原 PipelineCore 私有方法一致。
"""

from __future__ import annotations

import os

from ..connections import parse_user_at_host
from ..shell.integration import is_internal_line


class NestedSshTracker:
    def __init__(self, core) -> None:
        self.core = core

    # --- 单行解析（静态方法） ---

    @staticmethod
    def parse_ssh_cmd_target(line: str
                              ) -> tuple[str | None, str | None, int | None] | None:
        """单条命令行解析 ssh 族命令的目标；非 ssh 族返回 None。

        ssh 族但目标解析不出（空行、`ssh` 无目标、别名目标读不到等）
        返回 (None, None, None)。调用方按各自语义处置：_nested_ssh_target
        据此向外层帧继续找（既有行为），_ssh_frame_host 跳过本帧找最近的
        ssh 帧。端口取 dest 的 :port 或 -p/-P/--port= 选项。
        """
        import shlex

        try:
            parts = shlex.split(line)
        except ValueError:
            parts = line.split()
        if not parts:
            return None, None, None
        cmd = os.path.basename(parts[0])
        if cmd not in ("ssh", "scp", "rsync", "sftp"):
            return None   # 非 ssh 类（sudo/su 等）：不算 ssh 帧
        val_opts = {"b", "c", "D", "e", "F", "i", "J", "l", "L", "m",
                    "o", "p", "P", "R", "S", "W"}
        argv = parts[1:]
        i = 0
        dest = None
        bare_args: list[str] = []
        while i < len(argv):
            a = argv[i]
            if a == "--":
                i += 1
                if i < len(argv):
                    bare_args.append(argv[i])
                break
            if a.startswith("-") and len(a) > 1:
                if a[1] in val_opts and len(a) == 2:
                    i += 2   # 带值短选项：连值一起跳过
                else:
                    i += 1   # 无值开关（-t/-A/-4…）或合写带值（-oVal）
                continue
            bare_args.append(a)
            i += 1
        if cmd in ("scp", "rsync"):
            # 源/目的都可能带远端路径：挑带 @ 的（user@host:path），
            # 其次带 : 的（host:path）；纯本地路径跳过
            remote = [a for a in bare_args if "@" in a] or \
                [a for a in bare_args if ":" in a]
            dest = remote[0] if remote else None
        else:
            dest = bare_args[0] if bare_args else None
        if dest is None:
            return None, None, None
        if cmd in ("scp", "rsync") and ":" in dest:
            dest = dest.rsplit(":", 1)[0]   # 去掉远端路径
        host, user, port = parse_user_at_host(dest)
        if port is None:
            # ssh -p/--port 端口在选项里
            for j, a in enumerate(argv):
                if a == "-p" and j + 1 < len(argv) and argv[j + 1].isdigit():
                    port = int(argv[j + 1])
                elif a.startswith("--port=") and a[7:].isdigit():
                    port = int(a[7:])
                elif a == "-P" and j + 1 < len(argv) and argv[j + 1].isdigit():
                    port = int(argv[j + 1])
        return host, user, port


    def innermost_ssh_frame(self) -> int | None:
        """最内层未闭合用户帧若是 ssh 类返回其 inst（嵌套会话存续判定）。"""
        if not self.core._open_cmds:
            return None
        inst = next(reversed(self.core._open_cmds))
        line = (self.core._open_cmds[inst] or "").strip()
        if not line or is_internal_line(line):
            return None
        if os.path.basename(line.split()[0]) not in ("ssh", "scp", "rsync", "sftp"):
            return None
        return inst


    def inner_ssh_prompt_live(self) -> bool:
        """最内层未闭合用户帧是 ssh 类且开帧后出现过提示符标记（= 内层 hook
        活在 readline 提示符上）：嵌套会话的自然语言放行健康路径。

        _open_cmds 门闩本防 \\r 落进前台命令 stdin（su - 整段会话），但 ssh
        跳板机帧同样整段开着——一刀切会让嵌套会话里每次自然语言都走降级
        （\\x03 + 0.4s + 探测 + 分片重注入，秒级，真机「等几秒才出分析卡」
        根因之一）。su - 帧非 ssh 族仍锁；内层前台命令（top/mysql）会开自己
        的帧，最内层非 ssh 族亦仍锁；外族 PS1 假标记只随 su - 出现，进不来。"""
        inst = self.innermost_ssh_frame()
        if inst is None:
            return False
        return self.core._last_mark_at > self.core._open_cmd_at.get(inst, 0.0) + 0.05



    def nested_ssh_target(self) -> tuple[str | None, str | None, int | None]:
        """从**最内层**未闭合用户命令行解析 ssh 类命令的目标 (host, user, port)。

        只认最内层帧：嵌套会话里外层 `ssh 跳板机` 帧始终开着，若它兜底
        吸收了内层 sudo 的密码提示，就会把跳板机的凭据错填给 sudo。
        解析不出（sudo、ssh 目标是别名走 ~/.ssh/config 等）返回 (None,...)
        ——密码仍可弹窗代答，只是「记住」没有可靠的键。
        （单行解析抽在 _parse_ssh_cmd_target；本方法的最内层帧防线不得
        放宽——外层 ssh 凭据绝不与内层 sudo/嵌套混用。）"""
        for line in reversed(list(self.core._open_cmds.values())):
            parsed = self.parse_ssh_cmd_target(line)
            if parsed is None:
                return None, None, None   # 最内层不是 ssh 类：不解析
            host, user, port = parsed
            if host:
                return host, user, port
        return None, None, None

    def ssh_frame_target(self) -> tuple[str | None, str | None, int | None]:
        """最近一层未闭合 ssh 帧的完整目标 (host, user, port)。

        与 ``nested_ssh_target`` 的「最内层非 ssh 即止」不同：这里**跳过
        非 ssh 帧向外找**——`ssh B` 之后再 `sudo su -`，终端仍停在 B 上，
        文件面板要连的就是 B。真机踩过：面板按 nested_ssh_target 取目标，
        `sudo su -` 一开帧就解析成 None、退回跳板机，用户看到的是跳板机的
        家目录。凭据代答仍用 nested_ssh_target 的严格语义（防跳板机凭据
        错填给内层 sudo），两条语义不混用。
        """
        for line in reversed(list(self.core._open_cmds.values())):
            parsed = self.parse_ssh_cmd_target(line)
            if parsed is not None and parsed[0]:
                return parsed
        return None, None, None

    def ssh_frame_host(self) -> str | None:
        """最内层未闭合 ssh 族命令的目标主机（都解析不出返回 None）。

        跳过非 ssh 帧（sudo/su 自身）向外找最近的 ssh 帧——sudo 就跑在那台机
        上，是 sudo 凭据键的落名依据（P1-3）。"""
        return self.ssh_frame_target()[0]

    def sudo_pw_key(self) -> tuple[str, str, int | None] | None:
        """sudo/su 类无主机提示符的凭据键：(host, "sudo", None) → sudo@host。

        提示符不带 user@host（[sudo] password for user:），凭据归属只有
        两条线索：最近一层 ssh 帧的目标（sudo 就跑在那台机上；跳板拓扑
        里命令集 ssh 进内层机再 sudo，会话目标主机反而是跳板），无 ssh
        帧则会话目标主机（sudo 直接跑在目标机上）。

        user 恒为 "sudo"——sudo 专用命名空间（display_name 拼出
        ``sudo@host``），绝不与 ssh 登录凭据键（user@host）混用，外层
        跳板凭据也就不会被错填给内层 sudo（P1-3 不变量）。键按「sudo
        实际所在主机」命名：同跳板下多台内层机各记各的 sudo 密码，
        不互相覆盖误填。
        """
        host = self.ssh_frame_host() or self.core._target_host or None
        if not host:
            return None
        return (host, "sudo", None)
