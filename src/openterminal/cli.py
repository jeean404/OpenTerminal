"""REPL：输入甄别、任务执行、审批、目标切换。raw 透传见 rawmode.py。"""

from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import replace
from functools import lru_cache
from typing import Callable

from prompt_toolkit import PromptSession
from prompt_toolkit.application import Application
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.completion.filesystem import PathCompleter
from prompt_toolkit.document import Document
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import Layout, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.dimension import D
from prompt_toolkit.styles import Style

from . import render
from .agent import TaskRunner, build_agent, build_chat_model
from .approval import decision_for_choice, edit_decision, reclassify_edited
from .config import Config, TargetConfig, app_dir
from .connections import (
    JumpGroup, JumpHost, TargetList, build_target_list, display_name, jump_for,
    list_ssh_hosts, load_jump_hosts, load_saved_targets, open_session,
    parse_user_at_host, save_jump_hosts, save_saved_targets,
)
from .intent import IntentClassifier
from .policy import Policy
from .secrets_store import load_password, store_password
from .sysprobe import (
    LOCAL_PROFILE, MANUAL_PRESETS, SystemProfile, load_host_cache,
    probe_profile, save_host_cache,
)
from .taskview import TaskPresenter, ThinkingIndicator, ThinkingStream
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

RAW_SIGNAL = "\x12"  # Ctrl+R 经键绑定传入主循环

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
        self.classifier = IntentClassifier(llm_classify=self._llm_classify)
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

    async def _llm_classify(self, text: str) -> str:
        model = build_chat_model(self.cfg.model)
        resp = await model.ainvoke([
            ("system", "判断用户输入是 shell 命令还是自然语言任务，"
                       "只回答一个词：command 或 task。"),
            ("user", text),
        ])
        from .agent import message_text
        answer = message_text(resp).strip().lower()
        return "command" if answer.startswith("command") else "task"

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

    async def _connect_via_picker(self) -> bool:
        """经选择框连接；取消返回 False（回主菜单）；失败（密码错/主机
        不可达）回到选择框重选；连接成功返回 True。"""
        while True:
            name = await self._pick_startup_target()
            if name is None:
                return False
            try:
                await self.switch_target(name)
                return True
            except EOFError:
                raise
            except Exception as e:  # noqa: BLE001 - 连接失败回到选择框重选
                render.console.print(
                    f"[bold red]连接失败：{type(e).__name__}: {e}[/]\n"
                    "请重选目标或检查地址/密码。")

    async def switch_target(self, name: str = "default") -> None:
        if self.session is not None:
            await self.session.close()
        target = self.cfg.targets.get(name, self.cfg.targets["default"])
        host = target.host or ("local" if target.mode == "local" else target.name)
        # 记住的密码从系统凭据库取：ssh 先尝试它，失效再现场询问
        stored_pw = (load_password(target.host, target.user, target.port)
                     if target.mode == "ssh" and target.host else None)
        # 密码提示来自连接过程，先给出上下文让用户知道在连谁
        render.console.print(f"[dim]正在连接 {host}…[/]")
        self.session = await open_session(
            target,
            password=stored_pw,
            default_timeout=self.cfg.shell.timeout_default,
            max_output_bytes=self.cfg.shell.max_output_bytes,
        )
        # 记住的密码已失效、途中现场重输成功 → 把新密码写回凭据库
        used_pw = getattr(self.session, "last_password", None)
        if (stored_pw is not None and used_pw is not None
                and used_pw != stored_pw
                and store_password(target.host, target.user, target.port, used_pw)):
            render.console.print("[dim]系统凭据库中的密码已更新。[/]")
        cache = load_host_cache(app_dir() / "hosts.toml")
        if target.mode == "local":
            self.profile = replace(LOCAL_PROFILE)
        elif host in cache:
            self.profile = replace(cache[host], host=host)
        else:
            self.profile = await probe_profile(self.session, host)
            save_host_cache(app_dir() / "hosts.toml", host, self.profile)
        self.agent, self.allowed, self.backend = build_agent(
            self.profile, self.session, self.cfg, self.policy,
        )
        render.console.print(
            f"[bold green]已连接[/] {host} "
            f"({self.profile.distro or self.profile.os_family})"
        )
        # 跳板机记住的密码失效、途中现场重输成功 → 把新密码写回凭据库
        jump = jump_for(target)
        if jump is not None:
            jstored = load_password(jump.host, jump.user, jump.port)
            jused = getattr(self.session, "last_jump_password", None)
            if (jstored is not None and jused is not None and jused != jstored
                    and store_password(jump.host, jump.user, jump.port, jused)):
                render.console.print("[dim]跳板机密码已更新。[/]")
        await self._maybe_remember_jump(target)
        await self._maybe_remember(name)

    async def _classify_with_indicator(self, line: str) -> str:
        indicator = ThinkingIndicator(render.console, "判断中…")
        indicator.start()
        try:
            return await self.classifier.classify(line)
        finally:
            indicator.stop()

    async def run_direct_command(self, command: str) -> None:
        if is_interactive_command(command):
            # 交互式程序哨兵机制跑不了：直接进终端模式并把命令带进去，
            # 不再要求用户手动 Ctrl+R 后重敲一遍
            render.console.print(
                f"[yellow]{command} 是交互式程序，已自动进入终端模式执行。[/]\n"
                "[dim]完成后按 Ctrl+O 返回 ot。[/]"
            )
            await self._enter_raw(initial=(command + "\r").encode())
            return

        def _tee(text: str) -> None:
            render.console.print(text, end="", highlight=False)

        r = await self.session.run(command, on_output=_tee)
        self.transcript.append("direct", command=command, exit_code=r.exit_code)

    async def run_task(self, text: str) -> None:
        self.transcript.append("user", text=text)
        presenter = self._make_presenter()
        # backend 回调：命令真正开始执行（过了审批）才打印面板，
        # 输出实时 tee，退出码决定是否切换到详述模式
        self.backend.on_start = presenter.on_start
        self.backend.on_output = presenter.on_output
        self.backend.on_finish = presenter.on_finish

        def _live(ev) -> None:
            if ev.kind == "token":
                presenter.on_token(ev.text)
            elif ev.kind == "denied":
                presenter.on_denied(ev.text)
            elif ev.kind == "limit":
                presenter.on_limit(ev.text)
            elif ev.kind == "error":
                presenter.on_error(ev.text)

        presenter.begin()
        try:
            runner = TaskRunner(
                self.agent, self.session_id,
                max_tool_turns=self.cfg.shell.max_tool_turns,
                on_event=_live,
            )
            events = await runner.run(text)
            await self._handle_events(runner, events, presenter)
        finally:
            presenter.pause()
            self.backend.on_output = None
            self.backend.on_start = None
            self.backend.on_finish = None

    def _make_presenter(self) -> TaskPresenter:
        return TaskPresenter(
            emit=lambda t: render.console.print(
                t, end="", highlight=False, soft_wrap=True),
            command_panel=lambda c: render.print_command(
                c, self.profile.host, approved=True),
            denied_line=render.print_denied,
            error_line=lambda t: render.console.print(f"[bold red]{t}[/]"),
            summary_panel=render.print_summary,
            stream=ThinkingStream(render.console),
        )

    async def _handle_events(self, runner: TaskRunner, events,
                             presenter: TaskPresenter) -> None:
        while True:
            for ev in events:
                # 实时展示已全部由 on_event/backend 回调完成；
                # 这里只负责 transcript 落盘与流程控制，避免重复打印
                if ev.kind == "tool_call":
                    self.transcript.append("tool_call", command=ev.command)
                elif ev.kind == "denied":
                    self.transcript.append("denied", text=ev.text)
                elif ev.kind in ("limit", "error"):
                    return
                elif ev.kind == "final":
                    self.transcript.append("final", text=ev.text)
                    presenter.finish(ev.text)
            if runner.interrupt_payload is None:
                return
            presenter.pause()  # spinner 必须在 prompt_toolkit 接管终端前停掉
            requests = runner.interrupt_payload["action_requests"]
            if len(requests) > 1:
                render.console.print(
                    f"[bold yellow]模型一轮发起了 {len(requests)} 个命令，"
                    "请逐个确认：[/]"
                )
            decisions: list[dict] = []
            rejected = False
            for req in requests:
                command = req.get("args", {}).get("command", "")
                decision = await self._approval_decision(command)
                self.transcript.append("approval", command=command)
                decisions.append(decision)
                if decision["type"] == "reject":
                    rejected = True
            # 审批面板已在决策后擦除：执行时正常打印“执行”面板+结果，
            # 与自动执行路径呈现一致；有一条被拒就进详述模式看模型如何改道
            if rejected:
                presenter.on_reject()
            events = await runner.resume(decisions)

    async def _approval_decision(self, command: str) -> dict:
        while True:
            panel_rows = render.print_command(command, self.profile.host)
            try:
                choice = await _prompt_choice()
            except EOFError:
                # 输入流结束（如管道喂入）：按最安全的拒绝处理，不打 traceback
                _erase_lines(panel_rows + 1)
                render.console.print("[yellow]输入结束，默认拒绝该命令。[/]")
                return {"type": "reject", "message": "输入结束，未获审批"}
            # 决策完成：擦除审批面板（选择行已由 _prompt_choice 擦掉）。
            # 之后的界面与自动执行路径一致：执行面板 + 真实结果
            _erase_lines(panel_rows)
            if choice == "e":
                try:
                    new = await _prompt_text(
                        f"编辑命令（原：{command}）\n> ", default=command)
                except EOFError:
                    return {"type": "reject", "message": "输入结束，未获审批"}
                d = reclassify_edited(new, self.policy)
                if d.level == "deny":
                    render.print_denied("编辑后的命令仍属灾难命令，已拒绝。")
                    return {"type": "reject", "message": "编辑后命令被策略拒绝"}
                if d.level == "approve":
                    command = new
                    continue  # 编辑后仍是高危 → 重新确认
                return edit_decision(new)
            got = decision_for_choice(choice, command, self.policy, self.allowed)
            if got is not None:
                return got

    async def loop(self) -> None:
        if self.initial_target:
            first = self._target_name_for(self.initial_target)
            await self.switch_target(first)
        else:
            # 主菜单：连接主机 / 管理主机 / 退出（光标选择）
            while True:
                pick = await pick_menu("OpenTerminal", [
                    ("connect", "连接主机"),
                    ("manage", "管理主机"),
                    ("exit", "退出"),
                ])
                if pick == "connect":
                    if await self._connect_via_picker():
                        break  # 已连接 → 进入 REPL
                elif pick == "manage":
                    await self._manage_hosts()
                else:  # exit 或取消
                    return
        while True:
            try:
                line = await _prompt_text_async(
                    prompt_text(self.profile, self.session,
                                os.environ.get("USER", "user")),
                    completer=OtCompleter(_target_names_for_completion),
                )
            except (EOFError, KeyboardInterrupt):
                break
            line = line.strip()
            if not line:
                continue
            if line == RAW_SIGNAL:
                await self._enter_raw()
                continue
            if is_quit_line(line):
                break
            if line == "/help":
                render.console.print(
                    "/target 切换主机  /system <别名> 手动方言  /clear 新任务\n"
                    "/model 查看模型  /exit 退出    Ctrl+R 终端模式  Ctrl+O 返回"
                )
                continue
            if line == "/model":
                render.console.print(
                    f"{self.cfg.model.model} @ {self.cfg.model.base_url}")
                continue
            if line == "/clear":
                self.session_id = uuid.uuid4().hex[:8]
                self.transcript = open_transcript(self.session_id)
                continue
            if line.startswith("/target"):
                try:
                    await self._choose_target(line)
                except EOFError:
                    render.console.print("[yellow]输入结束，取消目标切换。[/]")
                continue
            if line.startswith("/system"):
                self._manual_system(line)
                continue

            intent = await self._classify_with_indicator(line)
            if intent == "command":
                await self.run_direct_command(line.lstrip("!"))
            else:
                try:
                    await self.run_task(line.lstrip("?"))
                except EOFError:
                    # 审批等交互输入遇到流结束：run_task 内已按拒绝处理；
                    # 兜底捕获残留 EOF，干净退出而不是 traceback
                    break
                except Exception as e:  # noqa: BLE001 - 单任务异常不能打死整个 REPL
                    render.console.print(
                        f"[bold red]任务执行出错：{type(e).__name__}: {e}[/]\n"
                        "本次任务已中断，可以继续输入下一条需求。"
                    )
        await self.session.close()

    async def _enter_raw(self, initial: bytes | None = None) -> None:
        from .rawmode import run_raw
        try:
            await run_raw(self.session, initial=initial)
        except Exception as e:  # noqa: BLE001 - raw 模式异常不能打挂 REPL
            render.console.print(f"[red]终端模式异常：{e}[/]")
        # raw 残留输出作为下次哨兵捕获的前缀噪声被丢弃，并同步 cwd
        await self.session.run("true")

    async def _choose_target(self, line: str) -> None:
        names = list(dict.fromkeys(
            ["local"] + [t.name for t in load_saved_targets()] + list_ssh_hosts()))
        parts = line.split(maxsplit=1)
        if len(parts) == 2:
            arg = parts[1]
        else:
            render.console.print("可用目标：" + ", ".join(names))
            arg = await _prompt_text("选择目标（local 或主机名）: ")
        name = "default" if arg == "local" else self._target_name_for(arg)
        await self.switch_target(name)

    def _manual_system(self, line: str) -> None:
        parts = line.split()
        if len(parts) < 2 or parts[1] not in MANUAL_PRESETS:
            render.console.print("可选：" + ", ".join(MANUAL_PRESETS))
            return
        self.profile = replace(self.profile, **MANUAL_PRESETS[parts[1]])
        self.agent, self.allowed, self.backend = build_agent(
            self.profile, self.session, self.cfg, self.policy,
        )
        render.console.print(f"[green]系统方言已手动设为 {parts[1]}[/]")


