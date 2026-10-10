"""exec 标记流/注入/幕帘（core/exec_events.py）域测试：^C 吞除/注入窗/降级路径/shell pad 打字/exec_end 收束（Task 10 分流）。"""

import asyncio
import time
import time as _time
from openterminal.web.protocol import ClientMsg
from openterminal.core import PipelineCore
from tests.web_fakes import (FakeSession, PassthroughSession, _drain_fallback, _fake_ai_task, _install_fake_runner, _make_worker, _sink_bytes, _skip_reintegrate, _wait, _wait_json, _wire_presenter)
from tests.core_fakes import FakeCore, _bare_core


async def test_worker_suppressed_echo_swallowed_then_newline(monkeypatch, tmp_path):
    """注入窗口（§5.5）：live 回显字节吞掉；执行开始时补 \\r\\n 收束被吞的
    提示符行（否则命令输出接在提示符同一行）。"""
    import openterminal.core.history as history_db
    monkeypatch.setattr(history_db, "record", lambda *a, **k: None)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True

    w._suppress_live = True
    await w.exec._on_stream_event(("live", "eval base64注入行\r\n"))
    assert _sink_bytes(sink) == b""                # 回显吞掉
    w._pending_report = (1, "CMD", "ls")
    await w.exec._on_exec_start(1)
    await _wait(lambda: _sink_bytes(sink) == b"\r\n")   # 补换行收束
    w._suppress_live = False
    await w.exec._on_exec_end(1, 0, "/tmp")


class _BareHookShell(FakeSession):
    """标记照发（PS1 里有 OSC 133）、但 __ot_submit/__ot_pad 不在位的壳：
    注入分片被当普通赋值执行——只有回显 + 提示符重绘，没有 C/D 帧。"""

    PROMPT = "[root@x /tmp]# "

    def __init__(self, w=None):
        super().__init__()
        self.w = w

    async def send_raw(self, data):
        await super().send_raw(data)
        if data in (b"\x15", b"\x19", b"\x03"):
            return
        line = data.decode("utf-8", "replace").rstrip("\r")
        await self.w.exec._on_stream_event(("live", line + "\r\n"))
        await self.w.exec._on_stream_event(("prompt_start", 1))
        await self.w.exec._on_stream_event(("live", self.PROMPT))


async def test_reinject_into_bare_shell_no_prompt_wall(monkeypatch):
    r"""重注入分片打进「标记照发、函数不在位」的壳（su - 换壳真机截图）：
    分片回显与提示符重绘全在抑制窗内吞掉，窗末只重画**一个**提示符。

    旧实现两处漏：① live 分支先判 _curtain 后判 _suppress_live，窗内提示符
    根本没被吞；② prompt_start 关帘后提示符段进 _curtain_parts，下一次
    send_raw（幕帘闸）成排放行——提示符串一个接一个落在同一光标列上。
    """
    sess = _BareHookShell()
    w, sink = await _make_worker(monkeypatch, session=sess)
    sess.w = w
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._shell_kind = "bash"
    w._last_mark_at = time.monotonic()      # 标记流在 → _hook_ok 假阳性

    async def _probe():
        return ("bash", "-d")

    monkeypatch.setattr(w.hook, "_probe_shell_kind", _probe)
    w._ai_task = _fake_ai_task(w)   # 任务在跑：prompt_start 会关帘

    assert await w.hook._ensure_integrated()
    await asyncio.sleep(0.1)
    await w.exec._curtain_open()
    await asyncio.sleep(0.1)

    text = _sink_bytes(sink).decode("utf-8", "replace")
    assert text.count("[root@x /tmp]#") == 1, "提示符墙：%r" % text[:200]
    assert "__ot_inj" not in text, "注入分片回显漏到前端：%r" % text[:200]
    w._ai_task.cancel()


