"""CLI 前端：主菜单 / 主机管理 + 单管线终端（term_frontend）。

选定连接目标后进入 TermFrontend 单管线终端：输入即终端（PTY 直通），
自然语言直接交给 AI，/help 查看命令（/target /system /clear /model /exit
等斜杠命令由核心 core.py 统一承接）。
"""

from __future__ import annotations

import asyncio
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
    RenameConflictError, TargetList, build_target_list, delete_saved_target,
    display_name, load_saved_targets, parse_user_at_host,
    rename_saved_target, upsert_saved_target,
)
from .policy import Policy
from .secrets_store import delete_password, store_password
from .term_frontend import CliCore, TermFrontend

# 全屏/会话接管不再需要 CLI 白名单：单管线前端是整条真终端直通
# （PTY 字节原样进出），vim/top/tmux 等全屏程序天然原生，零登记。


_ADD_NEW = "__add_new__"    # 管理主机里「添加主机」的哨兵键
_BACK = "__back__"          # 各菜单「返回」项（避免与用户主机名撞 key）


def picker_rows(tl: TargetList) -> list[tuple[str | None, str]]:
    """连接目标列表：(key, label)；key 为 None 的行只展示不参与选择。

    添加/编辑/删除归「管理主机」，这里只列可连目标。
    """
    rows: list[tuple[str | None, str]] = [("local", "local（本机终端）")]
    if tl.direct:
        rows.append((None, "── 直接连接 ──"))
        rows.extend((t.name, t.name) for t in tl.direct)
    rows.append((_BACK, "返回"))
    return rows




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


