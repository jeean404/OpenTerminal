"""CLI 前端：主菜单 / 主机管理 + 单管线终端（term_frontend）。

选定连接目标后进入 TermFrontend 单管线终端：输入即终端（PTY 直通），
自然语言直接交给 AI，/help 查看命令（/target /system /clear /model /exit
等斜杠命令由核心 core.py 统一承接）。旧双管线 REPL（意图分类、哨兵捕获、
raw 模式切换）已移除；rawmode.py / intent.py 文件本体待 Task 7 删除。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import Callable

from prompt_toolkit import PromptSession
from prompt_toolkit.application import Application
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import Layout, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.dimension import D
from prompt_toolkit.styles import Style

from . import render
from .config import Config, TargetConfig
from .connections import (
    JumpGroup, JumpHost, TargetList, build_target_list, display_name, jump_for,
    load_jump_hosts, load_saved_targets, parse_user_at_host, save_jump_hosts,
    save_saved_targets,
)
from .policy import Policy
from .secrets_store import load_password, store_password
from .sysprobe import LOCAL_PROFILE, SystemProfile
from .term_frontend import CliCore, TermFrontend
from .transcript import open_transcript

# 全屏/会话接管类命令白名单：命中即走透传（tui ctx），免去前端"第一帧落在
# 文本块再升级"的闪烁。这只是快路径——正确性由前端输出序列检测兜底
#（ansi.js AnsiStream.tui），新全屏命令不登记也能正确渲染，见 app.js _escalateTui。
_INTERACTIVE = {
    "vim", "nvim", "nano", "vi", "view", "vimdiff", "emacs", "top", "htop",
    "btop", "tmux", "screen", "less", "more", "man", "ssh", "sftp", "mysql",
    "psql", "redis-cli", "python", "python3", "node", "irb", "su",
    "watch", "iotop", "iftop", "nethogs", "atop", "glances",
    "powershell", "pwsh",
}

# 裸 shell（不带 -c）是交互程序；sudo -i/-s/--login/--shell 直接起登录 shell
_SHELL_VERBS = {"bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh"}
_SUDO_INTERACTIVE_FLAGS = {"-i", "-s", "--login", "--shell"}
# PowerShell 的一次性执行参数（跑完进程即退出）；-NoExit 显式保持会话除外
_PS_ONESHOT_FLAGS = {"-c", "-command", "-commandwithargs", "-file",
                     "-encodedcommand"}
# 这些 PS 选项的值是独立 token（如 -ExecutionPolicy Bypass），不算位置参数
_PS_VALUE_OPTIONS = {
    "-executionpolicy", "-outputformat", "-inputformat",
    "-configurationname", "-configurationfile", "-workingdirectory",
    "-custompipename",
}


def _ps_is_oneshot(args: list[str]) -> bool:
    """powershell/pwsh 参数是否为一次性执行形式（-Command/-File/位置参数）。

    ``powershell -Command Write-Output x`` 跑完即退出，按普通命令处理；
    裸 ``powershell`` / ``powershell -NoLogo`` / ``-NoExit -Command …``（显式
    保持会话）才是会话接管。位置参数判定要跳过带独立值的选项
    （-ExecutionPolicy Bypass 的 Bypass 不是脚本参数）。
    """
    has_positional = False
    i = 0
    while i < len(args):
        low = args[i].lower()
        if low == "-noexit":
            return False
        if low in _PS_ONESHOT_FLAGS:
            return True
        if low in _PS_VALUE_OPTIONS:
            i += 2                       # 跳过选项及其值
            continue
        if not args[i].startswith("-"):
            has_positional = True
        i += 1
    return has_positional


_ADD_NEW = "__add_new__"    # 管理主机里「添加主机」的哨兵键
_ADD_JUMP = "__add_jump__"  # 「添加跳板机」
_BACK = "__back__"          # 各菜单「返回」项（避免与用户主机名撞 key）


def picker_rows(tl: TargetList) -> list[tuple[str | None, str]]:
    """连接目标列表：(key, label)；key 为 None 的行只展示不参与选择。

    添加/编辑/删除归「管理主机」，这里只列可连目标。
    """
    rows: list[tuple[str | None, str]] = [("local", "local（本机终端）")]
    if tl.direct:
        rows.append((None, "── 直接连接 ──"))
        rows.extend((t.name, t.name) for t in tl.direct)
    if tl.jumps:
        rows.append((None, "── 经跳板机 ──"))
        for g in tl.jumps:
            rows.append((g.jump.name, f"[跳板机] {g.jump.name}（{len(g.targets)} 台主机）"))
    rows.append((_BACK, "返回"))
    return rows


def jump_submenu_rows(group: JumpGroup) -> list[tuple[str | None, str]]:
    rows: list[tuple[str | None, str]] = [
        (t.name, f"{t.name}   {display_name(t.host or t.name, t.user, t.port)}")
        for t in group.targets
    ]
    if not group.targets:
        rows.append((None, "（该跳板机下还没有主机，可在管理主机中添加）"))
    rows.append((_BACK, "返回"))
    return rows


def is_interactive_command(command: str) -> bool:
    parts = command.split()
    if not parts:
        return False
    if parts[0] == "sudo":
        rest = parts[1:]
        # 跳过前导选项及其值参数（-u/-g/-U 后跟用户名），取首个非选项作 verb；
        # -i/-s/--login/--shell 本身即会话接管，直接判交互
        while rest:
            tok = rest[0]
            if tok in _SUDO_INTERACTIVE_FLAGS:
                return True
            if tok in {"-u", "-g", "-U"} and len(rest) > 1:
                rest = rest[2:]
            elif tok.startswith("-"):
                rest = rest[1:]
            else:
                break
        if not rest:
            return False
        verb = rest[0]
        args_after = rest[1:]
    else:
        verb = parts[0]
        args_after = parts[1:]
    if verb == "tail":
        return "-f" in parts or "-F" in parts
    if verb in _SHELL_VERBS and "-c" in args_after:
        return False  # bash -c '...' 一次性执行，非交互
    if verb in ("powershell", "pwsh") and _ps_is_oneshot(args_after):
        return False  # powershell -Command/位置参数 一次性执行，非交互
    return verb in _INTERACTIVE or verb in _SHELL_VERBS


# 长驻流式命令（日志 follow 等）：无超时实时流式，用户 Ctrl+C（⏹）收束。
# 只看 -f 会误伤 rm -f 等「force」语义，故按 verb + 子命令组合判定。
_STREAMING_PATTERNS: dict[str, Callable[[list[str]], bool]] = {
    "tail": lambda p: "-f" in p or "-F" in p,
    "journalctl": lambda p: "-f" in p or "--follow" in p,
    "docker": lambda p: "logs" in p and ("-f" in p or "--follow" in p),
    "podman": lambda p: "logs" in p and ("-f" in p or "--follow" in p),
    "kubectl": lambda p: "logs" in p and ("-f" in p or "--follow" in p),
}


def is_streaming_command(command: str) -> bool:
    """命令是否为长驻流式（docker logs -f / tail -f / journalctl -f …）。

    这类命令不能包哨兵 run：进程不退出 → END 哨兵永不出现 → 挂满超时。
    必须走无超时流式，用户 Ctrl+C 收束。
    """
    parts = command.split()
    if not parts:
        return False
    fn = _STREAMING_PATTERNS.get(parts[0])
    return fn(parts) if fn else False


def is_quit_line(line: str) -> bool:
    """`exit`/`quit`/`logout`（含 / 前缀与 ! 前缀）判定为退出 ot。

    不能把它们当普通命令发给远端 shell：登录 shell 一退出就触发自动重连，
    重连又回到密码提示（CLI/Web 同病）。
    """
    head = line.strip().lstrip("!").split(maxsplit=1)[0] if line.strip() else ""
    return head in {"/exit", "/quit", "exit", "quit", "logout"}


def _git_branch(cwd: str) -> str | None:
    """返回当前 git 分支名；非仓库或失败时返回 None。"""
    import subprocess

    try:
        r = subprocess.run(
            ["git", "-C", cwd, "branch", "--show-current"],
            capture_output=True, text=True, timeout=1,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    branch = r.stdout.strip()
    return branch or None


def prompt_text(profile: SystemProfile, session, user: str) -> str:
    cwd = session.cwd.replace(os.path.expanduser("~"), "~") if session.cwd else "~"
    branch = _git_branch(session.cwd) if session.cwd else None
    git_seg = f" git:({branch})" if branch else ""
    return (f"ot {user}@{profile.host} ({profile.os_family}) {cwd}{git_seg} $ ")


# --- 光标选择菜单（prompt_toolkit Application，替换编号输入）---


def menu_fragments(title: str, rows: list[tuple[str | None, str]],
                   selected: int) -> list[tuple[str, str]]:
    """菜单渲染片段（纯函数，可单测）：标题 + 列表；selected 指向的可选项
    反显 + "▸ " 前缀，key=None 的分隔行只展示不参与选择。"""
    out: list[tuple[str, str]] = [("bold", f"  {title}")]
    si = 0
    for k, label in rows:
        out.append(("", "\n"))
        if k is None:
            out.append(("class:sep", f"  ── {label} ──"))
            continue
        if si == selected:
            out.append(("class:menu-selected", f"▸ {label}"))
        else:
            out.append(("", f"  {label}"))
        si += 1
    return out


def pick_menu_sync(title: str, rows: list[tuple[str | None, str]], *,
                   input=None, output=None) -> str | None:
    """光标菜单：↑/↓ 或 j/k 移动高亮，回车返回选中 key，q/Esc/Ctrl-C/D 返回 None。

    rows 为 (key, label)；key 为 None 的行只展示（分隔/占位）不参与选择。
    input/output 供测试注入 create_pipe_input / 捕获输出。
    """
    selectable = [(k, label) for k, label in rows if k is not None]
    if not selectable:
        return None
    idx = 0

    def get_fragments():
        return menu_fragments(title, rows, idx)

    kb = KeyBindings()

    @kb.add("down")
    @kb.add("j")
    def _down(event):  # noqa: ANN202
        nonlocal idx
        idx = (idx + 1) % len(selectable)

    @kb.add("up")
    @kb.add("k")
    def _up(event):  # noqa: ANN202
        nonlocal idx
        idx = (idx - 1) % len(selectable)

    @kb.add("enter")
    def _ok(event):  # noqa: ANN202
        event.app.exit(result=selectable[idx][0])

    @kb.add("q")
    @kb.add("escape")
    @kb.add("c-c")
    @kb.add("c-d")
    def _cancel(event):  # noqa: ANN202
        event.app.exit(result=None)

    app = Application(
        layout=Layout(Window(
            FormattedTextControl(get_fragments),
            height=D(preferred=len(rows) + 1),
        )),
        key_bindings=kb,
        style=Style.from_dict({
            "sep": "dim",
            "menu-selected": "reverse",
        }),
        input=input,
        output=output,
        full_screen=False,
        erase_when_done=True,
    )
    try:
        return app.run()
    except EOFError:
        # 输入流结束（管道/重定向，如 `ot < /dev/null`）→ 视为取消
        return None


async def pick_menu(title: str, rows: list[tuple[str | None, str]]) -> str | None:
    """光标选择一屏条目；返回选中 key 或 None（取消）。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: pick_menu_sync(title, rows))


