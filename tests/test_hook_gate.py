"""hook 集成/验活（core/hook_gate.py）域测试：集成探测/钩子消亡/shell 退出检测/模式切换前补注入（Task 10 分流）。"""

import asyncio
import openterminal.core as cmod
from openterminal.web.protocol import ClientMsg
from openterminal.core import PipelineCore
from openterminal.shell.integration import parse_probe, probe_command
from tests.web_fakes import (FakeSession, _install_fake_runner, _make_worker, _wait, _wait_json, _wire_presenter)
from tests.core_fakes import FakeCore, _bare_core


async def test_shell_exit_during_approval_blocks_later_inject(monkeypatch):
    """P1-3 + P0-1 + P1-4 联动（真机根因链）：审批等待期 TMOUT 自动登出
    → 挂起的工具执行立即以明确错误收束（不等超时打 ^C），stale 置位、死壳
    留下的活凭据作废；审批「同意」到达后工具注入一个字节都不发，工具卡显示
    可读原因而不是注垃圾进裸壳。"""
    from openterminal.web.worker import (
        CHANNEL_DEAD_EC, CHANNEL_DEAD_MSG, CommandResult, InteractiveRunner,
        ServerMsg)

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._b64flag = "-d"
    w._last_mark_at = 1.0
    fut = asyncio.get_running_loop().create_future()
    w._exec_future = fut
    w._pending_approval = ServerMsg(type="status", text="审批卡")
    w._exit_tail.clear()

    await w.hook._detect_shell_exit(b"timed out waiting for input: auto-logout\r\n")

    assert w._hook_stale is True, "stale 置位：_hook_ok 转假，注入/健康全降级"
    assert w._last_mark_at == 0.0, "死壳留下的旧时间戳不得再当活凭据"
    assert fut.done(), "挂起 exec 立即收束，不等超时打 ^C"
    res = fut.result()
    assert res.exit_code == CHANNEL_DEAD_EC
    assert "远端 shell 已退出" in res.output and "重新登录" in res.output
    await _wait_json(sink, lambda m: any(
        x.get("type") == "status" and "远端 shell 已退出" in x.get("text", "")
        for x in m))
    w._pending_approval = None
    w._exec_future = None

    # 决策到达：工具注入走门禁快速失败，PTY 里不得出现任何注入垃圾
    async def _fail_locked():
        return False
    monkeypatch.setattr(w.hook, "_ensure_integrated_locked", _fail_locked)
    runner = InteractiveRunner(w)
    res = await asyncio.wait_for(
        runner.run("head -2 /var/log/app.log; echo ====", timeout=1,
                   on_output=None), timeout=5)
    assert isinstance(res, CommandResult)
    assert res.exit_code == CHANNEL_DEAD_EC and res.output == CHANNEL_DEAD_MSG
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert not any(b"__ot_exec__" in d or b"__ot_pad" in d or d == b"\x03"
                   for d in raws), "注入垃圾不得落进落回来的裸壳"
    assert not any(b"head -2" in d for d in raws), "命令本体不得进裸壳"


async def test_shell_exit_resolves_pending_exec_without_approval(monkeypatch):
    """P1-3 另一半窗口：工具执行等待期壳死同样立即收束（不挂超时/130）。"""
    from openterminal.web.worker import CHANNEL_DEAD_EC

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    fut = asyncio.get_running_loop().create_future()
    w._exec_future = fut
    w._exit_tail.clear()

    await w.hook._detect_shell_exit(
        b"Connection to 10.0.0.20 closed by remote host.\r\n")
    assert w._hook_stale is True and fut.done()
    assert fut.result().exit_code == CHANNEL_DEAD_EC
    assert "远端 shell 已退出" in fut.result().output