class Cli:
    def __init__(self, cfg: Config, initial_target: str | None = None) -> None:
        self.cfg = cfg
        self.initial_target = initial_target
        self.policy = Policy(
            mode=cfg.policy.mode, auto_extra=cfg.policy.auto_extra,
            approve_extra=cfg.policy.approve_extra, deny_extra=cfg.policy.deny_extra,
        )
        # 本次会话里由用户手敲 user@host 临时注册的目标（连接成功后询问是否记住）
        self._adhoc_targets: set[str] = set()
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

    async def _maybe_remember(self, name: str, core=None) -> None:
        """手敲的 user@host 连接成功后询问是否记住。

        元数据存 ~/.openterminal/connections.db、密码走系统凭据库，都不入
        git。core 为本次运行的 CliCore——单管线下会话挂在核心上，实际使用
        的密码从 core.session.last_password 读；连接未成功（connected 未置位
        或 core 缺失）不打扰用户，adhoc 名字保留、下次成功连接后可再询问。
        """
        if name not in self._adhoc_targets:
            return
        if core is None or not core.connected.is_set():
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
        upsert_saved_target(name=disp, host=target.host,
                            port=target.port, user=target.user)
        # 密码走系统凭据库（Windows 凭据管理器 / macOS Keychain / Linux
        # Secret Service），明文不落库；本连接未用到密码（密钥认证）或
        # 凭据库不可用时跳过
        pw = getattr(getattr(core, "session", None), "last_password", None)
        note = ""
        if pw is not None:
            if store_password(target.host, target.user, target.port, pw):
                note = "，密码已存入系统凭据库"
            else:
                note = "（本机无可用凭据库，密码未存，下次仍需输入）"
        render.console.print(
            f"[green]已记住 {disp}[/] "
            f"[dim]（~/.openterminal/connections.db{note}）[/]")

    async def _pick_startup_target(self) -> str | None:
        """连接目标选择（光标菜单）：local · 直接连接。
        添加/编辑/删除在「管理主机」；取消或「返回」返回 None（回主菜单）。"""
        while True:
            rows = picker_rows(build_target_list())
            pick = await pick_menu("选择连接目标：", rows)
            if pick is None or pick == _BACK:
                return None  # 取消或「返回」→ 回主菜单
            if pick == "local":
                return "default"
            return pick  # 记住的直接连接

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
        name = display_name(host, user, port)
        upsert_saved_target(name=name, host=host, port=port, user=user)
        self._sync_saved_targets()
        render.console.print(f"[green]已添加主机 {name}[/]")
        return name

    async def _edit_saved_host(self, name: str) -> bool:
        """编辑已存主机：重敲 user@host[:port]，单事务替换存储条目并同步
        cfg.targets；地址变了顺手清旧 keyring 凭据（不留孤儿密码）。
        留空/取消/撞名返回 False。"""
        saved = load_saved_targets()
        target = next((t for t in saved if t.name == name), None)
        if target is None:
            return False
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
        try:
            removed = rename_saved_target(name, name=new_label, host=host,
                                          port=port, user=user)
        except RenameConflictError:
            render.console.print(f"[yellow]名称 {new_label} 已被另一条连接占用。[/]")
            return False
        if removed is not None and (removed.host, removed.user, removed.port) != (host, user, port):
            # 地址变了：旧凭据已无意义，清掉（与 Web 端 edit_saved 同规则）
            delete_password(removed.host, removed.user, removed.port)
        self._sync_saved_targets()
        render.console.print(f"[green]已更新主机 {old_label} → {new_label}[/]")
        return True

    async def _delete_saved_host(self, name: str) -> None:
        """删除已存主机，并同步清掉它的 keyring 凭据（不留孤儿密码）。"""
        removed = delete_saved_target(name)
        if removed is not None:
            delete_password(removed.host, removed.user, removed.port)
        self._sync_saved_targets()

    async def _manage_saved_host(self, name: str) -> None:
        """单个已存主机：编辑 / 删除 / 返回（按名字定位，不受列表变动影响）。"""
        target = next((t for t in load_saved_targets() if t.name == name), None)
        if target is None:
            return
        label = _host_label(target)
        act = await pick_menu(f"主机 {label}", [
            ("edit", "编辑"),
            ("delete", "删除"),
            (_BACK, "返回"),
        ])
        if act == "edit":
            await self._edit_saved_host(name)
        elif act == "delete":
            try:
                ans = (await _prompt_text(
                    f"删除该主机 {label}？[y/N]: ")).strip().lower()
            except EOFError:
                ans = ""
            if ans in {"y", "yes"}:
                await self._delete_saved_host(name)
                render.console.print(f"[green]已删除主机 {label}[/]")

    async def _manage_hosts(self) -> None:
        """管理主机：列出已存主机，支持添加/编辑/删除（光标菜单）。"""
        while True:
            saved = load_saved_targets()
            rows: list[tuple[str | None, str]] = [(None, "主机")]
            if saved:
                # 行键用主机名而非下标：菜单停留期间库被别处（Web/另一进程）
                # 增删时，下标会错位指到别人的条目
                rows.extend((("h", t.name), _host_label(t)) for t in saved)
            else:
                rows.append((None, "（还没有主机）"))
            rows.append((_ADD_NEW, "添加主机"))
            rows.append((_BACK, "返回"))

            pick = await pick_menu("管理主机", rows)
            if pick is None or pick == _BACK:
                return
            if pick == _ADD_NEW:
                await self._prompt_add_host()
                continue
            if isinstance(pick, tuple) and pick[0] == "h":
                await self._manage_saved_host(pick[1])
                continue

    async def _connect_via_picker(self) -> str | None:
        """经选择框选连接目标，返回目标名（连接由 _run_pipeline 进行，此处
        不再开 session）；取消或「返回」返回 None。连接失败时核心发 closed、
        _run_pipeline 返回后回主菜单，可重选目标。

        「是否记住手敲连接」的询问在 _run_pipeline 里、连接真正成功之后
        （_maybe_remember 需要 core.connected / core.session，选完目标时
        连接还没发生）。"""
        name = await self._pick_startup_target()
        if name is None:
            return None
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
        抛异常（未来 loop() 若在菜单里兜住异常）时核心也被关闭。

        管线结束后询问「是否记住手敲连接」——此时终端已复原，且能按
        core.connected 判断连接是否真的成功过（失败不打扰用户）。"""
        core = CliCore(self.cfg, name, frontend=None)   # 两段构造：反向注入
        frontend = TermFrontend(core)
        core._frontend = frontend
        try:
            await frontend.run()
        finally:
            await core.close()
        await self._maybe_remember(name, core)


async def _prompt_text(text: str, default: str = "") -> str:
    session = PromptSession()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: session.prompt(text, default=default))