def _host_label(t: TargetConfig) -> str:
    return display_name(t.host or t.name, t.user, t.port)


def _jump_label(j: JumpHost) -> str:
    return display_name(j.host, j.user, j.port)


class Cli:
    def __init__(self, cfg: Config, initial_target: str | None = None) -> None:
        self.cfg = cfg
        self.initial_target = initial_target
        self.policy = Policy(
            mode=cfg.policy.mode, auto_extra=cfg.policy.auto_extra,
            approve_extra=cfg.policy.approve_extra, deny_extra=cfg.policy.deny_extra,
        )
        self.session_id = uuid.uuid4().hex[:8]
        self.transcript = open_transcript(self.session_id)
        self.session = None
        self.profile = LOCAL_PROFILE
        self.agent = None
        self.backend = None
        self.allowed: set[str] = set()
        # 本次会话里由用户手敲 user@host 临时注册的目标（连接成功后询问是否记住）
        self._adhoc_targets: set[str] = set()
        # 本次会话里新添加的跳板机（连接成功后询问是否记住其密码）
        self._adhoc_jumps: set[str] = set()
        # config.toml 手写目标的名字（含 default）：只读，管理主机时不许被覆盖
        self._config_target_names = set(self.cfg.targets)
        # 记住的连接注册进可选目标（config.toml 里手写的优先）
        for t in load_saved_targets():
            self.cfg.targets.setdefault(t.name, t)

    def _target_name_for(self, text: str) -> str:
        """把 'prod-web' 或 'deploy@host:2222' 注册成 TargetConfig，返回名字。"""
        host, user, port = parse_user_at_host(text)
        name = text if user is None and port is None else host
        if name not in self.cfg.targets:
            self.cfg.targets[name] = TargetConfig(
                name=name, mode="ssh", host=host, user=user, port=port,
            )
            self._adhoc_targets.add(name)
        return name

    async def _maybe_remember(self, name: str) -> None:
        """手敲的新 SSH 连接成功后询问是否记住（存 ~/.openterminal，不入 git）。"""
        if name not in self._adhoc_targets:
            return
        self._adhoc_targets.discard(name)
        target = self.cfg.targets.get(name)
        if not target or target.mode != "ssh" or not target.host:
            return
        saved = load_saved_targets()
        if any(t.host == target.host and t.user == target.user
               and t.port == target.port for t in saved):
            return
        try:
            ans = (await _prompt_text(
                "记住该连接（含密码，存系统凭据库）？下次启动可直接选择 [y/N]: "
            )).strip().lower()
        except EOFError:
            return
        if ans not in {"y", "yes"}:
            return
        disp = display_name(target.host, target.user, target.port)
        saved.append(TargetConfig(
            name=disp, mode="ssh", host=target.host,
            user=target.user, port=target.port, jump=target.jump,
        ))
        save_saved_targets(saved)
        # 密码走系统凭据库（Windows 凭据管理器 / macOS Keychain / Linux
        # Secret Service），不落 connections.toml 明文；本连接未用到密码
        # （密钥认证）或凭据库不可用时跳过
        pw = getattr(self.session, "last_password", None)
        note = ""
        if pw is not None:
            if store_password(target.host, target.user, target.port, pw):
                note = "，密码已存入系统凭据库"
            else:
                note = "（本机无可用凭据库，密码未存，下次仍需输入）"
        render.console.print(
            f"[green]已记住 {disp}[/] "
            f"[dim]（~/.openterminal/connections.toml{note}）[/]")

    async def _pick_startup_target(self) -> str | None:
        """连接目标选择（光标菜单）：local · 直接连接 · 经跳板机（层级子菜单）。
        添加/编辑/删除在「管理主机」；取消或「返回」返回 None（回主菜单）。"""
        while True:
            tl = build_target_list()
            rows = picker_rows(tl)
            pick = await pick_menu("选择连接目标：", rows)
            if pick is None or pick == _BACK:
                return None  # 取消或「返回」→ 回主菜单
            if pick == "local":
                return "default"
            group = next((g for g in tl.jumps if g.jump.name == pick), None)
            if group is None:
                return pick  # 直接目标
            sub = await pick_menu(
                f"跳板机 {pick} 下的主机：", jump_submenu_rows(group))
            if sub is None or sub == _BACK:
                continue  # 取消/「返回」→ 回到选择框
            return sub

    async def _prompt_add_jump(self) -> str | None:
        """「添加跳板机」：手敲 user@host[:port] 存进 connections.toml；返回名字。"""
        try:
            text = (await _prompt_text(
                "输入跳板机连接（user@host[:端口]）: ")).strip()
        except EOFError:
            render.console.print("[yellow]输入结束，返回。[/]")
            return None
        if not text:
            return None
        host, user, port = parse_user_at_host(text)
        name = display_name(host, user, port)
        jumps = load_jump_hosts()
        if any(j.name == name or j.host == host for j in jumps):
            render.console.print(f"[yellow]跳板机 {name} 已存在。[/]")
            return name
        jumps.append(JumpHost(name=name, host=host, user=user, port=port))
        save_jump_hosts(jumps)
        render.console.print(f"[green]已添加跳板机 {name}[/]")
        return name

    def _sync_saved_targets(self) -> None:
        """按 connections.toml 重建 cfg.targets 里「记住的连接」条目；
        config.toml 手写目标（_config_target_names）保持优先且只读。"""
        fresh = load_saved_targets()
        fresh_names = {t.name for t in fresh}
        self.cfg.targets.update(
            {t.name: t for t in fresh if t.name not in self._config_target_names})
        for name in list(self.cfg.targets):
            if (name not in self._config_target_names
                    and name not in fresh_names
                    and name not in self._adhoc_targets):
                del self.cfg.targets[name]

    async def _prompt_add_host(self) -> str | None:
        """「管理主机」里添加主机：手敲 user@host[:port]，立即存进 connections.toml。

        不注册临时目标、不连接，直接落盘；按 host/user/port 去重；留空或取消返回 None。
        """
        try:
            text = (await _prompt_text(
                "输入连接（user@host[:端口]，如 root@1.2.3.4:2222）: ")).strip()
        except EOFError:
            render.console.print("[yellow]输入结束，返回管理页。[/]")
            return None
        if not text:
            return None
        host, user, port = parse_user_at_host(text)
        saved = load_saved_targets()
        if any(t.host == host and t.user == user and t.port == port
               for t in saved):
            render.console.print(
                f"[yellow]主机 {display_name(host, user, port)} 已存在。[/]")
            return None
        jump = None
        jumps = load_jump_hosts()
        if jumps:
            try:
                ans = (await _prompt_text(
                    "经跳板机？（跳板机名或回车跳过）: ")).strip()
            except EOFError:
                ans = ""
            if ans in {j.name for j in jumps}:
                jump = ans
        name = display_name(host, user, port)
        saved.append(TargetConfig(name=name, mode="ssh", host=host,
                                  user=user, port=port, jump=jump))
        save_saved_targets(saved)
        self._sync_saved_targets()
        render.console.print(f"[green]已添加主机 {name}[/]")
        return name

    async def _edit_saved_host(self, idx: int) -> bool:
        """编辑第 idx 个已存主机：重敲 user@host[:port]（可改跳板机），替换
        connections.toml 条目并同步 cfg.targets。留空/取消返回 False。"""
        saved = load_saved_targets()
        if not 0 <= idx < len(saved):
            return False
        target = saved[idx]
        old_label = _host_label(target)
        try:
            text = (await _prompt_text(
                f"新连接（当前 {old_label}，user@host[:端口]）: ")).strip()
        except EOFError:
            render.console.print("[yellow]输入结束，取消编辑。[/]")
            return False
        if not text:
            return False
        host, user, port = parse_user_at_host(text)
        new_label = display_name(host, user, port)
        if any(t.host == host and t.user == user and t.port == port
               and t.name != target.name for t in saved):
            render.console.print(f"[yellow]主机 {new_label} 已存在。[/]")
            return False
        jump = target.jump
        jumps = load_jump_hosts()
        if jumps:
            try:
                ans = (await _prompt_text(
                    "经跳板机？（跳板机名或回车跳过）: ")).strip()
            except EOFError:
                ans = ""
            if ans in {j.name for j in jumps}:
                jump = ans
        saved[idx] = TargetConfig(name=new_label, mode="ssh", host=host,
                                  user=user, port=port, jump=jump)
        save_saved_targets(saved)
        self._sync_saved_targets()
        render.console.print(f"[green]已更新主机 {old_label} → {new_label}[/]")
        return True

    async def _edit_jump_host(self, idx: int) -> bool:
        """编辑第 idx 个跳板机：重敲 user@host[:port]；改名后级联到引用它的目标。"""
        jumps = load_jump_hosts()
        if not 0 <= idx < len(jumps):
            return False
        jh = jumps[idx]
        old_name = jh.name
        old_label = _jump_label(jh)
        try:
            text = (await _prompt_text(
                f"新跳板机连接（当前 {old_label}，user@host[:端口]）: ")).strip()
        except EOFError:
            render.console.print("[yellow]输入结束，取消编辑。[/]")
            return False
        if not text:
            return False
        host, user, port = parse_user_at_host(text)
        new_label = display_name(host, user, port)
        if any(j.host == host and j.name != old_name for j in jumps):
            render.console.print(f"[yellow]跳板机 {new_label} 已存在。[/]")
            return False
        jumps[idx] = JumpHost(name=new_label, host=host, user=user, port=port)
        save_jump_hosts(jumps)
        if new_label != old_name:
            saved = load_saved_targets()
            if any(t.jump == old_name for t in saved):
                for t in saved:
                    if t.jump == old_name:
                        t.jump = new_label
                save_saved_targets(saved)
        render.console.print(f"[green]已更新跳板机 {old_label} → {new_label}[/]")
        return True

    async def _delete_saved_host(self, idx: int) -> None:
        saved = load_saved_targets()
        if 0 <= idx < len(saved):
            save_saved_targets([t for i, t in enumerate(saved) if i != idx])
        self._sync_saved_targets()

    async def _delete_jump_host(self, idx: int) -> None:
        jumps = load_jump_hosts()
        if not 0 <= idx < len(jumps):
            return
        name = jumps[idx].name
        save_jump_hosts([j for i, j in enumerate(jumps) if i != idx])
        # 删除跳板机级联：saved 里引用它的目标把 jump 置空（归入直接连接）
        saved = load_saved_targets()
        if any(t.jump == name for t in saved):
            for t in saved:
                if t.jump == name:
                    t.jump = None
            save_saved_targets(saved)
        self._sync_saved_targets()

    async def _manage_saved_host(self, idx: int) -> None:
        """第 idx 个已存主机：编辑 / 删除 / 返回。"""
        saved = load_saved_targets()
        if not 0 <= idx < len(saved):
            return
        label = _host_label(saved[idx])
        act = await pick_menu(f"主机 {label}", [
            ("edit", "编辑"),
            ("delete", "删除"),
            (_BACK, "返回"),
        ])
        if act == "edit":
            await self._edit_saved_host(idx)
        elif act == "delete":
            try:
                ans = (await _prompt_text(
                    f"删除该主机 {label}？[y/N]: ")).strip().lower()
            except EOFError:
                ans = ""
            if ans in {"y", "yes"}:
                await self._delete_saved_host(idx)
                render.console.print(f"[green]已删除主机 {label}[/]")

    async def _manage_jump_host(self, idx: int) -> None:
        """第 idx 个跳板机：编辑 / 删除 / 返回。"""
        jumps = load_jump_hosts()
        if not 0 <= idx < len(jumps):
            return
        label = _jump_label(jumps[idx])
        act = await pick_menu(f"跳板机 {label}", [
            ("edit", "编辑"),
            ("delete", "删除"),
            (_BACK, "返回"),
        ])
        if act == "edit":
            await self._edit_jump_host(idx)
        elif act == "delete":
            try:
                ans = (await _prompt_text(
                    f"删除该跳板机 {label}？[y/N]: ")).strip().lower()
            except EOFError:
                ans = ""
            if ans in {"y", "yes"}:
                await self._delete_jump_host(idx)
                render.console.print(f"[green]已删除跳板机 {label}[/]")

    async def _manage_hosts(self) -> None:
        """管理主机：列出已存主机与跳板机，支持添加/编辑/删除（光标菜单）。"""
        while True:
            saved = load_saved_targets()
            jumps = load_jump_hosts()
            rows: list[tuple[str | None, str]] = [(None, "主机")]
            if saved:
                rows.extend((("h", i), _host_label(t)) for i, t in enumerate(saved))
            else:
                rows.append((None, "（还没有主机）"))
            rows.append((_ADD_NEW, "添加主机"))
            rows.append((None, "跳板机"))
            if jumps:
                rows.extend((("j", i), _jump_label(j)) for i, j in enumerate(jumps))
            else:
                rows.append((None, "（还没有跳板机）"))
            rows.append((_ADD_JUMP, "添加跳板机"))
            rows.append((_BACK, "返回"))

            pick = await pick_menu("管理主机", rows)
            if pick is None or pick == _BACK:
                return
            if pick == _ADD_NEW:
                await self._prompt_add_host()
                continue
            if pick == _ADD_JUMP:
                await self._prompt_add_jump()
                continue
            if isinstance(pick, tuple) and pick[0] == "h":
                await self._manage_saved_host(pick[1])
                continue
            if isinstance(pick, tuple) and pick[0] == "j":
                await self._manage_jump_host(pick[1])
                continue

    async def _maybe_remember_jump(self, target) -> None:
        """新添加的跳板机首次用密码连上后，询问是否把密码存系统凭据库。"""
        jump = jump_for(target)
        if not jump or jump.name not in self._adhoc_jumps:
            return
        if load_password(jump.host, jump.user, jump.port) is not None:
            return
        used = getattr(self.session, "last_jump_password", None)
        if used is None:
            return
        self._adhoc_jumps.discard(jump.name)
        try:
            ans = (await _prompt_text(
                "记住该跳板机密码（存系统凭据库）？下次免密 [y/N]: ")).strip().lower()
        except EOFError:
            return
        if ans in {"y", "yes"}:
            if store_password(jump.host, jump.user, jump.port, used):
                render.console.print("[dim]跳板机密码已存入系统凭据库。[/]")

    async def _connect_via_picker(self) -> str | None:
        """经选择框选连接目标，返回目标名（连接由 _run_pipeline 进行，此处
        不再开 session）；取消或「返回」返回 None。连接失败时核心发 closed、
        _run_pipeline 返回后回主菜单，可重选目标。"""
        name = await self._pick_startup_target()
        if name is None:
            return None
        await self._maybe_remember(name)
        self._sync_saved_targets()
        return name

    async def loop(self) -> None:
        if self.initial_target:
            first = self._target_name_for(self.initial_target)
            await self._run_pipeline(first)
        # 主菜单：连接主机 / 管理主机 / 退出（光标选择）；连接结束后回菜单
        while True:
            pick = await pick_menu("OpenTerminal", [
                ("connect", "连接主机"),
                ("manage", "管理主机"),
                ("exit", "退出"),
            ])
            if pick == "connect":
                name = await self._connect_via_picker()
                if name is not None:
                    await self._run_pipeline(name)
            elif pick == "manage":
                await self._manage_hosts()
            else:  # exit 或取消
                return

    async def _run_pipeline(self, name: str) -> None:
        """以目标名起单管线终端：CliCore（核心）+ TermFrontend（raw 输入 +
        内联渲染 + 本地截获）。输入即终端，自然语言直接交给 AI。

        run() 返回（核心 closed / EOF / 异常）即回主菜单；之后必须补
        core.close()——EOF/异常/连接失败路径下 run() 返回时核心未关
        （Task 3 前向契约），CliCore.close() 幂等。try/finally 保证 run()
        抛异常（未来 loop() 若在菜单里兜住异常）时核心也被关闭。"""
        core = CliCore(self.cfg, name, frontend=None)   # 两段构造：反向注入
        frontend = TermFrontend(core)
        core._frontend = frontend
        try:
            await frontend.run()
        finally:
            await core.close()


async def _prompt_text(text: str, default: str = "") -> str:
    session = PromptSession()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: session.prompt(text, default=default))