async def test_shell_exit_not_fired_on_buried_log_line(monkeypatch):
    """误判防护：命令输出里带时间戳的长日志行含告别语（grep 日志），不得
    判壳死了——告别语须紧贴行首（允许一段提示符前缀）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._exit_tail.clear()
    await w.hook._detect_shell_exit(
        b"2026-10-08T10:00:00+08:00 web01 app[12345]: WARN history says: "
        b"timed out waiting for input: auto-logout\r\n")
    assert w._hook_stale is False and w._last_mark_at == 1.0


async def test_shell_exit_prompt_prefixed_tmout_is_detected(monkeypatch):
    """真机形态：bash 超时消息紧贴已打出的提示符（同一行）也要认出来。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._exit_tail.clear()
    await w.hook._detect_shell_exit(
        b"[root@web01 ~]# timed out waiting for input: auto-logout\r\n")
    assert w._hook_stale is True and w._last_mark_at == 0.0


async def test_shell_exit_real_prompt_redraw_bytes_are_detected(monkeypatch):
    """真机原始字节形态（漏检根因）：告别语紧跟提示符重画落进流里，前缀是
    ESC[?2004l + CR + BEL。字节行首锚点跨不过那个 CR，旧口径一律漏检；新口径
    按 CR/LF 切视觉行 + 剥转义后再整行匹配。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._exit_tail.clear()
    await w.hook._detect_shell_exit(
        b"\x1b[?2004l\r\x07timed out waiting for input: auto-logout\r\n")
    assert w._hook_stale is True and w._last_mark_at == 0.0


async def test_shell_exit_trailing_junk_log_line_not_fired(monkeypatch):
    """误判防护：告别语后面还拖着正文（日志行把它当消息内容）不得判壳死了。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._exit_tail.clear()
    await w.hook._detect_shell_exit(
        b"[root@web01 ~]# grep -R 'timed out waiting for input: auto-logout' "
        b"/var/log | head\r\n")
    assert w._hook_stale is False and w._last_mark_at == 1.0


async def test_shell_exit_bare_logout_approval_window_only(monkeypatch):
    """弱特征裸 logout：审批挂起窗口认（没有命令输出在途），窗口外不认
    （history/ps 输出里恰好成行的 logout 不得误判）。"""
    from openterminal.web.worker import ServerMsg

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0

    w._pending_approval = ServerMsg(type="status", text="审批卡")
    w._exit_tail.clear()
    await w.hook._detect_shell_exit(b"logout\r\n")
    assert w._hook_stale is True, "审批窗口内行首 logout 只可能是壳在告别"

    w._hook_stale = False
    w._last_mark_at = 1.0
    w._pending_approval = None
    w._exit_tail.clear()
    await w.hook._detect_shell_exit(b"logout\r\n")
    assert w._hook_stale is False, "窗口外不得认裸 logout"


async def test_dead_shell_first_submit_never_hits_bare_shell(monkeypatch):
    """P1-4：TMOUT 登出落回裸壳后，第一次自然语言提交不得把整行 + 裸 \r
    打进裸壳（那正是「整行被执行」的根因）。"""
    from openterminal.web.worker import ServerMsg

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    w._pending_approval = ServerMsg(type="status", text="审批卡")
    await w.hook._detect_shell_exit(b"timed out waiting for input: auto-logout\r\n")
    w._pending_approval = None
    assert w._hook_stale is True and not w.hook._hook_ok()

    async def _fail():
        return False
    monkeypatch.setattr(w.hook, "_ensure_integrated", _fail)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="帮我看看磁盘占用"))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert not any("帮我看看磁盘占用".encode() in d for d in raws), \
        "整行自然语言不得进裸壳"
    assert not any(d == b"\r" or d.endswith(b"\r") for d in raws), \
        "不得有裸回车把整行交给裸壳执行"
    await _wait(lambda: w._ai_task is None)
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "帮我看看磁盘占用" for x in m))


