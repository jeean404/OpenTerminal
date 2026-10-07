"""嵌套会话（ssh 跳板机 / su - / 预置命令嵌套 ssh）修复回归测试。

覆盖三块：
1. parse_probe 对「探测行整行回显混进收集缓冲」的鲁棒性——嵌套换壳
   注入的根因（真机：跳板机→目标机后自然语言整链无声失败）；
2. _PASSWORD_PROMPT_RE 对现代 OpenSSH 客户端提示符 `(user@host)
   Password:` 与中文 `密码：/口令：` 的匹配（密码模态代答 + 自然语言
   透传的触发前提）；
3. PipelineCore 嵌套密码目标解析（_nested_ssh_target）与自然语言在
   密码提示符前的透传闸（_on_frontend_line 的 _pw_prompt_seen 分支）。
"""
import asyncio

import openterminal.core as cmod
from openterminal.core import PipelineCore
from openterminal.shell_integration import parse_probe, probe_command
from openterminal.shell_session import _PASSWORD_PROMPT_RE


def _bare_core(**attrs) -> PipelineCore:
    """绕过 __init__ 的最小核心对象（只挂被测路径所需的属性）。"""
    c = object.__new__(PipelineCore)
    for k, v in attrs.items():
        setattr(c, k, v)
    return c


# --- 1. parse_probe：回显鲁棒性 ------------------------------------------

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


# --- 2. 密码提示符正则 ----------------------------------------------------

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


# --- 3. 嵌套目标解析 + 密码提示符透传闸 ----------------------------------

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
    assert c._pw_prompt_host() == ("10.0.0.20", "wujian")
    c = _bare_core(
        _pw_tail=bytearray(b"wujian@10.0.0.20's password: "))
    assert c._pw_prompt_host() == ("10.0.0.20", "wujian")
    c = _bare_core(_pw_tail=bytearray(b"[sudo] password for wujian: "))
    assert c._pw_prompt_host() == (None, None)


