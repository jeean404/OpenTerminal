"""CLI 本地截获层单测（Task 5）：审批/rescue/认证隐藏输入/Ctrl+C 中断语义。

构造按计划 Task 5 Step 1：FakeCore（分开记录 feed_msg（结构化上行）与
feed_input（PTY 直通字节）+ 真实 Policy 供 reclassify_edited）+ 真
TermFrontend（不跑 run()，同 test_term_render._frontend_env 模式，writer
落列表）+ 直调 ``capture.on_keys(data)``。不跨测试文件 import。

on_keys 是同步纯路由：决策经 ensure_future(core.feed_msg) 发出，测试在
断言前 ``await _drain()`` 让任务跑完。截获键绝不泄漏进 PTY（Review
Focus #2）：pass payload 只含剩余直通字节，端到端断言 core.raws 为空。
"""
import asyncio
import sys

import openterminal.term_frontend as tmod
from openterminal.core import ClientMsg
from openterminal.policy import Policy
from openterminal.term_frontend import TermFrontend


class FakeCore:
    """截获层的核心替身：feed_msg（结构化上行）与 feed_input（PTY 直通
    字节）分开记录——「截获键不漏进 PTY」断言 raws 全程为空。"""

    def __init__(self, frontend):
        self.fed = []
        self.raws = []
        self._frontend = frontend
        self._ai_task = None
        self.policy = Policy()

    async def feed_msg(self, msg):
        self.fed.append(msg)

    async def feed_input(self, data):
        self.raws.append(data)


async def _never_reader():
    await asyncio.sleep(3600)
    return b""


def _frontend_env():
    """真 TermFrontend（不跑 run()）+ FakeCore 回填 + 列表 writer。"""
    written = []
    fe = TermFrontend(core=None, reader=_never_reader)
    fe._writer = lambda d: written.append(d)
    core = FakeCore(fe)
    fe.core = core
    return fe, core, written


async def _drain():
    """让 on_keys / _run_edit 经 ensure_future 调度出去的决策任务跑完。"""
    await asyncio.sleep(0)
    await asyncio.sleep(0)


def _decisions(core):
    return [m for m in core.fed if isinstance(m, ClientMsg)
            and m.type == "decision"]


class _TtyStdin:
    """isatty 门控假 stdin（_set_raw_input 已被 monkeypatch，fileno 不被用）。"""

    def isatty(self):
        return True

    def fileno(self):
        return 0


class _suppress_cancel:
    def __enter__(self):
        return self

    def __exit__(self, et, ev, tb):
        return et is asyncio.CancelledError


# --- 计划 Task 5 Step 1 的 14 例 ---

async def test_approval_enter_sends_approve():
    """normal 风险，\\r → decision {"type": "approve"}，无透传字节。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_approval("normal")
    kind, rest = cap.on_keys(b"\r")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    ds = _decisions(core)
    assert len(ds) == 1 and ds[0].decision == {"type": "approve"}
    assert cap.state is None                  # 发送后退出截获态


async def test_approval_high_needs_double_enter():
    """high：第一个 \\r 只进 confirming（无 feed_msg），第二个 \\r → approve。"""
    fe, core, written = _frontend_env()
    cap = fe._capture
    cap.enter_approval("high")
    kind, rest = cap.on_keys(b"\r")
    assert (kind, rest) == ("pass", b"")
    assert core.fed == []                     # 尚未决策
    assert cap.state == "approval" and cap._confirming
    assert "确认执行".encode() in b"".join(written)   # 红行提示已渲染
    kind, rest = cap.on_keys(b"\r")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    ds = _decisions(core)
    assert len(ds) == 1 and ds[0].decision == {"type": "approve"}


async def test_approval_backspace_rejects():
    """\\x7f → reject，message 与 web 一致。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_approval("normal")
    kind, rest = cap.on_keys(b"\x7f")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    ds = _decisions(core)
    assert len(ds) == 1
    assert ds[0].decision == {"type": "reject", "message": "用户拒绝了该命令"}