async def test_probe_shell_kind_parses_probe_output(monkeypatch):
    """探测行输出经 _probe_buf 收集并按 parse_probe 解析：bash5 → ("bash",
    flag)、zsh → zsh；输出含探测行回显也不影响（PROBE_TAG 定位）。"""
    import openterminal.web.worker as wmod
    for out, want in [
        ("__OTPROBE__bash5.1.8(1)-release|-d", ("bash", "-d")),
        ("__OTPROBE__zsh5.9|-D", ("zsh", "-D")),
    ]:
        w, sink = await _make_worker(monkeypatch)
        await asyncio.wait_for(w.connected.wait(), timeout=2)
        w.profile.os_family = "linux"
        base = w.session.send_raw

        async def _send(data, _base=base):
            await _base(data)
            # 探测行回显 + 执行输出一起喂（真实流里回显在前）
            await w.exec._on_stream_event(("exec", data.decode()[:40]))
            await w.exec._on_stream_event(("exec", out + "\r\n"))

        w.session.send_raw = _send
        got = await w.hook._probe_shell_kind()
        assert got == want, out
        assert w._probe_buf is None, "探测结束必须清 _probe_buf"


async def test_probe_shell_kind_timeout_returns_none(monkeypatch):
    """探测行被前台占用吃掉（无输出）：超时 → (None, "-d")。"""
    import openterminal.web.worker as wmod
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    monkeypatch.setattr(wmod, "_PROBE_TIMEOUT", 0.05)
    shell, flag = await w.hook._probe_shell_kind()
    assert (shell, flag) == (None, "-d")


async def test_ensure_integrated_foreign_shell_no_inject(monkeypatch):
    """su - 换壳（探测不到可集成 shell）：不注入、置 _hook_gone、返回 False；
    _hook_ok 随之转假。不发 \x03 之外的注入分片/__ot_pad。"""
    import openterminal.web.worker as wmod
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._shell_kind = "zsh"
    monkeypatch.setattr(wmod, "_PROBE_TIMEOUT", 0.05)

    ok = await w.hook._ensure_integrated()
    assert ok is False
    assert w._hook_gone is True
    assert not w.hook._hook_ok(), "标记流不足以证明 hook 在位（外族 PS1 也发标记）"
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert not any(b"__ot_inj" in d for d in raws), "外族 shell 不注入脚本"
    assert not any(b"__ot_pad" in d for d in raws)
    # 探测行还是要发的（\x15 收纳 + 探测行本身）
    assert any(b"__OTPROBE__" in d for d in raws)


async def test_ensure_integrated_reinjects_matching_shell(monkeypatch):
    """su - 换壳成 bash 5（Linux root 场景）：探测成功 → 按 bash 注入并更新
    _shell_kind/_b64flag，_hook_gone 复位，提示符标记到达后返回 True。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._shell_kind = "zsh"
    w._b64flag = "-D"

    async def _fake_probe():
        return "bash", "-d"
    monkeypatch.setattr(w.hook, "_probe_shell_kind", _fake_probe)
    base = w.session.send_raw

    async def _raw(data):
        await base(data)
        if b"__ot_inj" in data:
            w._ev_prompt.set()   # 模拟注入落地后的提示符重画
    w.session.send_raw = _raw

    ok = await w.hook._ensure_integrated()
    assert ok is True
    assert (w._shell_kind, w._b64flag) == ("bash", "-d")
    assert w._hook_gone is False
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert any(b"__ot_inj" in d for d in raws)


async def test_hook_gone_clears_when_nested_shell_exits(monkeypatch):
    """嵌套 shell（su -）退出、_open_cmds 清空：_hook_gone 复位，外层
    hook 的标记/函数从未丢过，健康路径恢复。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._open_cmds[7] = "sudo su -"
    w._hook_gone = True
    assert not w.hook._hook_ok()

    await w.exec._on_exec_end(7, 0, "/tmp")
    assert w._hook_gone is False
    assert w.hook._hook_ok()
    # 嵌套 shell 未退出（还有别的命令帧开着）不复位
    w._hook_gone = True
    w._open_cmds[8] = "sudo su -"
    w._open_cmds[9] = "echo hi"
    await w.exec._on_exec_end(9, 0, "/tmp")
    assert w._hook_gone is True
    await w.exec._on_exec_end(8, 0, "/tmp")
    assert w._hook_gone is False


