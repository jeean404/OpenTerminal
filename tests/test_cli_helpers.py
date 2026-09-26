import json

from openterminal.cli import is_interactive_command, is_streaming_command, prompt_text
from openterminal.sysprobe import SystemProfile


def test_interactive_detection():
    assert is_interactive_command("vim a.txt")
    assert is_interactive_command("sudo htop")
    assert not is_interactive_command("ls -la")
    assert not is_interactive_command("echo vim")


def test_interactive_vimdiff_and_view():
    # vimdiff/view 不在白名单会走哨兵 run：vim 不退出 → 挂满超时，
    # 期间 _busy=True 按键全被丢 → 「无法输入指令」
    assert is_interactive_command("vimdiff a.txt b.txt")
    assert is_interactive_command("view log.txt")


def test_interactive_fullscreen_monitors():
    # watch 是全屏 curses 程序（每秒清屏重绘），必须走透传给真实 xterm；
    # 走 cmdout 纯文本块时 CSI 清屏/光标定位被剥掉，每帧叠加成乱屏
    assert is_interactive_command("watch -n 1 top")
    assert is_interactive_command("watch -d ls -l")
    assert is_interactive_command("iotop")
    assert is_interactive_command("iftop")
    assert is_interactive_command("nethogs")
    assert is_interactive_command("atop")
    assert is_interactive_command("glances")


def test_interactive_su_and_sudo_shells():
    # 会话接管类命令必须判交互（走透传，不走哨兵 run）
    assert is_interactive_command("su")
    assert is_interactive_command("su -")
    assert is_interactive_command("su root")
    assert is_interactive_command("sudo su -")
    assert is_interactive_command("sudo -i")
    assert is_interactive_command("sudo -s")
    assert is_interactive_command("sudo --login")
    assert is_interactive_command("sudo bash")
    assert is_interactive_command("sudo -u root bash")
    assert is_interactive_command("bash")
    assert is_interactive_command("zsh")
    # 前导选项不挡 verb：sudo -E bash / sudo -H bash / sudo -E -u root bash
    assert is_interactive_command("sudo -E bash")
    assert is_interactive_command("sudo -H bash")
    assert is_interactive_command("sudo -E -u root bash")
    # 带 -c 的一次性 shell 与普通 sudo 不判交互
    assert not is_interactive_command("sudo bash -c 'echo hi'")
    assert not is_interactive_command("sudo ls -la")
    assert not is_interactive_command("sudo -u root id")
    assert not is_interactive_command("echo su")


def test_interactive_powershell():
    # Windows 上的嵌套 PowerShell 是交互程序，必须走透传（4.4-7）
    assert is_interactive_command("powershell")
    assert is_interactive_command("pwsh")
    assert is_interactive_command("powershell -ExecutionPolicy Bypass")
    assert is_interactive_command("sudo powershell")


def test_streaming_command_detection():
    # 长驻流式命令（日志 follow）：必须走无超时流式，不包哨兵 run
    assert is_streaming_command("docker logs -f web01")
    assert is_streaming_command("docker logs --follow web01")
    assert is_streaming_command("docker compose logs -f")
    assert is_streaming_command("podman logs -f web01")
    assert is_streaming_command("kubectl logs -f pod1")
    assert is_streaming_command("journalctl -f")
    assert is_streaming_command("tail -f /var/log/app.log")
    # -f 的「force」语义不误判
    assert not is_streaming_command("rm -f /tmp/x")
    assert not is_streaming_command("docker rm -f web01")
    assert not is_streaming_command("docker logs web01")      # 不带 -f 一次性
    assert not is_streaming_command("ls -la")
    assert not is_streaming_command("sudo systemctl restart nginx")


def test_prompt_text_basic():
    p = SystemProfile(host="prod-web", os_family="debian", distro="Ubuntu",
                      version="22.04", kernel="5", pkg_manager="apt",
                      service_mgr="systemd", shell="/bin/bash", tools={})
    text = prompt_text(p, type("S", (), {"cwd": "/tmp"})(), "deploy")
    assert "deploy@prod-web" in text
    assert "debian" in text and "/tmp" in text