async def test_degraded_submit_repaints_nl_line_blue(monkeypatch):
    r"""降级提交（hook 标记绝迹 = su - 重置）：清场 \x15+\x03 之后由 worker
    补画 hook 的 __ot_repaint "$t" 33 观感——「提示符 + 蓝 38;5;33 原文 + 换行」。

    旧实现只发 \x15+\x03：已回显的自然语言被擦掉且永不再画（hook 的
    __ot_repaint 不会跑），屏上文字完全消失，只能等分析卡的 text 才重现。
    """
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    sess = FakeSession()
    w, sink = await _make_worker(monkeypatch, session=sess)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 0.0                   # 本会话没见过标记 = hook 不在位
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    # 用户已把自然语言敲在提示符上（shell 自己回显的）
    await w.exec._on_stream_event(("live", "[root@x /tmp]# 查看正在运行的容器"))
    await w.handle_client(ClientMsg(type="submit", text="查看正在运行的容器"))
    await asyncio.sleep(0.8)                # 后台清场（0.12+0.4s）落地

    raw = _sink_bytes(sink).decode("utf-8", "replace")
    assert "\x1b[38;5;33m查看正在运行的容器\x1b[0m" in raw, \
        "自然语言没被补画成蓝 38;5;33：%r" % raw
    assert raw.index("\x1b[38;5;33m") >= 0
    await _drain_fallback(w)


async def test_curtain_gate_holds_during_inject_window(monkeypatch):
    r"""抑制窗内幕帘闸不得开帘：窗内吞掉的提示符段一旦被下一次 send_raw
    放行，就会成排落在上一提示符的光标列上（横排提示符墙的直接成因）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    t = _fake_ai_task(w)
    w._suppress_live = True
    await w.exec._on_stream_event(("prompt_start", 1))
    await w.exec._on_stream_event(("live", "[root@x ~]# "))
    await w.session.send_raw(b"__ot_inj='xx'\r")
    await asyncio.sleep(0.05)
    assert w._curtain, "注入窗内开帘 = 提示符段成排泄漏"
    assert not w._curtain_parts, "窗内提示符是被吞（记进 _suppressed_tail），不进帘"
    assert w._suppressed_tail == "[root@x ~]# ", "窗末重画提示符靠它"
    assert b"root@x" not in _sink_bytes(sink), "窗内提示符不得外发"
    w._suppress_live = False
    t.cancel()


async def test_worker_submit_open_user_cmd_takes_degraded_path(monkeypatch):
    """用户命令执行帧开着（前台占用，典型 sudo su - 整段会话——其 C 帧不闭合
    进入后 hook 标记亦绝迹）：readline 不在读行，健康路径补发的 \\r 只落进
    命令 stdin、hook 永不重绘/上报（真机自然语言被裸 shell 当命令执行
    command not found 的根因）——必须走降级：任务先行，清场后台并行，整行不重发。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 2.0          # hook 在位（见过标记）
    w._open_cmds[1] = "sudo su -"  # 但用户命令帧开着（C 帧未闭合）→ 必须降级
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="看看磁盘用量"))
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert "看看磁盘用量\r".encode() not in raws, "降级不整行重发"
    assert w._hook_report_pending is None
    assert w._ai_task is not None, "帧开着不走健康路径，但任务先行"
    task = w._ai_task
    await _wait_json(sink, lambda m: any(
        x.get("event", {}).get("kind") == "task_start"
        and x["event"]["text"] == "看看磁盘用量" for x in m))
    await asyncio.wait_for(task, timeout=2)
    await asyncio.sleep(0.8)       # 后台清场（0.12+0.4s）落地
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    assert b"\x15" in raws and b"\x03" in raws, "清场后台并行发生"
    await _drain_fallback(w)


