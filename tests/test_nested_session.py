"""嵌套会话回归测试（Task 10 拆分后保留跨域共享用例）。

覆盖四块：
1. parse_probe 对「探测行整行回显混进收集缓冲」的鲁棒性——嵌套换壳
   注入的根因（真机：跳板机→目标机后自然语言整链无声失败）；
2. _PASSWORD_PROMPT_RE 对现代 OpenSSH 客户端提示符 `(user@host)
   Password:` 与中文 `密码：/口令：` 的匹配（密码模态代答 + 自然语言
   透传的触发前提）；
3. 嵌套密码目标解析（NestedSshTracker：_nested_ssh_target /
   ssh_frame_host / sudo_pw_key，Task 10 自 test_core_components 并入）；
4. 跨组件时序：内层 ssh 提示符活性闩弛放、任务起跑先于 agent 构建
   （其余密码/认证用例已按域分流 tests/test_auth_flow.py）。
"""
import asyncio

import openterminal.core as cmod
from openterminal.core import PipelineCore
from openterminal.core.nested_ssh import NestedSshTracker
from openterminal.shell_integration import parse_probe, probe_command
from openterminal.session.base import _PASSWORD_PROMPT_RE

from tests.core_fakes import FakeCore, _bare_core


def _bare_core(**attrs) -> PipelineCore:
    """绕过 __init__ 的最小核心对象（只挂被测路径所需的属性）。"""
    c = object.__new__(PipelineCore)
    for k, v in attrs.items():
        setattr(c, k, v)
    return c


def test_parse_probe_skips_echoed_template():
    """嵌套 shell 场景：探测命令的整行回显先于真实输出进入缓冲。

    回显里字面 echo "__OTPROBE__${v:-none}|$d" 是第一个标记匹配——旧实现
    re.search 只取首个匹配且永远解析失败，探测必然超时 → 换壳注入整链
    失败。修复后须跳过模板、命中真实输出。"""
    buf = " \r" + probe_command("linux") + "\r\n" + "__OTPROBE__zsh5.9|-d\r\n"
    assert parse_probe(buf) == ("zsh", "-d")


def test_parse_probe_clean_output_still_works():
    """无回显（连接期 batch run）的原路径不回归。"""
    assert parse_probe("__OTPROBE__bash5.1.8(1)-release|-d\r\n") == ("bash", "-d")
    assert parse_probe("__OTPROBE__bash3.2|-d\r\n") == (None, "-d")
    assert parse_probe("") == (None, "-d")


def test_password_prompt_re_modern_openssh():
    """macOS/新版 OpenSSH 客户端提示 `(user@host) Password:`（旧正则漏配，
    嵌套 ssh 密码模态因此永不触发）。"""
    assert _PASSWORD_PROMPT_RE.search(b"(wujian@127.0.0.1) Password: ")
    assert _PASSWORD_PROMPT_RE.search(b"wujian@1.2.3.4's password: ")
    assert _PASSWORD_PROMPT_RE.search(b"[sudo] password for wujian: ")
    assert _PASSWORD_PROMPT_RE.search(b"\r\nPassword: ")
    assert _PASSWORD_PROMPT_RE.search("密码：".encode())
    assert _PASSWORD_PROMPT_RE.search(b"\xe5\xaf\x86\xe7\xa0\x81:")   # 密码:
    assert not _PASSWORD_PROMPT_RE.search(b"password policy updated\r\n")


def test_nested_ssh_target_parses_valued_options():
    """`ssh -p 2222 user@host` 的端口值不得被当成目标主机（真机复现出
    label='2222 密码: '）。"""
    c = _bare_core(_open_cmds={1: "ssh -p 2222 wujian@1.2.3.4 "
                                   "-o StrictHostKeyChecking=no"})
    assert c._nested_ssh_target() == ("1.2.3.4", "wujian", 2222)


def test_nested_ssh_target_basic_and_scp():
    c = _bare_core(_open_cmds={1: "ssh wujian@1.2.3.4"})
    assert c._nested_ssh_target() == ("1.2.3.4", "wujian", None)
    c = _bare_core(_open_cmds={1: "scp /tmp/a.tar wujian@1.2.3.4:/tmp/"})
    assert c._nested_ssh_target() == ("1.2.3.4", "wujian", None)


def test_nested_ssh_target_unparseable():
    """sudo / 非 ssh 类命令解析不出目标：密码仍可弹窗，只是「记住」无键。"""
    c = _bare_core(_open_cmds={1: "sudo pacman -Syu"})
    assert c._nested_ssh_target() == (None, None, None)


