"""输出泵责任链（core/pump.py）域测试：幕帘四相位/泵取消传播/组件冒烟（Task 10 分流）。"""

import asyncio
from openterminal.core import PipelineCore
from tests.web_fakes import (_fake_ai_task, _make_worker, _sink_bytes, _wait)
from tests.core_fakes import FakeCore


async def test_worker_stop_pump_propagates_outer_cancel(monkeypatch):
    """取消吞噬回归：外层任务在 `await t`（等泵退出）上被取消时，取消会
    传导给泵任务、泵的 CancelledError 从 _stop_pump 冒出。若被吞，外层
    任务变成杀不死的僵尸——asyncio teardown 的 cancel_all gather 挂死。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await w.pump._stop_pump()                 # 停掉真泵，换可控的假泵

    # 假泵：被 cancel 后拖 0.3s 才死（外层的第二次取消会打断休眠立即死），
    # 给外层任务留出"挂在等泵退出上被取消"的窗口
    async def eternal():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            try:
                await asyncio.sleep(0.3)
            except asyncio.CancelledError:
                pass
            raise

    w._pump = asyncio.create_task(eternal())

    outcome = {}

    async def stopper():
        try:
            await w.pump._stop_pump()
            outcome["r"] = "returned"
        except asyncio.CancelledError:
            outcome["r"] = "cancelled"
            raise
        except BaseException as e:  # noqa: BLE001 - 测试观察用
            outcome["r"] = repr(e)

    t = asyncio.create_task(stopper())
    await asyncio.sleep(0.05)          # 让 stopper 挂在等泵任务上
    assert not t.done()
    t.cancel()
    try:
        await t
    except asyncio.CancelledError:
        pass
    assert outcome["r"] == "cancelled"   # 外层取消必须穿透，不得被吞
    assert w._pump is None               # 泵已停
    await w.close()


async def test_prompt_curtain_holds_prompt_during_task(monkeypatch):
    r"""任务运行期 prompt_start 关帘：提示符重绘的 live 文本扣住不发，
    开帘时按原序一次放行（对话未结束底部不出现空提示符）。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    t = _fake_ai_task(w)
    await w.exec._on_stream_event(("prompt_start", 1))
    assert w._curtain, "任务期 A 标记应关帘"
    await w.exec._on_stream_event(("live", "[root@x ~]# "))
    await w.exec._on_stream_event(("live", " 杂散回显"))
    await _wait(lambda: len(sink.messages) > 0 or True)   # 让 outbox 排空一拍
    await asyncio.sleep(0.05)
    assert b"root@x" not in _sink_bytes(sink), "扣留期提示符不得外发"
    assert w._curtain_parts == ["[root@x ~]# ", " 杂散回显"]
    await w.exec._curtain_open()
    assert not w._curtain and w._curtain_parts == []
    await _wait(lambda: b"root@x" in _sink_bytes(sink))
    assert " 杂散回显".encode() in _sink_bytes(sink), "放行须按原序完整"
    t.cancel()


async def test_prompt_curtain_opens_on_pty_write(monkeypatch):
    r"""幕帘关着时任何 PTY 写入先开帘再写（命令/pad/口令注入全经
    session.send_raw，含 runner 直写）——字节序不变，只后移可见时机。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    t = _fake_ai_task(w)
    await w.exec._on_stream_event(("prompt_start", 1))
    await w.exec._on_stream_event(("live", "[root@x ~]# "))
    await w.session.send_raw(b"ls -la\r")
    await _wait(lambda: b"root@x" in _sink_bytes(sink))
    assert not w._curtain, "写入应开帘"
    assert ("raw", b"ls -la\r") in w.session.calls
    t.cancel()


async def test_prompt_curtain_idle_no_hold(monkeypatch):
    """空闲期（无任务）提示符照常透传，不关帘。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    assert w._ai_task is None
    await w.exec._on_stream_event(("prompt_start", 1))
    assert not w._curtain
    await w.exec._on_stream_event(("live", "[root@x ~]# "))
    await _wait(lambda: b"root@x" in _sink_bytes(sink))


async def test_prompt_curtain_released_at_task_end(monkeypatch):
    """任务收尾（_ai_flow finally）开帘：结束后 prompt_start 不再关帘。"""
    w, sink = await _make_worker(monkeypatch)
    await asyncio.wait_for(w.connected.wait(), timeout=2)

    async def _fake_run(text, hooked=False):
        return

    monkeypatch.setattr(w.ai, "_run_task", _fake_run)
    w.ai._start_ai("查资源")
    await _wait(lambda: w._ai_task is None or w._ai_task.done(), timeout=5)
    t = _fake_ai_task(w)   # 幕帘再次关上（模拟下一任务中段）
    await w.exec._on_stream_event(("prompt_start", 1))
    await w.exec._on_stream_event(("live", "[root@x ~]# "))
    assert w._curtain
    # 模拟任务收尾路径本身的开帘（_ai_flow finally 同款调用）
    await w.exec._curtain_open()
    await _wait(lambda: b"root@x" in _sink_bytes(sink))
    t.cancel()


def test_outputpump_owns_state():
    from openterminal.core.pump import OutputPump
    p = OutputPump(FakeCore())
    assert p.phase == "read"   # core.py:560 初始值


def test_core_lazy_pump_property():
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    assert core.pump is core.pump