def _make_prompt_session(completer=None) -> PromptSession:
    bindings = KeyBindings()

    @bindings.add("c-r")
    def _(event):  # noqa: ANN202
        event.app.exit(result=RAW_SIGNAL)

    # 终端风格：只有按 Tab 才出补全（complete_while_typing=False），不弹实时菜单
    return PromptSession(key_bindings=bindings, completer=completer,
                         complete_while_typing=False)


# --- Tab 补全（模拟终端双 Tab 提示）----------------------------------------

_SLASH_META = {
    "/help": "帮助",
    "/target": "切换主机",
    "/system": "手动方言",
    "/clear": "新任务",
    "/model": "查看模型",
    "/exit": "退出",
}

_SHELL_BUILTINS = frozenset({
    "cd", "echo", "export", "unset", "alias", "source", "history", "fg", "bg",
    "jobs", "which", "type", "set", "true", "false", "kill", "wait", "read",
})


@lru_cache(maxsize=1)
def _path_commands() -> frozenset[str]:
    """PATH 下全部可执行名 + 常用内建（进程生命周期内缓存）。"""
    cmds = set(_SHELL_BUILTINS)
    for d in os.environ.get("PATH", "").split(os.pathsep):
        try:
            cmds.update(os.listdir(os.path.expanduser(d)))
        except OSError:
            continue
    return frozenset(cmds)