async def test_switch_display_reinforces_integration_before_toggle(monkeypatch):
    # su -/嵌套 shell 会丢 hook 集成:切 Shell 模式前必须先补注入,
    # 否则 toggle 的 __ot_exec__ 变普通命令(command not found),
    # 确认标记永不回来 → 死等 5s 才清屏(真机「切 Shell 没反应」根因)
    import openterminal.web.worker as wmod

    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True   # FakeSession 探测不出集成,直接置交互态走切换路径
    w._shell_kind = "bash"
    w._b64flag = "-d"

    called = []

    async def _fake_ensure():
        called.append(True)
        return True

    w.hook._ensure_integrated = _fake_ensure
    await w.ai._switch_display("ssh")
    assert called, "切换前未补注入集成脚本"
    assert w._display == "ssh"
    assert any(c[0] == "raw" and b"__ot_off=1" in c[1]
               for c in w.session.calls), "未发送 hook off 开关"


_HOOK_LIVENESS = getattr(cmod, "_HOOK_LIVENESS", 1.0)


def _stale_core(session) -> PipelineCore:
    """root#1（集成壳，inst 100000）刚被 TMOUT 收走后的状态：_hook_gone 仍
    False、_last_mark_at 仍是死壳留下的时间戳、外层 `ssh 跳板机` 帧开着。"""
    c = _bare_core(
        session=session, _exec_future=None, _closed=False, _session_dead=False,
        _pw_tail=bytearray(), _pw_prompt_seen=False, _pw_verifying=False,
        _pw_verify_at=0.0, _pw_hold=[], _pw_hold_timer=None, _pw_at_end=False,
        _pw_modal_open=False, _pw_dismiss_timer=None,
        _nested_pw_attempts=0, _nested_pw_ctx=None,
        _pw_capture_key=None, _pw_typed=bytearray(),
        _pw_remember_candidate=None, _pw_remember_pending=None,
        _target_host="101.33.233.232",
        _open_cmds={1: "ssh xiaojian@101.33.233.232"}, _open_cmd_at={1: 10.0},
        _exec_stack=[], _last_mark_at=11.0, _interactive=True,
        _hook_gone=False, _hook_report_pending=None, _fallback_task=None,
        _intr_swallow_until=0.0, _intr_pending=b"",
        _suppress_live=False, _suppressed_echo=False, _curtain=False,
        _curtain_parts=[], _curtain_at=0.0, _ai_task=None,
        _probe_buf=None, _hidden_exec=False, _user_out=bytearray(),
        _last_live_at=0.0, _cur_prompt="",
        _hook_stale=False, _hook_watch=None, _hook_watch_text=False,
        _display="agent",
        _ev_stream=asyncio.Event(), _ev_prompt=asyncio.Event())

    async def _emit_bytes(data):
        pass
    c.emit_bytes = _emit_bytes
    return c