def test_prompt_text_git_branch(tmp_path):
    import subprocess

    from openterminal.cli import prompt_text
    from openterminal.sysprobe import SystemProfile

    subprocess.run(["git", "init", "-b", "feature-x", str(tmp_path)],
                   capture_output=True, check=True)
    p = SystemProfile(host="local", os_family="darwin", distro="Local",
                      version="", kernel="", pkg_manager="brew",
                      service_mgr="launchd", shell="/bin/zsh", tools={})
    s = type("S", (), {"cwd": str(tmp_path)})()
    text = prompt_text(p, s, "u")
    assert "git:(feature-x)" in text


def test_prompt_text_no_git_outside_repo(tmp_path):
    from openterminal.cli import prompt_text
    from openterminal.sysprobe import SystemProfile

    p = SystemProfile(host="local", os_family="darwin", distro="Local",
                      version="", kernel="", pkg_manager="brew",
                      service_mgr="launchd", shell="/bin/zsh", tools={})
    s = type("S", (), {"cwd": str(tmp_path)})()
    assert "git:(" not in prompt_text(p, s, "u")


async def test_approval_eof_defaults_to_reject(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    async def boom():
        raise EOFError

    c = Cli(Config.load())
    monkeypatch.setattr(cli_mod, "_prompt_choice", boom)
    decision = await c._approval_decision("touch x")
    assert decision["type"] == "reject"


async def test_batch_approval_one_decision_per_request(monkeypatch):
    # 回归：模型一轮并行发起两个 approve 命令时，CLI 必须为每个 action
    # request 各收集一个决定再 resume；只给 1 个会被 HITL 中间件拒绝并打挂 REPL
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    async def yes():
        return "y"

    c = Cli(Config.load())
    monkeypatch.setattr(cli_mod, "_prompt_choice", yes)

    seen: dict = {}

    class FakeRunner:
        interrupt_payload = {
            "action_requests": [
                {"args": {"command": "touch a.txt"}},
                {"args": {"command": "touch b.txt"}},
            ]
        }

        async def resume(self, decisions):
            seen["decisions"] = decisions
            self.interrupt_payload = None
            return []

    presenter = c._make_presenter()
    await c._handle_events(FakeRunner(), [], presenter)
    decisions = seen["decisions"]
    assert len(decisions) == 2
    assert all(d["type"] == "approve" for d in decisions)
    # 两个命令各留一条审批记录
    rows = [json.loads(line) for line in c.transcript.path.read_text().splitlines()]
    assert [r["command"] for r in rows if r["kind"] == "approval"] == [
        "touch a.txt", "touch b.txt"]


async def test_batch_approval_reject_mixes_per_command(monkeypatch):
    # 两个命令逐个询问：第一个 y、第二个 n，决定按顺序带回模型
    import openterminal.cli as cli_mod
    from openterminal.cli import Cli
    from openterminal.config import Config

    answers = iter(["y", "n"])

    async def choose():
        return next(answers)

    c = Cli(Config.load())
    monkeypatch.setattr(cli_mod, "_prompt_choice", choose)

    seen: dict = {}

    class FakeRunner:
        interrupt_payload = {
            "action_requests": [
                {"args": {"command": "touch keep.txt"}},
                {"args": {"command": "touch drop.txt"}},
            ]
        }

        async def resume(self, decisions):
            seen["decisions"] = decisions
            self.interrupt_payload = None
            return []

    presenter = c._make_presenter()
    await c._handle_events(FakeRunner(), [], presenter)
    decisions = seen["decisions"]
    assert [d["type"] for d in decisions] == ["approve", "reject"]


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


async def test_pick_startup_target_jump_submenu(monkeypatch):
    # 经跳板机：选跳板机 → 子菜单选其下目标
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import save_jump_hosts, save_saved_targets

    monkeypatch.setattr("sys.platform", "linux")
    save_jump_hosts([JumpHost(name="bastion01", host="10.0.0.5", user="admin")])
    save_saved_targets([TargetConfig(name="web01", mode="ssh", host="10.0.0.20",
                                     user="root", jump="bastion01")])
    c = _make_cli()
    picks = iter(["bastion01", "web01"])

    async def pick(title, rows):
        return next(picks)

    monkeypatch.setattr(cli_mod, "pick_menu", pick)
    assert await c._pick_startup_target() == "web01"


async def test_pick_startup_target_cancel_returns_none(monkeypatch):
    # 光标菜单 Esc/q 取消 → 返回 None（回主菜单，不再 SystemExit）
    import openterminal.cli as cli_mod

    monkeypatch.setattr("sys.platform", "linux")
    c = _make_cli()

    async def cancel(title, rows):
        return None

    monkeypatch.setattr(cli_mod, "pick_menu", cancel)
    assert await c._pick_startup_target() is None


async def test_connect_via_picker_retries_after_failure(monkeypatch):
    # 连接失败（密码错/不可达）→ 报错并回到选择框，第二次成功；取消返回 False
    import openterminal.cli as cli_mod

    monkeypatch.setattr("sys.platform", "linux")
    c = _make_cli()
    picks = iter(["local", "local"])
    attempts = []

    async def pick(title, rows):
        return next(picks)

    monkeypatch.setattr(cli_mod, "pick_menu", pick)

    async def flaky_switch(name):
        attempts.append(name)
        if len(attempts) == 1:
            raise OSError("auth failed")

    monkeypatch.setattr(c, "switch_target", flaky_switch)
    assert await c._connect_via_picker() is True
    assert attempts == ["default", "default"]


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


async def test_switch_target_uses_stored_password(monkeypatch):
    # 连接记住的 SSH 目标：凭据库密码传给会话；密码失效现场重输后写回
    import openterminal.cli as cli_mod
    from openterminal.sysprobe import SystemProfile

    c = _make_cli()
    name = c._target_name_for("root@203.0.113.7")

    monkeypatch.setattr(cli_mod, "load_password",
                        lambda h, u, p: "old-pw")
    updated: dict = {}

    def fake_store(host, user, port, pw):
        updated.update(pw=pw)
        return True

    monkeypatch.setattr(cli_mod, "store_password", fake_store)

    seen: dict = {}

    class FakeSession:
        cwd = "/root"
        last_password = "new-pw"  # 旧密码失效后现场重输的新密码

        async def close(self):
            pass

    async def fake_open(target, password=None, **kw):
        seen["password"] = password
        return FakeSession()

    async def noop_remember(n):
        pass

    async def fake_probe(session, host):
        return SystemProfile(
            host=host, os_family="linux", distro="Debian", version="",
            kernel="", pkg_manager="apt", service_mgr="systemd",
            shell="/bin/bash", tools={})

    monkeypatch.setattr(cli_mod, "open_session", fake_open)
    monkeypatch.setattr(cli_mod, "load_host_cache", lambda p: {})
    monkeypatch.setattr(cli_mod, "save_host_cache", lambda *a, **k: None)
    monkeypatch.setattr(cli_mod, "probe_profile", fake_probe)
    monkeypatch.setattr(cli_mod, "build_agent", lambda *a, **k: (None, set(), None))
    monkeypatch.setattr(c, "_maybe_remember", noop_remember)

    await c.switch_target(name)
    assert seen["password"] == "old-pw"  # 凭据库密码优先于现场询问
    assert updated == {"pw": "new-pw"}   # 失效后重输的密码写回凭据库


async def test_switch_target_no_stored_password_prompts(monkeypatch):
    # 凭据库无记录：password=None 传下去，由 ssh_pty 现场询问
    import openterminal.cli as cli_mod
    from openterminal.sysprobe import SystemProfile

    c = _make_cli()
    name = c._target_name_for("root@203.0.113.7")

    monkeypatch.setattr(cli_mod, "load_password", lambda h, u, p: None)
    monkeypatch.setattr(cli_mod, "store_password",
                        lambda *a: (_ for _ in ()).throw(AssertionError(
                            "无凭据不应写库")))

    seen: dict = {}

    class FakeSession:
        cwd = "/root"
        last_password = None

        async def close(self):
            pass

    async def fake_open(target, password=None, **kw):
        seen["password"] = password
        return FakeSession()

    async def noop_remember(n):
        pass

    async def fake_probe(session, host):
        return SystemProfile(
            host=host, os_family="linux", distro="Debian", version="",
            kernel="", pkg_manager="apt", service_mgr="systemd",
            shell="/bin/bash", tools={})

    monkeypatch.setattr(cli_mod, "open_session", fake_open)
    monkeypatch.setattr(cli_mod, "load_host_cache", lambda p: {})
    monkeypatch.setattr(cli_mod, "save_host_cache", lambda *a, **k: None)
    monkeypatch.setattr(cli_mod, "probe_profile", fake_probe)
    monkeypatch.setattr(cli_mod, "build_agent", lambda *a, **k: (None, set(), None))
    monkeypatch.setattr(c, "_maybe_remember", noop_remember)

    await c.switch_target(name)
    assert seen["password"] is None


# --- 跳板机：层级子菜单与添加流程 ---

from openterminal.cli import (
    Cli, _ADD_JUMP, _ADD_NEW, _BACK, jump_submenu_rows,
    picker_rows,
)
from openterminal.config import Config, TargetConfig
from openterminal.connections import (
    JumpGroup, JumpHost, build_target_list, load_jump_hosts, load_saved_targets,
    save_jump_hosts, save_saved_targets,
)


def _sequence(values):
    it = iter(values)

    async def _prompt(text, default=""):
        return next(it)

    return _prompt


def test_picker_rows_groups():
    tl = build_target_list(
        saved=[
            TargetConfig(name="web01", mode="ssh", host="10.0.0.20", user="root",
                         jump="bastion01"),
            TargetConfig(name="prod", mode="ssh", host="p.example.com"),
        ],
        jumps=[JumpHost(name="bastion01", host="10.0.0.5", user="admin")],
    )
    rows = picker_rows(tl)
    keys = [k for k, _ in rows]
    assert keys[0] == "local"
    # 添加/编辑/删除归「管理主机」，连接列表不再带 _ADD_NEW/_ADD_JUMP
    assert _ADD_NEW not in keys and _ADD_JUMP not in keys
    assert "prod" in keys
    assert "bastion01" in keys
    assert any(label.startswith("[跳板机] bastion01") for k, label in rows)
    assert keys[-1] == _BACK  # 最后一项是「返回」
    # 分隔行不参与选择
    assert any(k is None for k in keys)


def test_jump_submenu_rows():
    group = JumpGroup(
        jump=JumpHost(name="bastion01", host="10.0.0.5", user="admin"),
        targets=[TargetConfig(name="web01", mode="ssh", host="10.0.0.20", user="root")],
    )
    rows = jump_submenu_rows(group)
    assert rows[0][0] == "web01"
    assert "root@10.0.0.20" in rows[0][1]
    assert rows[-1][0] == _BACK  # 只列目标 + 返回


def test_jump_submenu_empty_placeholder():
    group = JumpGroup(jump=JumpHost(name="b", host="10.0.0.5"), targets=[])
    rows = jump_submenu_rows(group)
    assert any(k is None and "还没有主机" in label for k, label in rows)


async def test_prompt_add_jump(monkeypatch):
    import openterminal.cli as cli_mod

    c = Cli(Config.load())
    monkeypatch.setattr(cli_mod, "_prompt_text",
                        _sequence(["admin@10.0.0.5"]))
    name = await c._prompt_add_jump()
    assert name == "admin@10.0.0.5"
    jumps = load_jump_hosts()
    assert [j.name for j in jumps] == ["admin@10.0.0.5"]
    assert jumps[0].host == "10.0.0.5"


async def test_prompt_add_jump_duplicate(monkeypatch):
    import openterminal.cli as cli_mod

    save_jump_hosts([JumpHost(name="admin@10.0.0.5", host="10.0.0.5", user="admin")])
    c = Cli(Config.load())
    monkeypatch.setattr(cli_mod, "_prompt_text",
                        _sequence(["admin@10.0.0.5"]))
    name = await c._prompt_add_jump()
    assert name == "admin@10.0.0.5"
    assert len(load_jump_hosts()) == 1  # 不重复添加


async def test_switch_target_writes_back_jump_password(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.sysprobe import SystemProfile

    save_jump_hosts([JumpHost(name="bastion01", host="10.0.0.5", user="admin")])
    save_saved_targets([TargetConfig(name="web01", mode="ssh", host="10.0.0.20",
                                     user="root", jump="bastion01")])
    c = Cli(Config.load())

    stored = {"target": "old", "jump": "old-j"}
    monkeypatch.setattr(cli_mod, "load_password",
                        lambda h, u, p: stored.get(
                            "jump" if h == "10.0.0.5" else "target"))
    updated = {}
    monkeypatch.setattr(cli_mod, "store_password",
                        lambda h, u, p, pw: updated.update(host=h, pw=pw) or True)

    class FakeSession:
        cwd = "/root"
        last_password = "new"
        last_jump_password = "new-j"

        async def close(self):
            pass

    async def fake_open(target, password=None, **kw):
        return FakeSession()

    async def noop_remember(n):
        pass

    async def fake_probe(session, host):
        return SystemProfile(host=host, os_family="linux", distro="Debian",
                             version="", kernel="", pkg_manager="apt",
                             service_mgr="systemd", shell="/bin/bash", tools={})

    monkeypatch.setattr(cli_mod, "open_session", fake_open)
    monkeypatch.setattr(cli_mod, "load_host_cache", lambda p: {})
    monkeypatch.setattr(cli_mod, "save_host_cache", lambda *a, **k: None)
    monkeypatch.setattr(cli_mod, "probe_profile", fake_probe)
    monkeypatch.setattr(cli_mod, "build_agent", lambda *a, **k: (None, set(), None))
    monkeypatch.setattr(c, "_maybe_remember", noop_remember)
    monkeypatch.setattr(c, "_maybe_remember_jump", noop_remember)

    await c.switch_target("web01")
    # 目标密码先写回、跳板机密码后写回，最后落的是跳板机
    assert updated == {"host": "10.0.0.5", "pw": "new-j"}


async def test_maybe_remember_keeps_jump(monkeypatch):
    # 回归：经跳板机手敲的目标「记住该连接」时，jump 字段必须随保存落盘
    import openterminal.cli as cli_mod

    c = Cli(Config.load())
    c._adhoc_targets.add("x")
    c.cfg.targets["x"] = TargetConfig(name="x", mode="ssh", host="10.0.0.20",
                                      user="root", jump="bastion01")
    c.session = type("S", (), {"last_password": None})()

    async def yes(text, default=""):
        return "y"

    monkeypatch.setattr(cli_mod, "_prompt_text", yes)
    await c._maybe_remember("x")
    saved = load_saved_targets()
    assert any(t.host == "10.0.0.20" and t.jump == "bastion01" for t in saved)


# --- 退出 ot：exit/quit/logout 不该被当命令发给远端 shell ---


def test_is_quit_line():
    from openterminal.cli import is_quit_line

    assert is_quit_line("exit")
    assert is_quit_line("exit 0")
    assert is_quit_line("quit")
    assert is_quit_line("logout")
    assert is_quit_line("/exit")
    assert is_quit_line("/quit")
    assert is_quit_line("!exit")
    assert is_quit_line("  exit  ")
    assert not is_quit_line("")
    assert not is_quit_line("ls -la")
    assert not is_quit_line("echo exit")
    assert not is_quit_line("exits")


async def test_loop_bare_exit_quits(monkeypatch):
    # 回归：REPL 里敲 exit 应退出 ot，而不是当普通命令发给远端 shell
    # （那样会杀掉登录 shell → 触发自动重连 → 重新要密码）
    import openterminal.cli as cli_mod

    c = Cli(Config.load())

    async def connect():
        return True

    c._connect_via_picker = connect

    async def main_menu(title, rows):
        return "connect"

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    closed = []

    class S:
        cwd = "/nonexistent"

        async def close(self):
            closed.append(1)

    c.session = S()

    prompts = iter(["exit"])

    async def prompt(text, **k):
        try:
            return next(prompts)
        except StopIteration:
            raise EOFError

    async def boom(*a, **k):
        raise AssertionError("exit 不应被当作命令执行")

    monkeypatch.setattr(cli_mod, "_prompt_text_async", prompt)
    monkeypatch.setattr(c, "run_direct_command", boom)
    monkeypatch.setattr(c, "_classify_with_indicator", boom)
    await c.loop()
    assert closed == [1]


# --- 交互式命令（vim / sudo su - / top…）自动进终端模式执行 ---


async def test_run_direct_interactive_enters_raw_with_command(monkeypatch):
    # 回归：sudo su - 这类交互命令不再只提示手动 Ctrl+R，而是自动进终端
    # 模式并把命令带进去（密码提示、root shell 都在透传里交互）
    import openterminal.cli as cli_mod

    c = Cli(Config.load())
    seen = {}

    async def fake_enter_raw(initial=None):
        seen["initial"] = initial

    monkeypatch.setattr(c, "_enter_raw", fake_enter_raw)
    c.session = type("S", (), {"run": lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("交互命令不应走哨兵 run"))})()
    await c.run_direct_command("sudo su -")
    assert seen["initial"] == b"sudo su -\r"


async def test_run_direct_noninteractive_runs_on_session(monkeypatch):
    # 非交互命令仍走哨兵 run，不进终端模式
    import openterminal.cli as cli_mod

    c = Cli(Config.load())

    async def fake_enter_raw(initial=None):
        raise AssertionError("非交互命令不应进终端模式")

    monkeypatch.setattr(c, "_enter_raw", fake_enter_raw)
    seen = {}

    async def fake_run(self, command, *, timeout=None, on_output=None):
        seen["command"] = command
        from openterminal.shell_session import CommandResult
        return CommandResult(output="ok", exit_code=0, truncated=False, cwd="/root")

    c.session = type("S", (), {"run": fake_run})()
    await c.run_direct_command("ls -la")
    assert seen["command"] == "ls -la"


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
    rows = [("a", "local"), (None, "── 跳板机 ──"), ("b", "bastion01")]
    frags = menu_fragments("管理主机", rows, selected=1)
    text = "".join(s for _, s in frags)
    assert "管理主机" in text and "── 跳板机 ──" in text
    sel = [f for f in frags if "▸" in f[1]]
    assert len(sel) == 1 and sel[0][0] == "class:menu-selected"
    assert "bastion01" in sel[0][1]


# --- 主菜单（loop 启动）---


async def test_loop_main_menu_exit_returns(monkeypatch):
    # 主菜单选「退出」→ loop 直接返回，不建会话
    import openterminal.cli as cli_mod

    c = Cli(Config.load())

    async def main_menu(title, rows):
        return "exit"

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    await c.loop()
    assert c.session is None


async def test_loop_main_menu_cancel_returns(monkeypatch):
    # 主菜单取消（Esc/q）→ 干净返回
    import openterminal.cli as cli_mod

    c = Cli(Config.load())

    async def main_menu(title, rows):
        return None

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    await c.loop()
    assert c.session is None


async def test_loop_main_menu_manage_then_exit(monkeypatch):
    # 主菜单先「管理主机」再「退出」→ 管理被调、随后退出
    import openterminal.cli as cli_mod

    c = Cli(Config.load())
    managed = []
    picks = iter(["manage", "exit"])

    async def main_menu(title, rows):
        return next(picks)

    async def manage():
        managed.append(1)

    monkeypatch.setattr(cli_mod, "pick_menu", main_menu)
    monkeypatch.setattr(c, "_manage_hosts", manage)
    await c.loop()
    assert managed == [1]
    assert c.session is None


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


async def test_manage_add_host_no_jump_prompt_when_no_jumps(monkeypatch):
    import openterminal.cli as cli_mod

    c = _make_cli()
    prompts = []

    async def text(prompt, default=""):
        prompts.append(prompt)
        return "root@1.2.3.4"

    monkeypatch.setattr(cli_mod, "_prompt_text", text)
    await c._prompt_add_host()
    assert len(prompts) == 1  # 只有地址输入，没有「经跳板机?」询问


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


async def test_manage_edit_jump_cascades_rename(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import (JumpHost, load_jump_hosts,
                                          load_saved_targets, save_jump_hosts,
                                          save_saved_targets)

    save_jump_hosts([JumpHost(name="b01", host="10.0.0.5", user="admin")])
    save_saved_targets([TargetConfig(name="web01", mode="ssh", host="10.0.0.20",
                                     user="root", jump="b01")])
    c = _make_cli()

    async def text(prompt, default=""):
        return "admin@10.0.0.6"

    monkeypatch.setattr(cli_mod, "_prompt_text", text)
    assert await c._edit_jump_host(0) is True
    assert load_jump_hosts()[0].name == "admin@10.0.0.6"
    assert load_saved_targets()[0].jump == "admin@10.0.0.6"  # 级联改名


async def test_manage_delete_jump_clears_saved_reference(monkeypatch):
    from openterminal.config import TargetConfig
    from openterminal.connections import (JumpHost, load_jump_hosts,
                                          load_saved_targets, save_jump_hosts,
                                          save_saved_targets)

    save_jump_hosts([JumpHost(name="b01", host="10.0.0.5", user="admin")])
    save_saved_targets([TargetConfig(name="web01", mode="ssh", host="10.0.0.20",
                                     user="root", jump="b01")])
    c = _make_cli()
    await c._delete_jump_host(0)
    assert load_jump_hosts() == []
    assert load_saved_targets()[0].jump is None  # 引用置空


async def test_manage_menu_rows_use_index_keys(monkeypatch):
    import openterminal.cli as cli_mod
    from openterminal.config import TargetConfig
    from openterminal.connections import (JumpHost, save_jump_hosts,
                                          save_saved_targets)

    save_saved_targets([TargetConfig(name="root@a", mode="ssh", host="a", user="root"),
                        TargetConfig(name="root@b", mode="ssh", host="b", user="root")])
    save_jump_hosts([JumpHost(name="b01", host="10.0.0.5", user="admin")])
    c = _make_cli()
    seen = {}

    async def pick(title, rows):
        seen["rows"] = rows
        return _BACK

    monkeypatch.setattr(cli_mod, "pick_menu", pick)
    await c._manage_hosts()
    keys = [k for k, _ in seen["rows"]]
    assert ("h", 0) in keys and ("h", 1) in keys
    assert ("j", 0) in keys
    assert _ADD_NEW in keys and _ADD_JUMP in keys and _BACK in keys
    assert any(k is None for k in keys)  # 分隔行不参与选择


def test_interactive_powershell_oneshot_forms():
    # 回归（P1 修复）：一次性执行形式不判交互/嵌套——
    # 此前只看首词，powershell -Command … 被当会话接管、输出被吞
    assert not is_interactive_command("powershell -Command Get-ChildItem")
    assert not is_interactive_command("pwsh -File a.ps1")
    assert not is_interactive_command("powershell a.ps1")
    assert not is_interactive_command("powershell -EncodedCommand YQ==")
    # 会话接管形式仍判交互
    assert is_interactive_command("powershell -NoExit -Command Get-Date")
    assert is_interactive_command("powershell -ExecutionPolicy Bypass")


# --- OtCompleter:终端风格 Tab 补全 -----------------------------------------

from prompt_toolkit.document import Document

from openterminal.cli import MANUAL_PRESETS, OtCompleter, _path_commands


def _completions(text, target_names=None):
    c = OtCompleter(lambda: target_names or [])
    return list(c.get_completions(Document(text, len(text)), None))


def _completed_lines(text, target_names=None):
    """模拟回车前把补全插进输入行，返回补全后的整行列表。

    PathCompleter 的语义是"后缀文本 + start_position 插入位"，直接断言
    .text 会漏掉光标前已输入的前缀。
    """
    lines = []
    for comp in _completions(text, target_names):
        i = len(text) + comp.start_position
        lines.append(text[:i] + comp.text + text[len(text):])
    return lines


def test_completer_slash_commands():
    texts = [x.text for x in _completions("/tar")]
    assert "/target" in texts and "/tar" not in texts
    # 精确命中也带出说明 meta
    hits = [x for x in _completions("/hel")]
    assert hits[0].text == "/help" and hits[0].display_meta_text == "帮助"


def test_completer_target_and_system_args():
    texts = [x.text for x in _completions("/target ", ["web-prod", "db-main"])]
    assert {"local", "web-prod", "db-main"} <= set(texts)
    texts = [x.text for x in _completions("/target web", ["web-prod", "db-main"])]
    assert texts == ["web-prod"]
    # /system 补方言预设
    assert set(x.text for x in _completions("/system ")) == set(MANUAL_PRESETS)


def test_completer_first_word_commands():
    # 首词从 PATH 补命令名
    texts = [x.text for x in _completions("ech")]
    assert "echo" in texts
    assert _path_commands()  # 缓存已构建且非空


def test_completer_path_completion_for_args(tmp_path, monkeypatch):
    (tmp_path / "source.txt").write_text("x")
    monkeypatch.chdir(tmp_path)
    lines = _completed_lines("python sou")
    assert "python source.txt" in lines
    # 空参数位（尾随空格）也列出当前目录条目
    lines = _completed_lines("python ")
    assert "python source.txt" in lines