def test_frontend_line_passthrough_on_password_prompt():
    """密码提示符在前台时自然语言整行必须透传：只补发回车，不起任务、
    不动终端（真机：预置命令 ssh 跳板机到讨密码时，中文密码被误判成
    自然语言 → 登录被 \\x03 掉）。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c = _bare_core(session=_Session(), _exec_future=None,
                   _pw_prompt_seen=True, _pw_verifying=False, _pw_hold=[],
                   _open_cmds={})
    asyncio.run(c._on_frontend_line("帮我看下当前目录有什么文件", False))
    assert sent == [b"\r"]


# --- 4. \x03 后 ^C 回显吞除（「奇怪符号+c」）-----------------------------

import time as _time


def _armed_core() -> PipelineCore:
    return _bare_core(_intr_swallow_until=_time.monotonic() + 10.0,
                      _intr_pending=b"")


def test_strip_intr_echo_exact_two_bytes():
    """bash 在半行尾回显 "^C"：恰好吞这两字节，换行与提示符照常透传。"""
    c = _armed_core()
    assert c._strip_intr_echo("查看backend资源^C\r\n# ".encode()) == \
        "查看backend资源\r\n# ".encode()
    # 吞完即解除武装：后续字面 ^C 不再吞
    assert c._intr_swallow_until == 0.0
    assert c._strip_intr_echo(b"^C") == b"^C"


def test_strip_intr_echo_cross_chunk_caret():
    """"^" 与 "C" 分属两块：悬置跨块匹配；非 C 开头原样放回不丢字面 ^。"""
    c = _armed_core()
    assert c._strip_intr_echo(b"abc^") == b"abc"
    assert c._strip_intr_echo(b"C\r\n") == b"\r\n"
    c = _armed_core()
    assert c._strip_intr_echo(b"abc^") == b"abc"
    assert c._strip_intr_echo(b"x\r\n") == b"^x\r\n"   # 不是回显：放回


def test_strip_intr_echo_expiry_releases_pending():
    """窗口过期（zsh 不回显 ^C）：悬置的块尾 ^ 原样补放，零丢字节。"""
    c = _bare_core(_intr_swallow_until=_time.monotonic() - 1.0,
                   _intr_pending=b"^")
    assert c._strip_intr_echo(b"next") == b"^next"
    assert c._intr_swallow_until == 0.0


# --- 5. 密码重讨模态 + 验证窗口输入 hold + 分析卡时机 ---------------------

def _pw_core(session) -> PipelineCore:
    """密码状态机 + submit 链所需属性齐备的最小核心（ssh 帧开着、内层
    提示符标记在位 = 嵌套会话已登录态）。"""
    return _bare_core(
        session=session, _exec_future=None, _closed=False, _session_dead=False,
        _pw_tail=bytearray(), _pw_prompt_seen=False, _pw_verifying=False,
        _pw_verify_at=0.0, _pw_hold=[], _pw_hold_timer=None, _pw_at_end=False,
        _pw_modal_open=False, _pw_dismiss_timer=None,
        _nested_pw_attempts=0, _nested_pw_ctx=None,
        _open_cmds={1: "ssh wujian@1.2.3.4"}, _open_cmd_at={1: 10.0},
        _exec_stack=[], _last_mark_at=11.0, _interactive=True,
        _hook_gone=False, _hook_report_pending=None, _fallback_task=None)


def test_password_reprompt_retriggers_modal():
    """输错后 ssh 重讨（deny+prompt 常被隧道合包成一块）：上升沿必须复现模态。

    旧实现 search 取首匹配——首次应答后旧提示符永躺尾窗，at_end 恒 False →
    重讨永不触发、模态不再弹（真机根因）。第二次起一律弹窗（不自动填充）。"""
    sent: list[bytes] = []
    msgs: list = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c = _pw_core(_Session())

    async def _emit(m):
        msgs.append(m)
    c.emit_msg = _emit
    orig = cmod.load_password
    cmod.load_password = lambda host, user, port: None

    async def main():
        c._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        assert sum(m.type == "ask_password" for m in msgs) == 1
        await c._on_nested_password("wrongpw", False)
        assert c._pw_verifying and not c._pw_prompt_seen
        c._detect_password_prompt(
            b"\r\nPermission denied, please try again.\r\n"
            b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        assert sum(m.type == "ask_password" for m in msgs) == 2
        assert c._pw_verifying   # 重讨在场：验证窗口继续 hold 输入
    try:
        asyncio.run(main())
    finally:
        cmod.load_password = orig


def test_autofill_hits_default_port_alias_key():
    """档案流记住的密码落在 ``user@host:22`` 键：嵌套 ssh 无 -p（port=None）
    必须别名命中——否则「档案登录成功过、嵌套 ssh 仍弹窗重讨」（真机根因）。"""
    sent: list[bytes] = []
    msgs: list = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c = _pw_core(_Session())

    async def _emit(m):
        msgs.append(m)
    c.emit_msg = _emit
    seen: list = []
    orig = cmod.load_password

    def _fake_load(host, user, port):
        seen.append((host, user, port))
        return "savedpw" if port == 22 else None
    cmod.load_password = _fake_load

    async def main():
        c._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        assert sent == [b"savedpw\r"]          # 别名命中：自动填充而非弹窗
        assert not any(m.type == "ask_password" for m in msgs)
    try:
        asyncio.run(main())
    finally:
        cmod.load_password = orig
    assert seen[:2] == [("1.2.3.4", "wujian", None), ("1.2.3.4", "wujian", 22)]


def test_modal_dismissed_when_prompt_consumed():
    """密码提示符被终端手输消费（登录横幅冲出尾窗结尾）：陈旧模态防抖代关；
    防抖窗内重讨（at_end 回 True）取消代关、模态继续等应答（真机：ssh 早已
    成功、模态仍悬在 root 提示符上讨密码）。"""
    msgs: list = []

    class _Session:
        async def send_raw(self, data):
            pass

    c = _pw_core(_Session())

    async def _emit(m):
        msgs.append(m)
    c.emit_msg = _emit
    orig = cmod.load_password
    cmod.load_password = lambda host, user, port: None
    wait = cmod._PW_MODAL_DISMISS + 0.15

    async def main():
        c._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        assert sum(m.type == "ask_password" for m in msgs) == 1
        assert c._pw_modal_open
        # 防抖窗内重讨：代关取消，模态保住
        c._detect_password_prompt(b"denied\r\n")
        c._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(wait)
        assert not any(m.type == "ask_password_dismiss" for m in msgs)
        assert c._pw_modal_open
        # 终端手输消费提示符：登录横幅后防抖代关
        c._detect_password_prompt(b"\r\nLast login: Tue Oct  6\r\n"
                                  b"[wujian@host ~]$ ")
        await asyncio.sleep(wait)
        assert sum(m.type == "ask_password_dismiss" for m in msgs) == 1
        assert not c._pw_modal_open
    try:
        asyncio.run(main())
    finally:
        cmod.load_password = orig


def test_input_held_during_verify_and_flushed_after_login():
    """验证窗口（密码已提交、auth 结果未到）hold 全部前端输入；重讨继续
    hold；登录成功输出后按原序释放（真机：模态刚关抢跑的 sudo su -/cd /tmp
    落进 ssh 输入队列被当下一条密码吃掉）。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c = _pw_core(_Session())
    wait = cmod._PW_HOLD_RELEASE + 0.15

    async def main():
        await c._on_nested_password("pw1", False)
        await c._on_keys(b"sudo su -\r")
        await c._on_keys(b"cd /tmp\r")
        assert sent == [b"pw1\r"]            # 抢跑按键被 hold
        # deny+prompt 分两块到（合包拆开）：防抖释放必须被重讨取消
        c._detect_password_prompt(b"Permission denied, please try again.\r\n")
        c._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(wait)
        assert sent == [b"pw1\r"]
        await c._on_nested_password("pw2", False)
        c._detect_password_prompt(
            b"\r\nLast login: Tue Oct  6\r\n[wujian@host ~]$ ")
        await asyncio.sleep(wait)
        assert sent == [b"pw1\r", b"pw2\r", b"sudo su -\r", b"cd /tmp\r"]
    asyncio.run(main())