def test_hook_stale_after_enter_yields_text_without_markers():
    """补发回车后「只有文本、没有任何 OSC 标记」= 承接回车的不是集成壳。

    root#2 是裸 bash：`sudo su -` 的回车与它的提示符全是纯文本。看门狗到点
    必须把 hook 判为不在位，让下一条自然语言走降级（探测 + 重注入），而不是
    健康路径的裸 \r —— 裸 \r 会把整行自然语言交给 root 的 shell 执行。

    触发点必须是**按键路径**：命令行回车不经 _on_frontend_line（前端只对自然
    语言发 submit），真机 [otdbg] 里 `sudo su -` 只有 keys= b'\r'。用 submit
    驱动会绕过唯一的真实武装点——测试绿、浏览器里照旧复现。"""
    sent: list[bytes] = []

    class _Session:
        async def send_raw(self, data):
            sent.append(data)

    c = _stale_core(_Session())

    async def main():
        # 用户在 xiaojian 逐字敲 `sudo su -` 再回车（纯按键透传，无 submit）
        for ch in (b"s", b"u", b"d", b"o", b" ", b"s", b"u", b" ", b"-"):
            await c._on_keys(ch)
        await c._on_keys(b"\r")
        assert sent[-1] == b"\r"
        # root#1 已死、root#2 是裸壳：sudo 提示与新提示符全是纯文本，零标记
        await c.exec._on_stream_event(("live", "[sudo] password for xiaojian: "))
        await c.exec._on_stream_event(("live", "root@host:~# "))
        await asyncio.sleep(_HOOK_LIVENESS + 0.2)
        assert not c.hook._hook_ok(), "死壳留下的 _last_mark_at 不得再当 hook 活凭据"

        # 下一条自然语言必须走降级，不得把整行留给裸壳执行
        sent.clear()
        started: list[str] = []

        async def _no_hook():
            return False
        c.hook._ensure_integrated = _no_hook

        async def _ai(line, hooked=False):
            started.append(line)
        c.ai._on_ai_line = _ai

        await c.ai._on_frontend_line("执行 echo MARK-AI-TWO 并把输出原样告诉我",
                                  False)
        assert started == ["执行 echo MARK-AI-TWO 并把输出原样告诉我"]
        assert b"\r" not in sent, "健康路径的裸回车会把自然语言当命令执行"

    asyncio.run(main())


def test_hook_stale_latch_self_heals_on_marker():
    """外层集成壳重新画出提示符（OSC 标记到达）→ 陈旧判定即撤销。

    正常拓扑里 root#1 退出后落回的是**带 hook 的** xiaojian：它的提示符标记
    一到，健康路径必须立刻恢复，否则每次自然语言都白付一次探测+分片注入。"""
    class _Session:
        async def send_raw(self, data):
            pass

    c = _stale_core(_Session())

    async def main():
        await c._on_keys(b"\r")
        await c.exec._on_stream_event(("live", "root@host:~# "))
        await asyncio.sleep(_HOOK_LIVENESS + 0.2)
        assert not c.hook._hook_ok()
        await c.exec._on_stream_event(("prompt", "[xiaojian@host ~]$ "))
        assert c.hook._hook_ok(), "标记一到即自愈，健康路径恢复"
        await c._on_keys(b"\r")
        await c.exec._on_stream_event(("prompt_start", 100000))
        assert c.hook._hook_ok(), "prompt_start 同样是活凭据"

    asyncio.run(main())


def test_hook_watch_disarmed_by_marker_before_deadline():
    """健康壳里回车后标记立刻到（PROMPT_COMMAND 发 133;D + 133;A/B）：
    看门狗必须被撤销，纯文本输出不得误判陈旧。"""
    class _Session:
        async def send_raw(self, data):
            pass

    c = _stale_core(_Session())

    async def main():
        await c._on_keys(b"\r")
        await c.exec._on_stream_event(("live", "total 8\r\n"))
        await c.exec._on_stream_event(("prompt", "[root@host ~]# "))
        await c.exec._on_stream_event(("live", "drwxr-xr-x\r\n"))
        await asyncio.sleep(_HOOK_LIVENESS + 0.2)
        assert c.hook._hook_ok()

    asyncio.run(main())


def test_hook_watch_not_armed_at_password_prompt():
    """密码位上的回车不发标记是常态：sudo/ssh 的读取器在读密码，不是集成壳在
    跑 PROMPT_COMMAND。据此判 hook 陈旧 = 每次嵌套登录都把健康路径打断一次。"""
    class _Session:
        async def send_raw(self, data):
            pass

    c = _stale_core(_Session())
    c._pw_at_end = True          # 尾窗正停在 `[sudo] password for xiaojian: `

    async def main():
        await c._on_keys(b"\r")
        await c.exec._on_stream_event(("live", "\r\nroot@host:~# "))
        await asyncio.sleep(_HOOK_LIVENESS + 0.2)
        assert c.hook._hook_ok(), "密码回车不得触发陈旧判定"

    asyncio.run(main())