async def test_approval_swallows_other_keys():
    """高危待决期 feed b"ls\\r"：\\r 只进 confirming，feed_msg 零调用、
    透传字节为空（其余键吞掉不透传，对齐 web approvalKeys）。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_approval("high")
    kind, rest = cap.on_keys(b"ls\r")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    assert core.fed == []
    assert cap.state == "approval"            # 仍待决


async def test_rescue_y_n():
    """rescue：y → accept=True；n → accept=False；x → 透传 b"x"。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_rescue()
    assert cap.on_keys(b"x") == ("pass", b"x")   # 其余键透传
    kind, rest = cap.on_keys(b"y")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    cap.enter_rescue()                        # y 决策后已退出截获态，重进
    kind, rest = cap.on_keys(b"n")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    rs = [m for m in core.fed if m.type == "rescue"]
    assert len(rs) == 2
    assert rs[0].accept is True and rs[1].accept is False


async def test_password_hidden_accumulates():
    """password：敲 b"pw1\\r" → auth msg text="pw1"；writer 未收到 pw1（无回显）。"""
    fe, core, written = _frontend_env()
    cap = fe._capture
    cap.enter_auth("password")
    kind, rest = cap.on_keys(b"pw1\r")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    au = [m for m in core.fed if m.type == "auth"]
    assert len(au) == 1
    assert au[0].auth_kind == "password" and au[0].text == "pw1"
    assert au[0].remember is False            # CLI 不做记住勾选
    assert b"pw1" not in b"".join(written)    # 累积字符绝不回显
    assert cap.state is None


async def test_password_backspace():
    """b"ab\\x7fc\\r" → text="ac"。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_auth("password")
    cap.on_keys(b"ab\x7fc\r")
    await _drain()
    au = [m for m in core.fed if m.type == "auth"]
    assert len(au) == 1 and au[0].text == "ac"


async def test_host_key_y():
    """host_key：y → auth host_key text="true"；n → text="false"。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_auth("host_key")
    kind, rest = cap.on_keys(b"y")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    au = [m for m in core.fed if m.type == "auth"]
    assert len(au) == 1
    assert au[0].auth_kind == "host_key" and au[0].text == "true"
    cap.enter_auth("host_key")
    cap.on_keys(b"n")
    await _drain()
    au = [m for m in core.fed if m.type == "auth"]
    assert len(au) == 2 and au[1].text == "false"


async def test_ctrl_c_during_task_interrupts():
    """core._ai_task 非 None → \\x03 → interrupt msg，不透传（无 raw）。"""
    fe, core, _ = _frontend_env()
    core._ai_task = object()                  # 任务活跃
    kind, rest = fe._capture.on_keys(b"\x03")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    assert [m.type for m in core.fed] == ["interrupt"]
    assert core.raws == []


async def test_ctrl_c_idle_passes_through():
    """_ai_task None（空闲）→ \\x03 原样透传（shell 原生 ^C）。"""
    fe, core, _ = _frontend_env()
    kind, rest = fe._capture.on_keys(b"\x03")
    assert (kind, rest) == ("pass", b"\x03")
    await _drain()
    assert core.fed == [] and core.raws == []   # 测试直调 on_keys，泵未喂


async def test_ctrl_d_always_passes():
    """任务期 \\x04 也永远透传（shell exit → 核心 closed）。"""
    fe, core, _ = _frontend_env()
    core._ai_task = object()
    kind, rest = fe._capture.on_keys(b"\x04")
    assert (kind, rest) == ("pass", b"\x04")


