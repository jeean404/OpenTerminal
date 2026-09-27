# --- 记住的连接（~/.openterminal/connections.toml，不入 git）---


def _make_cli():
    from openterminal.cli import Cli
    from openterminal.config import Config

    return Cli(Config.load())


async def test_maybe_remember_yes_saves_connection(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.connections import load_saved_targets

    c = _make_cli()
    name = c._target_name_for("root@203.0.113.7")
    assert name in c._adhoc_targets

    async def yes(prompt, default=""):
        assert "记住该连接" in prompt
        return "y"

    monkeypatch.setattr(cli_mod, "_prompt_text", yes)
    await c._maybe_remember(name)
    saved = load_saved_targets()
    assert [t.name for t in saved] == ["root@203.0.113.7"]
    assert (saved[0].host, saved[0].user, saved[0].port) == \
        ("203.0.113.7", "root", None)


async def test_maybe_remember_default_no_not_saved(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.connections import load_saved_targets

    c = _make_cli()
    name = c._target_name_for("root@203.0.113.7")

    async def no(prompt, default=""):
        return ""

    monkeypatch.setattr(cli_mod, "_prompt_text", no)
    await c._maybe_remember(name)
    assert load_saved_targets() == []


async def test_maybe_remember_skips_already_saved(monkeypatch):
    # 同 host/user/port 已记住：不再询问
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import load_saved_targets, save_saved_targets

    save_saved_targets([TargetConfig(
        name="root@203.0.113.7", mode="ssh",
        host="203.0.113.7", user="root", port=None)])

    c = _make_cli()
    name = c._target_name_for("root@203.0.113.7")

    async def boom(prompt, default=""):
        raise AssertionError("不应询问已记住的连接")

    monkeypatch.setattr(cli_mod, "_prompt_text", boom)
    await c._maybe_remember(name)
    assert len(load_saved_targets()) == 1


async def test_maybe_remember_ignores_config_targets(monkeypatch):
    # config.toml 里手写的目标 / 非本次手敲的连接不询问
    import openterminal.cli as cli_mod

    c = _make_cli()
    c.cfg.targets["prod"] = type("T", (), {
        "mode": "ssh", "host": "p.example.com", "user": None, "port": None})()

    async def boom(prompt, default=""):
        raise AssertionError("不应询问非手敲目标")

    monkeypatch.setattr(cli_mod, "_prompt_text", boom)
    await c._maybe_remember("prod")
    await c._maybe_remember("default")


async def test_pick_startup_target_defaults_local(monkeypatch):
    # 无记住连接：光标菜单默认 local
    import openterminal.cli as cli_mod

    monkeypatch.setattr("sys.platform", "linux")
    c = _make_cli()

    async def local(title, rows):
        return "local"

    monkeypatch.setattr(cli_mod, "pick_menu", local)
    assert await c._pick_startup_target() == "default"


async def test_pick_startup_target_selects_saved(monkeypatch):
    # 记住一条后：光标菜单选它
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import save_saved_targets

    monkeypatch.setattr("sys.platform", "linux")
    save_saved_targets([TargetConfig(
        name="root@a", mode="ssh", host="a", user="root", port=None)])

    c = _make_cli()

    async def pick(title, rows):
        assert any(k == "root@a" for k, _ in rows)
        return "root@a"

    monkeypatch.setattr(cli_mod, "pick_menu", pick)
    assert await c._pick_startup_target() == "root@a"


async def test_pick_startup_target_cancel_returns_none(monkeypatch):
    # 光标菜单 Esc/q 取消 → 返回 None（回主菜单，不再 SystemExit）
    import openterminal.cli as cli_mod

    monkeypatch.setattr("sys.platform", "linux")
    c = _make_cli()

    async def cancel(title, rows):
        return None

    monkeypatch.setattr(cli_mod, "pick_menu", cancel)
    assert await c._pick_startup_target() is None


async def test_connect_via_picker_returns_target_name(monkeypatch):
    # picker 选目标 → 返回目标名（连接改由 _run_pipeline 进行，不再开 session）；
    # 取消/「返回」→ None；成功路径同步 saved targets
    monkeypatch.setattr("sys.platform", "linux")
    c = _make_cli()
    picks = iter(["default", None])
    attempts = []

    async def pick():
        attempts.append(1)
        return next(picks)

    monkeypatch.setattr(c, "_pick_startup_target", pick)
    synced = []
    monkeypatch.setattr(c, "_sync_saved_targets", lambda: synced.append(1))
    assert await c._connect_via_picker() == "default"
    assert await c._connect_via_picker() is None
    assert len(attempts) == 2
    assert synced == [1]  # 取消路径不同步


async def test_saved_targets_registered_in_cli_targets():
    from openterminal.config import TargetConfig
    from openterminal.connections import save_saved_targets

    save_saved_targets([TargetConfig(
        name="root@a", mode="ssh", host="a", user="root", port=2222)])
    c = _make_cli()
    t = c.cfg.targets["root@a"]
    assert (t.host, t.user, t.port) == ("a", "root", 2222)


# --- 记住的密码（系统凭据库，不落 connections.toml 明文）---


async def test_maybe_remember_stores_password_in_keyring(monkeypatch):
    import openterminal.cli as cli_mod

    c = _make_cli()
    name = c._target_name_for("root@203.0.113.7")
    c.session = type("S", (), {"last_password": "s3cret"})()

    async def yes(prompt, default=""):
        return "y"

    captured: dict = {}

    def fake_store(host, user, port, pw):
        captured.update(host=host, user=user, port=port, pw=pw)
        return True

    monkeypatch.setattr(cli_mod, "_prompt_text", yes)
    monkeypatch.setattr(cli_mod, "store_password", fake_store)
    await c._maybe_remember(name)
    assert captured == {"host": "203.0.113.7", "user": "root",
                        "port": None, "pw": "s3cret"}


async def test_maybe_remember_key_auth_skips_keyring(monkeypatch):
    # 密钥认证成功：连接没用到密码，凭据库不该被写
    import openterminal.cli as cli_mod

    c = _make_cli()
    name = c._target_name_for("root@203.0.113.7")
    c.session = type("S", (), {"last_password": None})()

    async def yes(prompt, default=""):
        return "y"

    monkeypatch.setattr(cli_mod, "_prompt_text", yes)
    monkeypatch.setattr(cli_mod, "store_password",
                        lambda *a: (_ for _ in ()).throw(AssertionError(
                            "密钥认证不应写凭据库")))
    await c._maybe_remember(name)  # 不抛即通过


# --- 连接目标列表（picker_rows）---

from openterminal.cli import Cli, _ADD_NEW, _BACK, picker_rows
from openterminal.config import Config, TargetConfig
from openterminal.connections import (
    build_target_list, load_saved_targets, save_saved_targets,
)


def test_picker_rows_flat():
    tl = build_target_list(saved=[
        TargetConfig(name="web01", mode="ssh", host="10.0.0.20", user="root"),
        TargetConfig(name="prod", mode="ssh", host="p.example.com"),
    ])
    rows = picker_rows(tl)
    keys = [k for k, _ in rows]
    assert keys[0] == "local"
    # 添加/编辑/删除归「管理主机」，连接列表不带 _ADD_NEW
    assert _ADD_NEW not in keys
    assert "prod" in keys and "web01" in keys
    assert keys[-1] == _BACK  # 最后一项是「返回」
    # 分隔行不参与选择
    assert any(k is None for k in keys)


# --- 退出 ot：exit/quit/logout 不该被当命令发给远端 shell ---
# --- 光标菜单（prompt_toolkit Application）---


from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

from openterminal.cli import menu_fragments, pick_menu_sync


def _drive_menu(keys, rows, title="t"):
    with create_pipe_input() as inp:
        inp.send_text(keys)
        inp.close()
        return pick_menu_sync(title, rows, input=inp, output=DummyOutput())


def test_pick_menu_enter_selects_first():
    rows = [("a", "local"), (None, "── 直接连接 ──"), ("b", "host1")]
    assert _drive_menu("\r", rows) == "a"


def test_pick_menu_arrows_and_jk_skip_separators():
    rows = [("a", "local"), (None, "sep"), ("b", "h1"), ("c", "h2")]
    assert _drive_menu("\x1b[B\r", rows) == "b"          # ↓ 箭头
    assert _drive_menu("j\r", rows) == "b"               # j
    assert _drive_menu("\x1b[B\x1b[B\r", rows) == "c"    # 下下
    assert _drive_menu("jj\r", rows) == "c"


def test_pick_menu_up_wraps_to_last():
    rows = [("a", "local"), ("b", "h1"), ("c", "h2")]
    assert _drive_menu("k\r", rows) == "c"
    assert _drive_menu("\x1b[A\r", rows) == "c"


def test_pick_menu_cancel_keys():
    rows = [("a", "x")]
    for k in ("q", "\x1b", "\x03", "\x04"):  # q / Esc / Ctrl-C / Ctrl-D
        assert _drive_menu(k, rows) is None


def test_pick_menu_empty_selectable_returns_none():
    assert pick_menu_sync("t", [(None, "只有分隔行")], output=DummyOutput()) is None


def test_menu_fragments_highlight_and_separators():
    rows = [("a", "local"), (None, "── 直接连接 ──"), ("b", "host1")]
    frags = menu_fragments("管理主机", rows, selected=1)
    text = "".join(s for _, s in frags)
    assert "管理主机" in text and "── 直接连接 ──" in text
    sel = [f for f in frags if "▸" in f[1]]
    assert len(sel) == 1 and sel[0][0] == "class:menu-selected"
    assert "host1" in sel[0][1]


# --- loop / _run_pipeline（单管线换心）---


class _FakeCliCore:
    instances: list = []

    def __init__(self, cfg, name, frontend=None):
        self.cfg = cfg
        self.name = name
        self.frontend = frontend
        self.closed = False
        type(self).instances.append(self)

    async def close(self):
        self.closed = True


class _FakeFrontend:
    instances: list = []

    def __init__(self, core, **kw):
        self.core = core
        self.run_calls = 0
        type(self).instances.append(self)

    async def run(self):
        self.run_calls += 1


def _patch_pipeline(monkeypatch):
    """patch cli.CliCore / cli.TermFrontend 为记录桩（模块级 import 供测试替换）。"""
    import openterminal.cli as cli_mod

    _FakeCliCore.instances = []
    _FakeFrontend.instances = []
    monkeypatch.setattr(cli_mod, "CliCore", _FakeCliCore)
    monkeypatch.setattr(cli_mod, "TermFrontend", _FakeFrontend)


async def test_loop_menu_exit_returns(monkeypatch):
    # 主菜单选「退出」→ loop 直接返回，_run_pipeline 未被调
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    c = Cli(Config.load())
    _patch_pipeline(monkeypatch)

    async def main_menu(title, rows):
        return "exit"

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    await c.loop()
    assert _FakeCliCore.instances == []
    assert _FakeFrontend.instances == []


async def test_loop_connect_runs_pipeline_then_menu(monkeypatch):
    # 主菜单「连接主机」→ picker 拿到目标名 → _run_pipeline 以该名建
    # CliCore、run() 被 await、close() 被调；随后回主菜单
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    c = Cli(Config.load())
    _patch_pipeline(monkeypatch)
    picks = iter(["connect", "exit"])

    async def main_menu(title, rows):
        return next(picks)

    async def picker():
        return "web01"

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    monkeypatch.setattr(c, "_connect_via_picker", picker)
    await c.loop()
    assert [k.name for k in _FakeCliCore.instances] == ["web01"]
    assert [f.run_calls for f in _FakeFrontend.instances] == [1]
    assert _FakeCliCore.instances[0].closed


async def test_loop_initial_target_goes_direct(monkeypatch):
    # ot connect <目标>：不进主菜单直接 _run_pipeline；结束后回主菜单
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    _patch_pipeline(monkeypatch)
    picks = iter(["exit"])

    async def main_menu(title, rows):
        return next(picks)

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    c = Cli(Config.load(), initial_target="203.0.113.9")
    await c.loop()
    assert [k.name for k in _FakeCliCore.instances] == ["203.0.113.9"]


async def test_run_pipeline_returns_to_menu_on_closed(monkeypatch):
    # TermFrontend.run 立即返回（模拟 closed/EOF）→ _run_pipeline 结束 →
    # 回主菜单可再次连接；每次连接各建一个 CliCore 且 close 被调
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    c = Cli(Config.load())
    _patch_pipeline(monkeypatch)
    picks = iter(["connect", "connect", "exit"])

    async def main_menu(title, rows):
        return next(picks)

    async def picker():
        return "web01"

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    monkeypatch.setattr(c, "_connect_via_picker", picker)
    await c.loop()
    assert len(_FakeCliCore.instances) == 2
    assert all(k.closed for k in _FakeCliCore.instances)
    assert all(f.run_calls == 1 for f in _FakeFrontend.instances)


# --- 管理主机：添加 / 编辑 / 删除（断言 connections.toml 内容）---


async def test_manage_add_host_persists_and_dedups(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.connections import load_saved_targets

    c = _make_cli()

    async def text(prompt, default=""):
        return "root@1.2.3.4"

    monkeypatch.setattr(cli_mod, "_prompt_text", text)
    name = await c._prompt_add_host()
    assert name == "root@1.2.3.4"
    saved = load_saved_targets()
    assert [(t.host, t.user, t.port) for t in saved] == [("1.2.3.4", "root", None)]
    assert "root@1.2.3.4" in c.cfg.targets
    # 重复添加：去重，文件不变
    await c._prompt_add_host()
    assert len(load_saved_targets()) == 1


async def test_manage_add_host_single_prompt(monkeypatch):
    import openterminal.cli as cli_mod

    c = _make_cli()
    prompts = []

    async def text(prompt, default=""):
        prompts.append(prompt)
        return "root@1.2.3.4"

    monkeypatch.setattr(cli_mod, "_prompt_text", text)
    await c._prompt_add_host()
    assert len(prompts) == 1  # 只有地址输入一个询问


async def test_manage_edit_host_updates_toml_and_cfg(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import load_saved_targets, save_saved_targets

    save_saved_targets([TargetConfig(name="root@a", mode="ssh",
                                     host="a", user="root")])
    c = _make_cli()

    async def text(prompt, default=""):
        return "root@b"

    monkeypatch.setattr(cli_mod, "_prompt_text", text)
    assert await c._edit_saved_host(0) is True
    saved = load_saved_targets()
    assert [(t.name, t.host, t.user) for t in saved] == [("root@b", "b", "root")]
    assert "root@b" in c.cfg.targets
    assert "root@a" not in c.cfg.targets


async def test_manage_edit_host_does_not_clobber_config_target(monkeypatch):
    # 编辑记住的主机时，config.toml 手写的同名目标不被覆盖
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig as TC
    from openterminal.connections import save_saved_targets

    cfg = Config.load()
    cfg.targets["root@a"] = TC(name="root@a", mode="ssh",
                               host="cfg-host", user="cfg")
    c = Cli(cfg)  # __init__ 里记录 _config_target_names 含 "root@a"
    save_saved_targets([TC(name="saved-x", mode="ssh", host="a", user="root")])

    async def text(prompt, default=""):
        return "root@a"  # 新名字撞上 config 目标

    monkeypatch.setattr(cli_mod, "_prompt_text", text)
    await c._edit_saved_host(0)
    assert c.cfg.targets["root@a"].host == "cfg-host"  # config 目标未被覆盖


async def test_manage_host_delete_requires_confirm(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import load_saved_targets, save_saved_targets

    save_saved_targets([TargetConfig(name="root@a", mode="ssh",
                                     host="a", user="root")])
    c = _make_cli()

    async def delete_menu(title, rows):
        return "delete"

    monkeypatch.setattr(cli_mod, "pick_menu", delete_menu)

    async def no(prompt, default=""):
        return "n"

    monkeypatch.setattr(cli_mod, "_prompt_text", no)
    await c._manage_saved_host(0)
    assert len(load_saved_targets()) == 1  # n → 未删

    async def yes(prompt, default=""):
        return "y"

    monkeypatch.setattr(cli_mod, "_prompt_text", yes)
    await c._manage_saved_host(0)
    assert load_saved_targets() == []
    assert "root@a" not in c.cfg.targets


async def test_manage_menu_rows_use_index_keys(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import save_saved_targets

    save_saved_targets([TargetConfig(name="root@a", mode="ssh", host="a", user="root"),
                        TargetConfig(name="root@b", mode="ssh", host="b", user="root")])
    c = _make_cli()
    seen = {}

    async def pick(title, rows):
        seen["rows"] = rows
        return _BACK

    monkeypatch.setattr(cli_mod, "pick_menu", pick)
    await c._manage_hosts()
    keys = [k for k, _ in seen["rows"]]
    assert ("h", 0) in keys and ("h", 1) in keys
    assert _ADD_NEW in keys and _BACK in keys
    assert any(k is None for k in keys)  # 分隔行不参与选择
