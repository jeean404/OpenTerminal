"""认证流（core/auth.py AuthFlow）域测试：密码提示符/验证窗/模态/记忆/sudo 与嵌套 ssh 密码键（Task 10 自 test_web_worker/test_nested_session 分流）。"""

import asyncio
import openterminal.core as cmod
from openterminal.web.protocol import ClientMsg
from openterminal.core import PipelineCore
from tests.web_fakes import (_make_worker)
from tests.core_fakes import FakeCore, _bare_core


async def test_worker_auth_remember_stores_password(monkeypatch):
    # 认证弹窗勾选「记住」→ 密码写入 keyring（与重连 load_password 同一键）
    import openterminal.web.worker as wmod

    stored = []
    monkeypatch.setattr(wmod, "store_password",
                        lambda host, user, port, pw: stored.append((host, user, port, pw)))
    w, sink = await _make_worker(monkeypatch, target="web01")
    await asyncio.wait_for(w.connected.wait(), timeout=2)

    await w.handle_client(ClientMsg(type="auth", auth_kind="password",
                                    text="sekret", remember=True))
    assert stored == [("10.0.0.20", "root", None, "sekret")]
    # 不勾选 remember：不落库
    await w.handle_client(ClientMsg(type="auth", auth_kind="password", text="x"))
    assert stored == [("10.0.0.20", "root", None, "sekret")]
    # local 目标（default）不落库
    wl, _ = await _make_worker(monkeypatch, target="default")
    await asyncio.wait_for(wl.connected.wait(), timeout=2)
    await wl.handle_client(ClientMsg(type="auth", auth_kind="password",
                                     text="pw", remember=True))
    assert stored == [("10.0.0.20", "root", None, "sekret")]


async def test_worker_inline_password_remember_after_ready(monkeypatch):
    # 内联手输密码：登录成功后前端确认「记住」（password_remember，不携明文）
    # → 用登录时留档的密码写 keyring；无留档（凭据库自动登录）时为 no-op
    import openterminal.web.worker as wmod

    stored = []
    monkeypatch.setattr(wmod, "store_password",
                        lambda host, user, port, pw: stored.append((host, user, port, pw)))
    w, sink = await _make_worker(monkeypatch, target="web01")
    await asyncio.wait_for(w.connected.wait(), timeout=2)

    # 内联提交（remember=False，内联一律不即时记住）
    await w.handle_client(ClientMsg(type="auth", auth_kind="password",
                                    text="sekret", remember=False))
    assert stored == []
    # ready 后前端确认记住 → 落库的是登录时留档的密码
    await w.handle_client(ClientMsg(type="auth", auth_kind="password_remember",
                                    text=""))
    assert stored == [("10.0.0.20", "root", None, "sekret")]

    # 未手输过密码（无留档）：password_remember no-op
    w2, _ = await _make_worker(monkeypatch, target="web01")
    await asyncio.wait_for(w2.connected.wait(), timeout=2)
    await w2.handle_client(ClientMsg(type="auth", auth_kind="password_remember",
                                     text=""))
    assert stored == [("10.0.0.20", "root", None, "sekret")]


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
                   _pw_capture_key=None, _pw_typed=bytearray(),
                   _pw_remember_candidate=None,
                   _open_cmds={})
    asyncio.run(c.ai._on_frontend_line("帮我看下当前目录有什么文件", False))
    assert sent == [b"\r"]


def _pw_core(session) -> PipelineCore:
    """密码状态机 + submit 链所需属性齐备的最小核心（ssh 帧开着、内层
    提示符标记在位 = 嵌套会话已登录态）。"""
    return _bare_core(
        session=session, _exec_future=None, _closed=False, _session_dead=False,
        _pw_tail=bytearray(), _pw_prompt_seen=False, _pw_verifying=False,
        _pw_verify_at=0.0, _pw_hold=[], _pw_hold_timer=None, _pw_at_end=False,
        _pw_modal_open=False, _pw_dismiss_timer=None,
        _nested_pw_attempts=0, _nested_pw_ctx=None,
        _pw_capture_key=None, _pw_typed=bytearray(),
        _pw_remember_candidate=None, _pw_remember_pending=None,
        _pw_result_from=0,
        _target_host="1.2.3.4",
        _open_cmds={1: "ssh wujian@1.2.3.4"}, _open_cmd_at={1: 10.0},
        _exec_stack=[], _last_mark_at=11.0, _interactive=True,
        _hook_gone=False, _hook_report_pending=None, _fallback_task=None,
        # 回车看门狗状态：hook 陈旧判定 + 看门狗把手（_hook_ok 会读）
        _hook_stale=False, _hook_watch=None, _hook_watch_text=False,
        _display="agent")