async def test_edit_flow_handoff_order(monkeypatch):
    """e → ("edit", 余量) → _run_edit 调用序（Review Focus #5）：
    暂停泵 → 摘 stdin 监听 → _restore_input → prompt_toolkit 输入 →
    _set_raw_input → 重挂监听 → 恢复泵 → feed_msg edit_decision。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")
    order = []

    monkeypatch.setattr(sys, "stdin", _TtyStdin())
    monkeypatch.setattr(tmod, "_restore_input",
                        lambda st: order.append(("restore", st)))
    monkeypatch.setattr(tmod, "_set_raw_input",
                        lambda: (order.append(("set_raw",)),
                                 ("fd", "attrs"))[1])

    async def fake_edit(original):
        order.append(("prompt", original))
        order.append(("paused", fe._pump_paused))
        return "echo ok"

    monkeypatch.setattr(fe, "_prompt_edit", fake_edit)
    orig_feed = core.feed_msg

    async def probe_feed(msg):
        order.append(("feed", fe._pump_paused))
        await orig_feed(msg)

    core.feed_msg = probe_feed

    kind, rest = cap.on_keys(b"e")
    assert (kind, rest) == ("edit", b"")
    await fe._run_edit()
    await _drain()

    assert [o[0] for o in order] == ["restore", "prompt", "paused",
                                     "set_raw", "feed"]
    assert order[0][1] is None                # 非 tty：待还原状态为 None
    assert order[2][1] is True                # prompt_toolkit 输入时泵暂停中
    assert order[4][1] is False               # feed_msg 前泵已恢复
    ds = _decisions(core)
    assert len(ds) == 1
    assert ds[0].decision == {"type": "edit",
                              "edited_action": {"name": "execute",
                                                "args": {"command": "echo ok"}}}
    assert cap.state is None


async def test_edit_deny_becomes_reject():
    """编辑结果被策略判 deny（deny_extra）→ 发 reject（message=
    编辑后命令被策略拒绝）+ 红行渲染，而非 edit 决策。"""
    fe, core, written = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")
    core.policy = Policy(deny_extra={"echo ok"})

    async def fake_edit(original):
        return "echo ok"

    fe._prompt_edit = fake_edit
    cap.on_keys(b"e")
    await fe._run_edit()
    await _drain()
    ds = _decisions(core)
    assert len(ds) == 1
    assert ds[0].decision == {"type": "reject",
                              "message": "编辑后命令被策略拒绝"}
    assert "策略拒绝".encode() in b"".join(written)   # 红行渲染
    assert cap.state is None


async def test_capture_keys_never_reach_pty():
    """端到端（Review Focus #2）：经 _input_pump 喂任意可打印键，截获期
    core.raws（= session PTY 直通）无新 raw 项、无决策、仍待决。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_approval("high")
    chunks = [b"ls -la\rbogus"]

    async def reader():
        if not chunks:
            await asyncio.sleep(3600)
            return b""
        return chunks.pop(0)

    fe._reader = reader
    pump = asyncio.create_task(fe._input_pump())
    try:
        await asyncio.sleep(0.05)
    finally:
        pump.cancel()
        with _suppress_cancel():
            await pump
    assert core.raws == []                    # 截获键零泄漏进 PTY
    assert core.fed == []                     # 且未误触发决策
    assert cap.state == "approval"            # 仍待决


# --- 追加覆盖（只加不减）---

async def test_confirming_backspace_returns_to_pending():
    """confirming 态 \\x7f：仅退出 confirming 回待决，不发决策。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_approval("high")
    cap.on_keys(b"\r")                        # 进 confirming
    kind, rest = cap.on_keys(b"\x7f")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    assert core.fed == []
    assert cap.state == "approval" and not cap._confirming
    cap.on_keys(b"\r")                        # 回待决后仍是二段确认语义
    await _drain()
    assert core.fed == [] and cap._confirming


async def test_edit_eof_returns_to_pending():
    """编辑流 EOF/取消 → 回待决态不发决策。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")

    async def fake_edit(original):
        raise EOFError

    fe._prompt_edit = fake_edit
    cap.on_keys(b"e")
    await fe._run_edit()
    await _drain()
    assert core.fed == []                     # 无决策
    assert cap.state == "approval"            # 回待决
    assert not cap._editing
    kind, rest = cap.on_keys(b"\r")           # 待决态按键语义恢复正常
    assert (kind, rest) == ("pass", b"")
    await _drain()
    assert len(_decisions(core)) == 1


async def test_pump_routes_edit_branch(monkeypatch):
    """_input_pump 的 edit 分支接线：reader 喂 b"e" → _run_edit
    被执行（edit 决策发出）。"""
    monkeypatch.setattr(sys, "stdin", _TtyStdin())
    monkeypatch.setattr(tmod, "_restore_input", lambda st: None)
    monkeypatch.setattr(tmod, "_set_raw_input", lambda: None)
    fe, core, _ = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")

    async def fake_edit(original):
        return "echo ok"

    fe._prompt_edit = fake_edit
    chunks = [b"e"]

    async def reader():
        if not chunks:
            await asyncio.sleep(3600)
            return b""
        return chunks.pop(0)

    fe._reader = reader
    pump = asyncio.create_task(fe._input_pump())
    try:
        for _ in range(50):
            await asyncio.sleep(0.01)
            if _decisions(core):
                break
    finally:
        pump.cancel()
        with _suppress_cancel():
            await pump
    ds = _decisions(core)
    assert len(ds) == 1 and ds[0].decision["type"] == "edit"