class OtCompleter(Completer):
    """REPL 输入补全：首词补命令名（PATH+内建），参数位补路径，
    `/` 开头补斜杠命令（附说明 meta），/target 与 /system 连参数一起补。"""

    def __init__(self, target_names: Callable[[], list[str]] | None = None):
        self._target_names = target_names or (lambda: [])
        self._paths = PathCompleter(expanduser=True)

    def get_completions(self, document, complete_event):  # noqa: ANN001, ANN202
        text = document.text_before_cursor
        if text.startswith("/"):
            yield from self._complete_slash(text)
            return
        if not text or " " not in text:
            # 首词：命令名补全（终端双 Tab 的行为）
            frag = text
            for name in sorted(_path_commands()):
                if name.startswith(frag):
                    yield Completion(name, start_position=-len(frag))
            return
        # 参数位：路径补全。PathCompleter 把整段 text_before_cursor 当路径，
        # 所以只把最后一个空格后的片段作为子文档喂给它（含尾随空格的空片段，
        # rsplit 保住空串 → 列当前目录，与终端双 Tab 一致）
        frag = text.rsplit(" ", 1)[-1]
        sub_doc = Document(frag, len(frag))
        yield from self._paths.get_completions(sub_doc, complete_event)

    def _complete_slash(self, text: str):
        if " " not in text:
            # 斜杠命令名补全（str.split 丢尾随空格，故先用无空格分支判定）
            for cmd, meta in _SLASH_META.items():
                if cmd.startswith(text):
                    yield Completion(cmd, start_position=-len(text),
                                     display=cmd, display_meta=meta)
            return
        head, frag = text.split(" ", 1)
        if head == "/target":
            for name in sorted(set(["local"] + self._target_names())):
                if name.startswith(frag):
                    yield Completion(name, start_position=-len(frag))
        elif head == "/system":
            for name in MANUAL_PRESETS:
                if name.startswith(frag):
                    yield Completion(name, start_position=-len(frag))