async def test_worker_degraded_settles_after_intr(monkeypatch):
    """\\x03 与重注入写入之间必须 settle：readline 的 SIGINT 恢复窗口丢弃期间
    到达的输入（真机实测紧贴 ^C 发分片丢 chunk0 头部，解码脚本缺字节、注释行
    断成命令报 command not found）。清场持 _runner_lock：_run_task 里的重注入
    等锁串行在其后，探测行/分片必落在 settle 之后。"""
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 2.0
    w._open_cmds[1] = "sudo su -"
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)

    # 重注入替身模拟真身：取 _runner_lock 后才写 PTY（探测行）
    async def _fake_reintegrate():
        async with w._runner_lock:
            await w.session.send_raw(b" _ot_probe_line\r")
    monkeypatch.setattr(w.hook, "_ensure_integrated", _fake_reintegrate)

    await w.handle_client(ClientMsg(type="submit", text="看看磁盘用量"))
    assert w._ai_task is not None
    task = w._ai_task
    await asyncio.wait_for(task, timeout=2)
    await asyncio.sleep(0.8)       # 后台清场 + 重注入替身落地
    raws = [d for k, d in w.session.calls if k == "raw"]
    idx3 = [p for p, d in enumerate(raws) if d == b"\x03"]
    assert idx3, "降级清场有 \\x03"
    p = idx3[-1]
    probe = [q for q, d in enumerate(raws) if d == b" _ot_probe_line\r"]
    assert probe, "重注入探测行落地"
    assert probe[0] > p, "重注入在 ^C 之后（等锁串行）"
    gap = w.session.raw_times[probe[0]] - w.session.raw_times[p]
    assert gap >= 0.35, f"settle 不足（{gap:.2f}s）：分片会落进 SIGINT 恢复窗口"
    await _drain_fallback(w)


async def test_worker_degraded_erases_echo_visibly(monkeypatch):
    """降级清行的擦除必须前端看得见（\\x15 发在 _suppress_live 窗口之外）。

    旧根因：擦除落在重注入的 _suppress_live 窗口里被吞掉，旧回显留屏不动——
    前端只见「输入重复两遍」。任务先行重构后：清场在后台独立完成，不与任何
    抑制窗口重叠；整行不再重发（无蓝色重绘 = 无两份输入的可能）。
    """
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "SUBMIT_FALLBACK_DELAY", 60)
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 2.0
    w._open_cmds[1] = "sudo su -"
    await _install_fake_runner(monkeypatch)
    _wire_presenter(w)
    _skip_reintegrate(w, monkeypatch)

    # DL 走 emit_bytes -> outbox（异步送达），挂进 send_raw 同一条时间线
    _orig_emit = w.emit_bytes
    async def _emit(data):
        w.session.calls.append(("dl", data))
        await _orig_emit(data)
    w.emit_bytes = _emit

    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="submit", text="帮我查看 docker容器"))
    assert w._ai_task is not None, "任务先行"
    task = w._ai_task
    await asyncio.wait_for(task, timeout=2)
    await asyncio.sleep(0.8)       # 后台清场（0.12+0.4s）落地
    raws = [d for k, d in w.session.calls if k == "raw"][n:]
    dls = [d for k, d in w.session.calls if k == "dl"]

    assert b"\x15" in raws, "清行须发在 _suppress_live 窗口外，前端才看得见擦除"
    assert b"\x03" in raws
    assert raws.index(b"\x15") < raws.index(b"\x03"), "清行先于 ^C：^C 后是新提示符行"
    assert "帮我查看 docker容器\r".encode() not in raws, "整行不重发（无蓝色重绘）"
    assert not any(b"\x1b[1M" in d for d in dls), "无重发则无 DL 删行"
    await _drain_fallback(w)