async def test_ctrl_c_in_rescue_decides_ignore():
    """钉死规则：rescue 待决期 \\x03 → accept=False，不透传。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_rescue()
    kind, rest = cap.on_keys(b"\x03")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    rs = [m for m in core.fed if m.type == "rescue"]
    assert len(rs) == 1 and rs[0].accept is False
    assert cap.state is None


async def test_ctrl_c_in_approval_rejects():
    """钉死规则：approval 待决期 \\x03 → reject，不透传。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_approval("normal")
    kind, rest = cap.on_keys(b"\x03")
    assert (kind, rest) == ("pass", b"")
    await _drain()
    ds = _decisions(core)
    assert len(ds) == 1
    assert ds[0].decision == {"type": "reject", "message": "用户拒绝了该命令"}


async def test_ctrl_d_passes_in_approval_state():
    """\\x04 永远透传——审批待决态也不例外。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_approval("high")
    assert cap.on_keys(b"\x04") == ("pass", b"\x04")
    await _drain()
    assert core.fed == []


async def test_edit_approve_level_sends_approve():
    """编辑结果仍是 approve 级 → 直接发 approve（计划 Task 5 规则）。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")

    async def fake_edit(original):
        return "newcmd"                       # 未知命令 → approve 级

    fe._prompt_edit = fake_edit
    cap.on_keys(b"e")
    await fe._run_edit()
    await _drain()
    ds = _decisions(core)
    assert len(ds) == 1 and ds[0].decision == {"type": "approve"}
    assert cap.state is None


async def test_password_submit_chunk_remainder_routes_normal():
    """密码 \\r 提交后同 chunk 剩余字节回普通路由（\\x03 恢复普通语义）。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_auth("password")
    kind, rest = cap.on_keys(b"pw\r\x03")     # 余量 \x03 一并喂入
    assert (kind, rest) == ("pass", b"\x03")  # 提交后 idle 路由：无任务 → 透传
    await _drain()
    au = [m for m in core.fed if m.type == "auth"]
    assert len(au) == 1 and au[0].text == "pw"


# --- 审查修复（B1/B2 + minor 1-4）回归 ---

async def test_password_ctrl_d_passes_through():
    """\\x04 永远透传——password 态也不例外（此前被静默丢弃）。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_auth("password")
    kind, rest = cap.on_keys(b"\x04")
    assert (kind, rest) == ("pass", b"\x04")
    await _drain()
    assert core.fed == [] and cap.state == "password"   # 仍在待决、未提交


async def test_rescue_prefix_bytes_before_decision_pass():
    """minor 1：rescue 态同 chunk 决策键前已透传的字节不丢（b"xy" →
    x 直通 + y 决策）。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    cap.enter_rescue()
    kind, rest = cap.on_keys(b"xy")
    await _drain()
    rs = [m for m in core.fed if m.type == "rescue"]
    assert len(rs) == 1 and rs[0].accept is True
    assert (kind, rest) == ("pass", b"x")     # y 决策后余量回 idle 路由


async def test_pump_routes_remainder_after_edit(monkeypatch):
    """minor 3：e 键同 chunk 余量编辑完成后继续路由（b"els\\r" → edit
    决策 + b"ls\\r" 直通 PTY，不丢字节）。"""
    monkeypatch.setattr(sys, "stdin", _TtyStdin())
    monkeypatch.setattr(tmod, "_restore_input", lambda st: None)
    monkeypatch.setattr(tmod, "_set_raw_input", lambda: None)
    fe, core, _ = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")

    async def fake_edit(original):
        return "echo ok"

    fe._prompt_edit = fake_edit
    chunks = [b"els\r"]

    async def reader():
        if not chunks:
            await asyncio.sleep(3600)
            return b""
        return chunks.pop(0)

    fe._reader = reader
    pump = asyncio.create_task(fe._input_pump())
    try:
        for _ in range(50):
            await asyncio.sleep(0.01)
            if core.raws:
                break
    finally:
        pump.cancel()
        with _suppress_cancel():
            await pump
    assert [d.decision["type"] for d in _decisions(core)] == ["edit"]
    assert core.raws == [b"ls\r"]             # 余量编辑后直通


async def test_status_reactivates_after_edit():
    """minor 4：编辑前状态行在屏 → 编辑取消回待决后复活且保留计数；
    deny（任务终止）路径不复活。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")
    fe.status.activate("任务进行中")
    fe.status.update(100, 5, False)

    async def fake_eof(original):
        raise EOFError

    fe._prompt_edit = fake_eof
    cap.on_keys(b"e")
    await fe._run_edit()
    await _drain()
    assert fe.status.active                   # 取消 → 任务继续 → 复活
    assert fe.status._t_in == 100             # reactivate 不清计数

    async def fake_ok(original):
        return "echo ok"

    fe._prompt_edit = fake_ok
    fe.status.deactivate()
    core.policy = Policy(deny_extra={"echo ok"})
    cap.enter_approval("normal")              # 回待决再来一轮
    cap.on_keys(b"e")
    await fe._run_edit()
    await _drain()
    assert not fe.status.active               # deny → 任务将终止 → 不复活