def test_nested_ssh_target_innermost_wins():
    """嵌套会话：外层 `ssh 跳板机` 帧始终开着，最内层 sudo 不得被外层
    ssh 帧兜底吸收（否则 sudo 密码会错填跳板机凭据）。"""
    c = _bare_core(_open_cmds={1: "ssh wujian@1.2.3.4",
                               2: "sudo pacman -Syu"})
    assert c._nested_ssh_target() == (None, None, None)


def test_pw_prompt_host_extracts_from_prompt():
    """凭据归属优先取提示符自带的 user@host（OpenSSH 新旧两种格式）。"""
    c = _bare_core(
        _pw_tail=bytearray(b"(wujian@10.0.0.20) Password: "))
    assert c.auth._pw_prompt_host() == ("10.0.0.20", "wujian")
    c = _bare_core(
        _pw_tail=bytearray(b"wujian@10.0.0.20's password: "))
    assert c.auth._pw_prompt_host() == ("10.0.0.20", "wujian")
    c = _bare_core(_pw_tail=bytearray(b"[sudo] password for wujian: "))
    assert c.auth._pw_prompt_host() == (None, None)


import time as _time


def test_inner_ssh_prompt_live_relaxes_latch():
    """嵌套 ssh 帧开着但内层提示符标记在位 → 健康路径放行（秒级降级是
    分析卡延迟根因）；su - / 未登录 / 内层前台命令仍锁降级。"""
    c = _bare_core(_open_cmds={1: "ssh wujian@1.2.3.4"},
                   _open_cmd_at={1: 10.0}, _last_mark_at=11.0)
    assert c._inner_ssh_prompt_live()
    c = _bare_core(_open_cmds={1: "su -"},
                   _open_cmd_at={1: 10.0}, _last_mark_at=11.0)
    assert not c._inner_ssh_prompt_live()    # 外族 PS1 假标记不得混入
    c = _bare_core(_open_cmds={1: "ssh wujian@1.2.3.4"},
                   _open_cmd_at={1: 10.0}, _last_mark_at=9.0)
    assert not c._inner_ssh_prompt_live()    # 开帧后无提示符标记（未登录）
    c = _bare_core(_open_cmds={1: "ssh wujian@1.2.3.4", 2: "top"},
                   _open_cmd_at={1: 10.0, 2: 12.0}, _last_mark_at=13.0)
    assert not c._inner_ssh_prompt_live()    # 最内层是内层前台命令


def test_task_start_precedes_agent_build():
    """task_start 先于 AI 栈导入/构建：首任务秒级 import 不得挡在分析卡
    出场前（真机「输完自然语言等几秒才出卡」根因）。"""
    order: list = []

    class _Tx:
        def append(self, *a, **k):
            pass

    c = _bare_core(transcript=_Tx(), _tool_idx_map={})

    async def emit_msg(m):
        order.append((m.event or {}).get("kind") or m.type)
    c.emit_msg = emit_msg

    def _boom():
        order.append("agent_build")
        raise RuntimeError("boom")
    c.ai._ensure_agent = _boom

    asyncio.run(c.ai._run_task("hi", hooked=True))
    assert order == ["task_start", "agent_build", "error"]


def test_tracker_constructs_standalone():
    t = NestedSshTracker(FakeCore())
    assert t is not None


def test_parse_ssh_cmd_target_host_user_port():
    line = "ssh wujian@1.2.3.4 -p 2222"
    host, user, port = NestedSshTracker.parse_ssh_cmd_target(line)
    assert (host, user, port) == ("1.2.3.4", "wujian", 2222)


def test_parse_ssh_cmd_target_non_ssh_is_none():
    assert NestedSshTracker.parse_ssh_cmd_target("sudo systemctl restart x") is None


def test_parse_ssh_cmd_target_scp_remote_path():
    line = "scp dist.tar.gz wujian@1.2.3.4:/tmp/"
    host, user, port = NestedSshTracker.parse_ssh_cmd_target(line)
    assert (host, user, port) == ("1.2.3.4", "wujian", None)


def test_nested_target_reads_innermost_open_cmds():
    core = FakeCore()
    core._open_cmds = {1: "ssh jump@10.0.0.1", 2: "sudo su -"}
    t = NestedSshTracker(core)
    # 最内层是 sudo（非 ssh 族）→ 不解析，绝不兜底到外层帧
    assert t.nested_ssh_target() == (None, None, None)


def test_ssh_frame_host_skips_non_ssh_frames():
    core = FakeCore()
    core._open_cmds = {1: "ssh wujian@1.2.3.4", 2: "sudo su -"}
    t = NestedSshTracker(core)
    # sudo 凭据键跳过非 ssh 帧向外找最近 ssh 帧（P1-3）
    assert t.ssh_frame_host() == "1.2.3.4"
    assert t.sudo_pw_key() == ("1.2.3.4", "sudo", None)