async def test_worker_setup_injection_ps2_selfheal(monkeypatch):
    """setup 注入竞态自愈：回显流出现续行提示符指纹（quote> = 输入字节被行
    规程丢弃、引号失配）→ \\x15\\x03 清行整链重灌一次 → 拿到提示符标记
    （不再烧满 8s 兜底才回退直通，真机 8s 死等根因）。"""
    from openterminal.shell.integration import injection_lines
    from openterminal.session.base import CommandResult
    w, sink = await _make_worker(monkeypatch, session=PassthroughSession())
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    # 暂停字节泵：脚本化 feed 必须留给 setup 注入期的 _drain_quiet 消费
    #（泵与 drain 并发 _read_some 会互抢脚本字节）
    w._pump.cancel()
    try:
        await w._pump
    except asyncio.CancelledError:
        pass

    async def _probe_run(command, *, timeout=None, on_output=None):
        w.session.calls.append(("run", command))
        return CommandResult(output="__OTPROBE__zsh5.9|-d", exit_code=0,
                             truncated=False, cwd="/tmp")
    monkeypatch.setattr(w.session, "run", _probe_run)
    monkeypatch.setattr(w, "_target_host", "")   # 跳过历史注入

    # 脚本化回显按注入进度生成：首条 chunk0 的回显卡在 quote>（竞态指纹）；
    # \x15\x03 清行重灌后，第二条 chunk0 的回显干净并带提示符标记（SWALLOW
    # 相位照常解析 OSC）。前置的静默行/历史注入 drain 无回显（真机同款时序）
    chunk0 = injection_lines("zsh", 1, "-d")[0]
    served = {"n": 0}

    async def _scripted_read(idle_timeout):
        sess = w.session
        n0 = sum(1 for k, d in sess.calls if k == "raw" and d == chunk0)
        await asyncio.sleep(0)
        if n0 >= 2 and served["n"] < 2:
            served["n"] = 2
            return (b"__ot_inj='AAAA'\r\x1b[0m\x1b[27m\x1b[24m\x1b[J"
                    b"\x1b]133;A;1\x07$\x1b]133;B;1\x07")
        if n0 >= 1 and served["n"] < 1:
            served["n"] = 1
            return (b"__ot_inj='AAAA'\r\x1b[0m\x1b[27m\x1b[24m\x1b[J"
                    b"quote> \x1b[K")
        await asyncio.sleep(0.02)
        raise asyncio.TimeoutError()
    monkeypatch.setattr(w.session, "_read_some", _scripted_read)

    await asyncio.wait_for(w._setup_interactive(), timeout=10)
    assert w._interactive is True
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert b"\x15\x03" in raws, "检测到续行指纹：清行重灌"
    chunk0 = injection_lines("zsh", 1, "-d")[0]
    assert raws.count(chunk0) == 2, "分片链整链重灌一次"


async def test_worker_exec_text_swallowed_in_injection_window(monkeypatch):
    """su - 后重注入落在 EXEC 相位（C 帧未闭）：分片回显/eval 杂行走 exec 事件
    直通主屏 = base64 墙。抑制窗口内用户帧 exec 字节一并吞掉。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._suppress_live = True
    await w.exec._on_exec_text("__ot_inj=\"$__ot_inj\"'5a+5562W'")
    await asyncio.sleep(0.02)
    assert not [m for m in sink.messages if m[0] == "bytes"], "窗口内 exec 直漏主屏"
    w._suppress_live = False
    await w.exec._on_exec_text("root")
    await asyncio.sleep(0.02)
    assert ("bytes", b"root") in sink.messages, "窗口外用户输出照常直通"


def _wire_pad_prompt(w):
    """替身 send_raw：看到 __ot_pad 注入行即模拟 hook 打完空行后的提示符重画。"""
    sess = w.session
    base = sess.send_raw

    async def _raw(data):
        await base(data)
        if b"__ot_pad" in data:
            w._ev_prompt.set()
    sess.send_raw = _raw


async def _padded_rows(sink):
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "event" and x.get("event", {}).get("kind") == "padded"
        for x in m))
    return [m["event"]["rows"] for m in msgs
            if m.get("type") == "event" and m["event"].get("kind") == "padded"]


async def test_shell_pad_sends_bracketed_injection_and_acks_once(monkeypatch):
    r"""pad：\x15…__ot_pad N\r…\x19 注入（与 InteractiveRunner 共用
    _runner_lock 的半行收纳，hook 在位走 shell 侧存档/接回原语），等提示符
    重画后一次 padded 应答。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # 本会话见过标记 → hook 在位
    _wire_pad_prompt(w)

    await w.handle_client(ClientMsg(type="pad", pad=5))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [b"\x15", b"__ot_pad 5\r", b"\x19"]
    assert await _padded_rows(sink) == [5]