async def test_edit_suspends_and_resumes_stdin_reader(monkeypatch):
    """审查 B1：编辑流前摘 stdin 的 add_reader（防 prompt_toolkit 抢键/
    cooked 模式 os.read 冻结 loop），编辑后重挂同一回调，先摘后挂。"""
    fe, core, _ = _frontend_env()
    cap = fe._capture
    fe._pending_approval_command = "echo old"
    cap.enter_approval("normal")
    fe._stdin_fd = 7
    fe._stdin_cb = lambda: None
    loop = asyncio.get_running_loop()
    calls = []
    orig_rm, orig_add = loop.remove_reader, loop.add_reader

    def rm(fd):
        calls.append(("rm", fd))
        return orig_rm(fd)

    def add(fd, cb, *a):
        calls.append(("add", fd))
        return orig_add(fd, cb, *a)

    monkeypatch.setattr(loop, "remove_reader", rm)
    monkeypatch.setattr(loop, "add_reader", add)
    monkeypatch.setattr(sys, "stdin", _TtyStdin())
    monkeypatch.setattr(tmod, "_restore_input", lambda st: None)
    monkeypatch.setattr(tmod, "_set_raw_input", lambda: None)

    async def fake_edit(original):
        assert ("rm", 7) in calls             # prompt 期间已摘
        assert ("add", 7) not in calls        # 编辑期间未重挂
        return "echo ok"

    monkeypatch.setattr(fe, "_prompt_edit", fake_edit)
    cap.on_keys(b"e")
    await fe._run_edit()
    await _drain()
    assert ("rm", 7) in calls and ("add", 7) in calls
    assert calls.index(("rm", 7)) < calls.index(("add", 7))


async def test_default_reader_registers_stdin_fd(monkeypatch):
    """审查 B2：__init__ 账目顺序修复——默认 reader 构造期注册的
    _stdin_fd 不再被后置初始化抹掉，_remove_stdin_reader 真能注销。"""
    import os
    rfd, wfd = os.pipe()
    fake_stdin = os.fdopen(rfd, "rb", closefd=False)
    monkeypatch.setattr(sys, "stdin", fake_stdin)
    fe = TermFrontend(core=None)              # 默认 reader（POSIX add_reader）
    try:
        assert fe._stdin_fd == rfd            # 账目在（曾被重置为 None）
        assert fe._stdin_cb is not None
        fe._remove_stdin_reader()
        assert fe._stdin_fd is None and fe._stdin_cb is None
    finally:
        asyncio.get_running_loop().remove_reader(rfd)   # 幂等防御
        os.close(wfd)
        fake_stdin.close()
        os.close(rfd)


async def test_decision_receipt_rendered_locally():
    """live 套件 D1 修复回归：决策发出即本地合成回执定格行（✓/✗），
    不等 core（core 不发 decide 事件）。"""
    fe, core, written = _frontend_env()
    cap = fe._capture
    cap.enter_approval("normal")
    cap.on_keys(b"\r")                        # approve
    await _drain()
    assert "已执行".encode() in b"".join(written)
    cap.enter_approval("normal")
    cap.on_keys(b"\x7f")                      # reject
    await _drain()
    out = b"".join(written)
    assert "已拒绝".encode() in out


async def test_rescue_receipt_rendered_locally():
    """live 套件 D2 修复回归：救援决策发出即本地合成回执（✓ 已交给 AI /
    已忽略）。"""
    fe, core, written = _frontend_env()
    cap = fe._capture
    cap.enter_rescue()
    cap.on_keys(b"y")
    await _drain()
    assert "已交给 AI".encode() in b"".join(written)
    cap.enter_rescue()
    cap.on_keys(b"n")
    await _drain()
    assert "已忽略".encode() in b"".join(written)