def test_password_reprompt_retriggers_rising_edge():
    """输错后 ssh 重讨（deny+prompt 常被隧道合包成一块）：上升沿必须复现。

    无凭据时不再弹模态（真实终端语义：提示符已在终端里，用户手输）——
    但上升沿仍要每次重讨都走到 _on_nested_password_prompt（at_end 判定取
    最后一个匹配），否则凭据库后来存了密码也不会再自动填充。"""
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
        c.auth._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        assert c._nested_pw_attempts == 1
        assert not any(m.type == "ask_password" for m in msgs)
        await c.auth._on_nested_password("wrongpw", False)
        assert c._pw_verifying and not c._pw_prompt_seen
        c.auth._detect_password_prompt(
            b"\r\nPermission denied, please try again.\r\n"
            b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        assert c._nested_pw_attempts == 2, "重讨上升沿必须复现"
        assert not any(m.type == "ask_password" for m in msgs)
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
        c.auth._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        assert sent == [b"savedpw\r"]          # 别名命中：自动填充而非弹窗
        assert not any(m.type == "ask_password" for m in msgs)
    try:
        asyncio.run(main())
    finally:
        cmod.load_password = orig
    assert seen[:2] == [("1.2.3.4", "wujian", None), ("1.2.3.4", "wujian", 22)]


def test_first_hop_load_password_alias_matches_nested():
    """首跳（_connect 的 stored_pw）与嵌套共用 load_password_alias：
    同一密码落在 None 或 22 任一键上，另一侧读取也命中（P0-1——旧首跳
    _connect 直查单键，档案流存 :22、连接解析 None 时永远 miss，首跳
    每次重讨密码）。"""
    orig = cmod.load_password

    def _fake(host, user, port):
        return "pw-at-22" if port == 22 else None

    cmod.load_password = _fake
    try:
        assert cmod.load_password_alias("h", "u", None) == "pw-at-22"
        assert cmod.load_password_alias("h", "u", 22) == "pw-at-22"
    finally:
        cmod.load_password = orig

    def _fake2(host, user, port):
        return "pw-at-none" if port is None else None

    cmod.load_password = _fake2
    try:
        assert cmod.load_password_alias("h", "u", 22) == "pw-at-none"
        assert cmod.load_password_alias("h", "u", None) == "pw-at-none"
    finally:
        cmod.load_password = orig


def test_no_modal_on_prompt_cycle():
    """无凭据的密码提示符全程不弹模态、不代关（真实终端语义：提示符已在
    终端里，用户手输）。旧实现弹窗代答、手输消费提示符后再防抖代关——
    表现为弹框一闪而过（真机 2026-10-08）。"""
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
        c.auth._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(0)
        # 防抖窗内重讨
        c.auth._detect_password_prompt(b"denied\r\n")
        c.auth._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(wait)
        # 终端手输消费提示符：登录横幅
        c.auth._detect_password_prompt(b"\r\nLast login: Tue Oct  6\r\n"
                                  b"[wujian@host ~]$ ")
        await asyncio.sleep(wait)
        assert not any(m.type == "ask_password" for m in msgs)
        assert not any(m.type == "ask_password_dismiss" for m in msgs)
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
        await c.auth._on_nested_password("pw1", False)
        await c._on_keys(b"sudo su -\r")
        await c._on_keys(b"cd /tmp\r")
        assert sent == [b"pw1\r"]            # 抢跑按键被 hold
        # deny+prompt 分两块到（合包拆开）：防抖释放必须被重讨取消
        c.auth._detect_password_prompt(b"Permission denied, please try again.\r\n")
        c.auth._detect_password_prompt(b"wujian@1.2.3.4's password: ")
        await asyncio.sleep(wait)
        assert sent == [b"pw1\r"]
        await c.auth._on_nested_password("pw2", False)
        c.auth._detect_password_prompt(
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
        await c.auth._on_nested_password("pw1", False)
        await c.ai._on_frontend_line("帮我看下当前目录有什么文件", False)
        assert sent == [b"pw1\r"]            # 整行被 hold，未透传
        c.auth._detect_password_prompt(b"\r\nLast login: x\r\n[wujian@host ~]$ ")
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
        await c.auth._on_nested_password("pw1", False)
        await c._on_keys(b"x")                      # 抢跑按键被 hold
        await c.feed_msg(cmod.ClientMsg(
            type="auth", auth_kind="nested_password_cancel", text=""))
        assert not c._pw_verifying
        await c._on_keys(b"y")                      # 手输密码直通
        assert sent == [b"pw1\r", b"y"]
        c.auth._detect_password_prompt(b"\r\nLast login: x\r\n$ ")
        await asyncio.sleep(cmod._PW_HOLD_RELEASE + 0.15)
        assert sent == [b"pw1\r", b"y", b"x"]
    asyncio.run(main())


def _remember_core(session, *, open_cmds, target_host="10.0.0.11"):
    c = _pw_core(session)
    c._open_cmds = dict(open_cmds)
    c._target_host = target_host
    msgs: list = []
    stored: list = []

    async def _emit(m):
        msgs.append(m)

    c.emit_msg = _emit
    return c, msgs, stored


def _patch_pw_io(monkeypatch, stored, *, load=None):
    monkeypatch.setattr(cmod, "load_password",
                        load or (lambda h, u, p: None))
    monkeypatch.setattr(
        cmod, "store_password",
        lambda h, u, p, pw: stored.append((h, u, p, pw)) or True)


def test_sudo_typed_password_offers_remember_and_stores_sudo_key(monkeypatch):
    """P1-3：sudo/su 类无主机提示符——手输 → 验证成功 → 询问「记住」→
    同意后以 sudo@<最近 ssh 帧主机> 专用键落库（绝不与 ssh 登录凭据
    user@host 混键）。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh pe@10.0.0.10", 2: "sudo su -"})
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"[sudo] password for pe: ")
        await asyncio.sleep(0)
        # 落键 = sudo@<最近 ssh 帧目标>（sudo 就跑在那台机上），非会话
        # 目标主机（那是跳板），更不是 ssh 键 pe@…
        assert c._pw_capture_key == ("10.0.0.10", "sudo", None)
        await c._on_keys(b"s3cret\r")
        assert sent == [b"s3cret\r"]            # 手输照常直达远端
        assert c._pw_verifying                  # 回车即进验证窗
        # auth 结果（提权成功 → root 提示符）
        c.auth._detect_password_prompt(b"\r\n[root@inner ~]# ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        asks = [m for m in msgs if m.type == "ask_remember"]
        assert len(asks) == 1, "验证成功后应发出一次记忆询问"
        assert "sudo@10.0.0.10" in asks[0].text
        await c.auth._finish_remember(True)
        assert stored == [("10.0.0.10", "sudo", None, "s3cret")]
    asyncio.run(main())


def test_sudo_remember_key_falls_back_to_session_host(monkeypatch):
    """无 ssh 帧（sudo 直接跑在会话目标机上）：sudo 键落会话目标主机。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={2: "sudo su -"}, target_host="10.0.0.9")
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"[sudo] password for pe: ")
        await asyncio.sleep(0)
        assert c._pw_capture_key == ("10.0.0.9", "sudo", None)
    asyncio.run(main())