async def test_shell_pad_chunks_over_50(monkeypatch):
    """单块上限 50（hook seq 上限）：超高分块循环打满，一次 padded 汇总应答。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # 本会话见过标记 → hook 在位
    _wire_pad_prompt(w)

    await w.handle_client(ClientMsg(type="pad", pad=120))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    pad_lines = [d for k, d in w.session.calls
                 if k == "raw" and b"__ot_pad" in d]
    assert pad_lines == [b"__ot_pad 50\r", b"__ot_pad 50\r", b"__ot_pad 20\r"]
    assert await _padded_rows(sink) == [120]


async def test_shell_pad_hook_gone_sends_nothing_acks(monkeypatch):
    r"""hook 不在位（su - 换壳探测失败等）：pad 零 PTY 写入仍应答 padded。

    没有 __ot_pad 通道，旧降级往提示符敲 ``__ot_pad N`` 只会连环 command
    not found + 提示符连排，前置 \x15 还连环吞用户输入（真机「打字不显示」
    根因之一）。宁藏不盖：不垫空行，卡由显隐/夹紧逻辑兜底。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0
    w._hook_gone = True          # su - 换壳：探测判定不可集成

    await w.handle_client(ClientMsg(type="pad", pad=5, mirror="rm -rf /tmp/x"))
    if w._pad_task is not None:
        await asyncio.wait_for(w._pad_task, timeout=2)
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [], "hook 不在位：不发 \\x15/__ot_pad/mirror 任何字节"
    assert await _padded_rows(sink) == [5]


def _wire_pad_lying_shell(w):
    """谎报型替身 send_raw：__ot_pad 敲进「标记照发、函数全空」的壳——
    su - 换壳后嵌套壳的 PS1/PROMPT_COMMAND 仍发 OSC 标记（_hook_ok 据此
    假阳性），但 __ot_pad 函数不存在：回显 live 带 command not found 指纹，
    随后提示符标记照常到达。"""
    sess = w.session
    base = sess.send_raw

    async def _raw(data):
        await base(data)
        if b"__ot_pad" in data:
            # 真实泵序：报错文本先到，嵌套壳的提示符标记后到
            await w.exec._on_stream_event(
                ("live", "bash: __ot_pad: command not found"))
            await w.exec._on_stream_event(("prompt_start", (1,)))
    sess.send_raw = _raw


async def test_shell_pad_fingerprint_dead_channel_stops_typing(monkeypatch):
    r"""谎报型死通道熔断（真机 su - 后横排提示符墙根因）：pad 回显带
    __ot_pad: command not found 指纹 → 当场判死 hook——本轮后续块不再敲、
    后续 pad 走 ack-only 零写入；padded 照常应答（显示由前端熔断/夹紧兜底），
    重注入成功/嵌套壳退出照既有语义复位。"""
    import time as _time
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # 标记流在 → _hook_ok 假阳性（谎报壳前提）
    _wire_pad_lying_shell(w)

    await w.handle_client(ClientMsg(type="pad", pad=120))   # 须 3 块：指纹后必须断
    if w._pad_task is not None:
        await asyncio.wait_for(w._pad_task, timeout=2)
    pad_lines = [d for k, d in w.session.calls
                 if k == "raw" and b"__ot_pad" in d]
    assert pad_lines == [b"__ot_pad 50\r"], "指纹判死后后续块不得再敲进裸壳"
    assert w._hook_gone is True, "当场判死：后续 pad / 健康路径都转降级"

    # 后续 pad：节流阀挡住 60s 兜底重注入，走 ack-only 零 PTY 写入
    w._pad_reinject_at = _time.monotonic() + 60
    n = len([c for c in w.session.calls if c[0] == "raw"])
    await w.handle_client(ClientMsg(type="pad", pad=3))
    if w._pad_task is not None:
        await asyncio.wait_for(w._pad_task, timeout=2)
    assert [d for k, d in w.session.calls if k == "raw"][n:] == [], \
        "判死后 pad 走 ack-only：零 PTY 写入"
    msgs = await _wait_json(sink, lambda m: len([
        x for x in m if x.get("type") == "event"
        and x.get("event", {}).get("kind") == "padded"]) >= 2)
    rows = [x["event"]["rows"] for x in msgs
            if x.get("type") == "event"
            and x.get("event", {}).get("kind") == "padded"]
    assert rows == [120, 3], "判死仍应答 padded（前端按缓冲实测夹紧）"