def test_hook_watch_not_armed_while_tool_command_running():
    """工具命令在途的回车同理：那段的标记由 agent 帧负责，不看用户回车。"""
    class _Session:
        async def send_raw(self, data):
            pass

    c = _stale_core(_Session())
    c._exec_future = object()    # 只作「工具命令在途」标志用，不驱动

    async def main():
        await c._on_keys(b"\r")
        await c.exec._on_stream_event(("live", "drwxr-xr-x\r\n"))
        await asyncio.sleep(_HOOK_LIVENESS + 0.2)
        assert c.hook._hook_ok(), "工具命令在途不得据用户回车判陈旧"

    asyncio.run(main())


def test_probe_buf_collects_live_text_without_killing_pump():
    """探测窗口里的 live 文本必须落进 _probe_buf，而不是抛 TypeError 打死泵。

    泵一死整个会话就哑了（无回显、无输出、无 closed 帧），且因为任务引用被
    self._pump 持有，asyncio 连「未取回异常」都不会打印——真机表现为「终端
    彻底不再响应」，查无实据。"""
    class _Session:
        async def send_raw(self, data):
            pass

    c = _stale_core(_Session())
    c._probe_buf = bytearray()          # _probe_shell_kind 正在收集

    async def main():
        # 裸壳回显探测行 + 它的真实输出，全是 live 纯文本
        await c.exec._on_stream_event(
            ("live", ' _ot_inj=""; v=""; ... echo "__OTPROBE__${v:-none}|$d"\r\n'))
        await c.exec._on_stream_event(("live", "__OTPROBE__bash5.1.8(1)-release|-d\r\n"))
        got = parse_probe(c._probe_buf.decode("utf-8", "replace"))
        assert got == ("bash", "-d"), "探测输出没被收全：%r" % (got,)

    asyncio.run(main())


def test_hookgate_owns_state():
    from openterminal.core.hook_gate import HookGate
    core = FakeCore()
    HookGate(core)
    for attr in ("_interactive", "_shell_kind", "_b64flag", "_hook_gone",
                 "_hook_stale", "_hook_seen", "_hook_watch", "_hook_watch_text",
                 "_probe_buf", "_last_mark_at", "_last_live_at", "_exit_tail",
                 "_hook_report_pending"):
        assert hasattr(core, attr), attr


def test_hookgate_preserves_presets():
    from openterminal.core.hook_gate import HookGate
    core = FakeCore()
    core._exit_tail = bytearray(b"logout")
    core._shell_kind = "bash"
    HookGate(core)
    # hasattr 守卫：裸构造测试在 core 上预置的值不得被初始化覆盖
    assert bytes(core._exit_tail) == b"logout"
    assert core._shell_kind == "bash"


def test_hookgate_initial_state():
    from openterminal.core.hook_gate import HookGate
    h = HookGate(FakeCore())
    assert h.hook_ok() is False          # 未集成时 hook 不在位
    assert h.shell_kind is None


def test_hookgate_exit_tail_matches_tmout_logout():
    from openterminal.core.hook_gate import HookGate
    h = HookGate(FakeCore())
    # 强特征：TMOUT 自动登出（任意提示符位置都认）
    assert "auto-logout" in h._match_shell_exit(
        b"root@x:~# timed out waiting for input: auto-logout\r\n")
    # 弱特征：裸 logout 只在审批挂起窗口认
    assert h._match_shell_exit(b"logout\r\n") is None
    h.core._pending_approval = object()
    assert h._match_shell_exit(b"logout\r\n") == "logout"