def test_sudo_wrong_password_never_offers_or_stores(monkeypatch):
    """错密（deny 指纹）不进库、不询问；重讨后再手输成功才问（只落本次
    验证通过的密码）。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh pe@10.0.0.10", 2: "sudo su -"})
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"[sudo] password for pe: ")
        await asyncio.sleep(0)
        await c._on_keys(b"wrong\r")
        # 错密：Sorry + 重讨（合包到达）——验证窗不收束，候选随重讨作废
        c.auth._detect_password_prompt(
            b"\r\nSorry, try again.\r\n[sudo] password for pe: ")
        await asyncio.sleep(0)
        assert c._pw_remember_candidate is None
        await c._on_keys(b"right\r")
        c.auth._detect_password_prompt(b"\r\n[root@inner ~]# ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        asks = [m for m in msgs if m.type == "ask_remember"]
        assert len(asks) == 1, "只有验证通过的那次才询问"
        await c.auth._finish_remember(True)
        assert stored == [("10.0.0.10", "sudo", None, "right")]
    asyncio.run(main())


def test_sudo_remember_decline_stores_nothing(monkeypatch):
    """拒绝「不记住」：不写库（维持每次手输现状）。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh pe@10.0.0.10", 2: "sudo su -"})
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"[sudo] password for pe: ")
        await asyncio.sleep(0)
        await c._on_keys(b"s3cret\r")
        c.auth._detect_password_prompt(b"\r\n[root@inner ~]# ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        assert any(m.type == "ask_remember" for m in msgs)
        await c.auth._finish_remember(False)
        assert stored == []
    asyncio.run(main())


def test_sudo_verify_timeout_never_offers(monkeypatch):
    """验证窗超时（未见 auth 结果）不算验证通过：不询问不落库。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh pe@10.0.0.10", 2: "sudo su -"})
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"[sudo] password for pe: ")
        await asyncio.sleep(0)
        await c._on_keys(b"s3cret\r")
        await asyncio.sleep(cmod._PW_VERIFY_TIMEOUT + 0.1)   # 强制到期
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        assert not any(m.type == "ask_remember" for m in msgs)
        assert stored == []
    asyncio.run(main())


def test_sudo_autofill_stored_key_no_ask(monkeypatch):
    """凭据库命中自动填充：密码本来就在库里，验证成功后不再询问。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh pe@10.0.0.10", 2: "sudo su -"})
    _patch_pw_io(monkeypatch, stored,
                 load=lambda h, u, p: "cached" if (h, u, p) ==
                 ("10.0.0.10", "sudo", None) else None)

    async def main():
        c.auth._detect_password_prompt(b"[sudo] password for pe: ")
        await asyncio.sleep(0)
        assert sent == [b"cached\r"]
        c.auth._detect_password_prompt(b"\r\n[root@inner ~]# ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        assert not any(m.type == "ask_remember" for m in msgs)
        assert stored == []
    asyncio.run(main())


def test_nested_ssh_typed_password_offers_remember_prompt_key(monkeypatch):
    """P1-4：嵌套 ssh 无凭据、用户在终端手输 → 验证成功（登录横幅）→
    询问「记住」→ 同意后按 _nested_pw_ctx 键（提示符 user@host）落库，
    替代已停用的模态代答记忆。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh pe@10.0.0.10"})
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"pe@10.0.0.10's password: ")
        await asyncio.sleep(0)
        assert c._pw_capture_key == ("10.0.0.10", "pe", None)
        await c._on_keys(b"s3cret\r")
        assert sent == [b"s3cret\r"]
        c.auth._detect_password_prompt(b"\r\nLast login: Tue Oct  6\r\n"
                                  b"[pe@inner ~]$ ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        asks = [m for m in msgs if m.type == "ask_remember"]
        assert len(asks) == 1
        assert "pe@10.0.0.10" in asks[0].text
        await c.auth._finish_remember(True)
        assert stored == [("10.0.0.10", "pe", None, "s3cret")]
    asyncio.run(main())


def test_nested_ssh_remember_decline_stores_nothing(monkeypatch):
    """P1-4 拒绝「不记住」：不写库（下次仍手输）。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh pe@10.0.0.10"})
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"pe@10.0.0.10's password: ")
        await asyncio.sleep(0)
        await c._on_keys(b"s3cret\r")
        c.auth._detect_password_prompt(b"\r\n[pe@inner ~]$ ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        assert any(m.type == "ask_remember" for m in msgs)
        await c.auth._finish_remember(False)
        assert stored == []
    asyncio.run(main())


def test_nested_ssh_unparseable_key_never_asks(monkeypatch):
    """「记住」没有可靠的键（提示符无主机、帧目标解析不出且无会话主机）
    ：不捕获不询问——宁缺勿错键。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c, msgs, stored = _remember_core(
        _Session(), open_cmds={1: "ssh -v"}, target_host="")
    _patch_pw_io(monkeypatch, stored)

    async def main():
        c.auth._detect_password_prompt(b"Password: ")
        await asyncio.sleep(0)
        assert c._pw_capture_key is None
        await c._on_keys(b"s3cret\r")
        c.auth._detect_password_prompt(b"\r\n[pe@inner ~]$ ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.15)
        assert not any(m.type == "ask_remember" for m in msgs)
        assert stored == []
    asyncio.run(main())


def test_authflow_owns_full_state():
    from openterminal.core.auth import AuthFlow
    core = FakeCore()
    AuthFlow(core)
    for attr in ("_pw_cancelled", "_pw_tail", "_pw_prompt_seen",
                 "_nested_pw_attempts", "_nested_pw_ctx", "_pw_verifying",
                 "_pw_verify_at", "_pw_verify_timer", "_pw_hold",
                 "_pw_hold_timer", "_pw_at_end", "_pw_modal_open",
                 "_pw_dismiss_timer", "_pw_capture_key", "_pw_typed",
                 "_pw_remember_candidate", "_pw_remember_pending",
                 "_pw_result_from"):
        assert hasattr(core, attr), attr


def test_authflow_preserves_presets():
    from openterminal.core.auth import AuthFlow
    core = FakeCore()
    core._pw_tail = bytearray(b"[sudo] password: ")
    AuthFlow(core)
    # hasattr 守卫：裸构造测试在 core 上预置的值不得被初始化覆盖
    assert bytes(core._pw_tail) == b"[sudo] password: "


def test_authflow_armed_false_when_no_prompt():
    from openterminal.core.auth import AuthFlow
    core = FakeCore()
    core._exec_stack = []
    core._open_cmds = {}
    core._cs_pw_pending = False
    assert AuthFlow(core).armed is False


def test_core_lazy_auth_property():
    """PipelineCore.auth 惰性属性：裸构造实例首次访问即建 AuthFlow，
    且同一实例复用（状态归属唯一）。"""
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    a = core.auth
    assert a is core.auth