async def test_shell_pad_reinject_pending_acks_deferred_no_typing(monkeypatch):
    r"""任务起跑的重注入在途（外部触发链至 _run_task 落地才清位）：pad 不往
    壳里敲（窗口内壳未痊愈，敲进去必撞裸壳 = 真机残迹「__ot_pad: command
    not found + 提示符粘连」）；ack 带 deferred——前端不把「空白没长」计入
    熔断连败（慢链路重注入 1-4s，连续不增长会误熔断整 tab 停摆）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # _hook_ok 假阳性也照挡：pending 优先
    w._reinject_pending = True

    await w.handle_client(ClientMsg(type="pad", pad=5))
    if w._pad_task is not None:
        await asyncio.wait_for(w._pad_task, timeout=2)
    assert [d for k, d in w.session.calls if k == "raw"] == [], \
        "重注入在途：零 PTY 写入（不敲 \\x15/__ot_pad）"
    await _wait_json(sink, lambda m: any(
        x.get("type") == "event" and x.get("event", {}).get("kind") == "padded"
        and x["event"].get("deferred") is True for x in m))


async def test_shell_pad_hook_ok_uses_saved_yank_primitive(monkeypatch):
    r"""hook 在位：pad 半行保护走 shell 侧存档/接回原语（^U 存档、^Y 接回，
    空行零副作用、任务期打字与注入交错也能接回）——每块 \x15 配一 \x19，
    不再依赖前端 mirror 原样重打。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # 本会话见过标记 → hook 在位
    _wire_pad_prompt(w)

    await w.handle_client(ClientMsg(type="pad", pad=5, mirror="rm -rf /tmp/x"))
    if w._pad_task is not None:
        await asyncio.wait_for(w._pad_task, timeout=2)
    raws = [d for k, d in w.session.calls if k == "raw"]
    assert raws == [b"\x15", b"__ot_pad 5\r", b"\x19"], \
        "hook 在位：\\x15 + pad + \\x19 配对，不走 mirror 重打"
    assert await _padded_rows(sink) == [5]


async def test_shell_pad_prompt_timeout_still_acks(monkeypatch):
    """hook 在位但无响应（超时容忍）也照常应答 padded——应答不作为凭据，
    前端按缓冲实测记账。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._last_mark_at = 1.0        # hook 在位（否则走零写入早退）
    w._pad_prompt_timeout = 0.01   # 默认 FakeSession.send_raw 不置 _ev_prompt

    await w.handle_client(ClientMsg(type="pad", pad=5))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    assert await _padded_rows(sink) == [5]


async def test_pad_requires_interactive(monkeypatch):
    """非交互模式（无 hook）：pad 请求直接忽略，不应答 padded。"""
    w, sink = await _make_worker(monkeypatch)
    w._interactive = False

    await w.handle_client(ClientMsg(type="pad", pad=5))
    if w._pad_task is not None:  # pad 已挂任务：等打字完再验（非交互不挂）
        await asyncio.wait_for(w._pad_task, timeout=2)
    await asyncio.sleep(0.05)
    assert not any(m.get("type") == "event"
                   and m.get("event", {}).get("kind") == "padded"
                   for m in sink.json())


async def test_worker_exec_end_cross_instance_collapses_injection_frame(monkeypatch):
    """注入 eval 行的 C 带旧实例号、它自己的 D 带新实例号（eval 刚把 __ot_i
    推进新号段）：这个 D 必须跨实例收束那个 silent 帧。

    按「旧实例的 D 一律忽略」的话帧永不闭合，此后每条 exec 字节都被当静默帧
    输出吞掉——真机 2026-10-08：命令集换壳后密码提示、Last login、嵌套壳提示
    符全不上屏，只剩 live 回显；缺了 exec 里的换行，后续重绘把历史逐条砸在同
    一行上（屏幕塌成两三行）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._exec_stack.append({"ctx": "silent", "inst": 1, "inj": True,
                          "line": 'eval "$(echo "$__ot_inj" | base64 -d)"'})
    await w.exec._on_exec_end(100000, 0, "/root")
    assert w._exec_stack == [], "注入帧未跨实例收束（此后 exec 字节全被吞）"
    await w.exec._on_exec_text("Last login: Thu Oct  8 23:12:52 CST 2026 on pts/2")
    await asyncio.sleep(0.02)
    assert any(m[0] == "bytes" and b"Last login" in m[1] for m in sink.messages),         "收束后 exec 字节仍被吞（真机整屏只剩回显的根因）"