def _target_names_for_completion() -> list[str]:
    """/target 的补全集：与 _choose_target 的可选列表一致。"""
    try:
        return ["local"] + [t.name for t in load_saved_targets()] + list_ssh_hosts()
    except Exception:
        return ["local"]


async def _prompt_text_async(text: str, completer=None) -> str:
    session = _make_prompt_session(completer)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: session.prompt(text))


async def _prompt_text(text: str, default: str = "") -> str:
    session = PromptSession()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: session.prompt(text, default=default))


def _erase_lines(rows: int) -> None:
    """向上擦除 rows 行屏幕内容；非 TTY（测试/管道）空操作。

    审批面板与选择行在决策完成后擦除，界面只保留“执行”面板与真实结果。
    """
    if not render.console.is_terminal or rows <= 0:
        return
    render.console.file.write("\x1b[1A\x1b[2K" * rows)
    render.console.file.flush()


async def _prompt_choice() -> str:
    from prompt_toolkit.validation import Validator

    session = PromptSession()
    loop = asyncio.get_running_loop()

    def _ask() -> str:
        # 选项写进提示行（单行），配合 validator：非法输入原地重绘不占新行，
        # 决策后正好只擦一行
        return session.prompt(
            "y 执行 · e 编辑 · n 拒绝 · a 本会话始终允许 › ",
            validator=Validator.from_callable(
                lambda t: t.strip().lower() in {"y", "e", "n", "a"},
                error_message="请输入 y / e / n / a",
            ),
        )

    choice = (await loop.run_in_executor(None, _ask)).strip().lower()
    _erase_lines(1)  # 选择行用完即擦，避免残留在后续输出上方
    return choice