def test_held_nl_replay_sends_full_line():
    """验证窗口 hold 的自然语言行：字符当时不在 shell buffer，回放走健康
    路径必须补发整行+回车（只补 \\r 会提交空行）。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c = _pw_core(_Session())

    async def main():
        await c._on_nested_password("pw1", False)
        await c._on_frontend_line("帮我看下当前目录有什么文件", False)
        assert sent == [b"pw1\r"]            # 整行被 hold，未透传
        c._detect_password_prompt(b"\r\nLast login: x\r\n[wujian@host ~]$ ")
        await asyncio.sleep(cmod._PW_HOLD_RELEASE + 0.15)
        assert sent[-1] == "帮我看下当前目录有什么文件\r".encode()
        assert c._hook_report_pending == "帮我看下当前目录有什么文件"
        c._hook_report_pending = None   # 兜底任务醒来即退
    asyncio.run(main())


def test_modal_cancel_ends_verify_window():
    """嵌套密码模态取消/点遮罩：改终端手输，立即退出验证窗口（否则手输
    密码被 hold 到超时）；已 hold 的抢跑输入不丢，auth 结束后仍释放。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c = _pw_core(_Session())

    async def main():
        await c._on_nested_password("pw1", False)
        await c._on_keys(b"x")                      # 抢跑按键被 hold
        await c.feed_msg(cmod.ClientMsg(
            type="auth", auth_kind="nested_password_cancel", text=""))
        assert not c._pw_verifying
        await c._on_keys(b"y")                      # 手输密码直通
        assert sent == [b"pw1\r", b"y"]
        c._detect_password_prompt(b"\r\nLast login: x\r\n$ ")
        await asyncio.sleep(cmod._PW_HOLD_RELEASE + 0.15)
        assert sent == [b"pw1\r", b"y", b"x"]
    asyncio.run(main())


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
    c._ensure_agent = _boom

    asyncio.run(c._run_task("hi", hooked=True))
    assert order == ["task_start", "agent_build", "error"]