async def test_worker_exec_end_mismatch_keeps_non_injection_frame(monkeypatch):
    """非注入帧的实例号不匹配仍按「旧实例的 D」忽略：外层 ssh 帧不能被别的
    实例号收束掉，否则嵌套壳的输出会漏进主屏。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    w._interactive = True
    w._exec_stack.append({"ctx": "silent", "inst": 7, "line": "ssh x@h"})
    await w.exec._on_exec_end(9, 0, None)
    assert [f["inst"] for f in w._exec_stack] == [7], "非注入帧被跨实例弹出"


def _armed_core() -> PipelineCore:
    return _bare_core(_intr_swallow_until=_time.monotonic() + 10.0,
                      _intr_pending=b"")


def test_strip_intr_echo_exact_two_bytes():
    """bash 在半行尾回显 "^C"：恰好吞这两字节，换行与提示符照常透传。"""
    c = _armed_core()
    assert c.exec._strip_intr_echo("查看backend资源^C\r\n# ".encode()) == \
        "查看backend资源\r\n# ".encode()
    # 吞完即解除武装：后续字面 ^C 不再吞
    assert c._intr_swallow_until == 0.0
    assert c.exec._strip_intr_echo(b"^C") == b"^C"


def test_strip_intr_echo_cross_chunk_caret():
    """"^" 与 "C" 分属两块：悬置跨块匹配；非 C 开头原样放回不丢字面 ^。"""
    c = _armed_core()
    assert c.exec._strip_intr_echo(b"abc^") == b"abc"
    assert c.exec._strip_intr_echo(b"C\r\n") == b"\r\n"
    c = _armed_core()
    assert c.exec._strip_intr_echo(b"abc^") == b"abc"
    assert c.exec._strip_intr_echo(b"x\r\n") == b"^x\r\n"   # 不是回显：放回


def test_strip_intr_echo_expiry_releases_pending():
    """窗口过期（zsh 不回显 ^C）：悬置的块尾 ^ 原样补放，零丢字节。"""
    c = _bare_core(_intr_swallow_until=_time.monotonic() - 1.0,
                   _intr_pending=b"^")
    assert c.exec._strip_intr_echo(b"next") == b"^next"
    assert c._intr_swallow_until == 0.0


def test_execevents_owns_state():
    from openterminal.core.exec_events import ExecEvents
    core = FakeCore()
    ExecEvents(core)
    for attr in ("_open_cmds", "_open_cmd_at", "_exec_stack", "_exec_buf",
                 "_suppress_live", "_curtain", "_curtain_parts",
                 "_tool_card_seq", "_tool_idx_map", "_intr_swallow_until",
                 "_intr_pending", "_user_out", "_pad_inflight"):
        assert hasattr(core, attr), attr


def test_execevents_preserves_presets():
    from openterminal.core.exec_events import ExecEvents
    core = FakeCore()
    core._open_cmds = {1: "ssh wujian@1.2.3.4"}
    ExecEvents(core)
    # hasattr 守卫：裸构造测试在 core 上预置的值不得被初始化覆盖
    assert core._open_cmds == {1: "ssh wujian@1.2.3.4"}


def test_strip_intr_echo_passthrough_normal():
    from openterminal.core.exec_events import ExecEvents
    e = ExecEvents(FakeCore())
    assert e.strip_intr_echo(b"ls\r\n$ ") == b"ls\r\n$ "  # 正常字节原样透传


def test_core_lazy_exec_property():
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    assert core.exec is core.exec
