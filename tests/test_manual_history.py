"""手动命令摘要（core/manual_history.py）与它的 agent 中间件。

背景：用户在终端自己敲的命令不在 agent 消息历史里（_run_task 只交自然语言
原文），模型不知道刚才发生了什么。全塞进上下文又太占，所以做成分层摘要 +
增量注入。

「进消息历史而不是系统提示词」是这里的关键取舍：系统提示词一换就作废整段
前缀缓存，改写末条消息则前面照旧命中缓存。
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from openterminal.agent.middleware import ManualHistoryMiddleware
from openterminal.core.manual_history import (
    TAIL_FAIL, TAIL_OK, ManualHistory, redact,
)


def via_wrap(mw, req):
    """走框架真实入口 wrap_model_call。

    modify_request 只是中间件自己的辅助函数，框架并不调它——直接调它测不出
    「钩子没挂上」这种错（实测踩过：单测全绿、真机一个字都不注入）。
    """
    seen = {}

    def handler(r):
        seen["r"] = r
        return r

    mw.wrap_model_call(req, handler)
    return seen["r"]


class FakeRequest:
    def __init__(self, messages):
        self.messages = messages
        self.system_message = None

    def override(self, **kw):
        return FakeRequest(kw["messages"] if "messages" in kw else self.messages)


# --- 摘要本体 ---

def test_take_new_is_incremental_and_never_repeats():
    """增量：送过就不再给，上下文只随新命令增长。"""
    h = ManualHistory()
    h.record("docker ps", 0, "CONTAINER ID\nabc\n")
    first = h.take_new()
    assert "docker ps" in first
    assert h.take_new() == "", "同一批命令不能一轮轮重复注入"

    h.record("ls -la", 0, "")
    second = h.take_new()
    assert "ls -la" in second
    assert "docker ps" not in second, "只给增量，不重发旧的"


def test_success_keeps_short_tail_failure_keeps_long_tail():
    """分层：成功短尾（看结论），失败长尾（看报错）。"""
    ok = ManualHistory()
    ok.record("docker ps", 0, "ok\n" * 400)
    ok_text = ok.take_new()

    bad = ManualHistory()
    bad.record("make test", 1, "boom\n" * 400)
    bad_text = bad.take_new()

    assert len(ok_text) < len(bad_text), "失败那条要给更多上下文"
    assert len(ok_text) < TAIL_OK + 300
    assert len(bad_text) < TAIL_FAIL + 300, "但也要封顶"
    assert "boom" in bad_text


def test_summary_counts_lines_and_flags_truncation():
    h = ManualHistory()
    h.record("cat big.log", 0, "\n".join(f"line{i}" for i in range(500)))
    text = h.take_new()
    assert "输出 500 行" in text, "行数让模型知道被截掉了多少"
    assert "已截断" in text


def test_ctrl_c_is_not_treated_as_failure():
    """130/143 是用户自己中断，不是失败——按成功给短尾，不占长尾预算。"""
    h = ManualHistory()
    h.record("sleep 999", 130, "x" * 2000)
    text = h.take_new()
    assert "退出 130" in text
    assert len(text) < TAIL_OK + 300, "中断不该按失败吃长尾预算"


def test_ring_buffer_drops_old_commands():
    h = ManualHistory(limit=3)
    for i in range(5):
        h.record(f"cmd{i}", 0, "")
    text = h.take_new()
    assert "cmd4" in text and "cmd2" in text
    assert "cmd0" not in text, "窗口外的旧命令不该进上下文"


def test_record_ignores_blank_command():
    h = ManualHistory()
    h.record("   ", 0, "out")
    assert h.take_new() == ""


# --- 脱敏 ---

def test_redact_strips_key_values_but_keeps_key_names():
    assert "sk-live-1234567890" not in redact("API_KEY=sk-live-1234567890")
    assert "API_KEY=" in redact("API_KEY=sk-live-1234567890")


def test_redact_strips_bearer_token_whole():
    """回归：只脱 Bearer 留下 token 等于没脱。"""
    out = redact("Authorization: Bearer abc123def456ghi")
    assert "abc123def456ghi" not in out
    assert "Bearer ***" in out


def test_record_redacts_before_summary():
    h = ManualHistory()
    h.record("curl -H 'X: y' https://x", 0, "token: supersecretvalue99")
    assert "supersecretvalue99" not in h.take_new()


# --- 中间件：进消息历史 ---

def test_middleware_augments_latest_message():
    """并进末条消息，而不是改系统提示词（保住前缀缓存）。"""
    mw = ManualHistoryMiddleware(lambda: "【手动命令】\n- `docker ps`")
    req = FakeRequest([HumanMessage(content="帮我看看有哪些容器")])
    out = via_wrap(mw,req)
    assert out.system_message is None, "不该动系统提示词"
    assert len(out.messages) == 1, "并进末条，不新增消息"
    assert "帮我看看有哪些容器" in out.messages[0].content
    assert "docker ps" in out.messages[0].content


def test_middleware_augments_tool_message_when_last():
    """末条是工具结果时同样并进去——不新增消息，免得打断 tool_use/tool_result。"""
    mw = ManualHistoryMiddleware(lambda: "【手动命令】\n- `ls`")
    req = FakeRequest([AIMessage(content=""), AIMessage(content="")])
    req.messages[-1] = AIMessage(content="我查一下")
    out = via_wrap(mw,req)
    assert len(out.messages) == 2
    assert "ls" in out.messages[-1].content


def test_middleware_appends_human_message_when_history_empty():
    mw = ManualHistoryMiddleware(lambda: "【手动命令】\n- `ls`")
    out = via_wrap(mw,FakeRequest([]))
    assert len(out.messages) == 1
    assert isinstance(out.messages[0], HumanMessage)


def test_middleware_noop_when_nothing_new():
    mw = ManualHistoryMiddleware(lambda: "")
    req = FakeRequest([HumanMessage(content="hi")])
    out = via_wrap(mw,req)
    assert out.messages[0] is req.messages[0], "没新东西就一个字都别动"


def test_middleware_survives_provider_failure():
    """摘要是加分项：数据源炸了绝不能挡住模型调用。"""
    def boom():
        raise RuntimeError("nope")

    mw = ManualHistoryMiddleware(boom)
    req = FakeRequest([HumanMessage(content="hi")])
    assert via_wrap(mw,req).messages[0] is req.messages[0]


def test_middleware_accepts_the_history_object_not_just_a_callable():
    """回归：传对象（而不是 take_new 方法）也要工作。

    实测踩过：build_agent 那侧传的是 ManualHistory 对象，中间件却把它当
    函数调用，于是取不到任何摘要、静默不注入——只有真机才能暴露。
    """
    h = ManualHistory()
    h.record("docker ps", 0, "CONTAINER ID\n")
    mw = ManualHistoryMiddleware(h)
    out = via_wrap(mw,FakeRequest([HumanMessage(content="看看")]))
    assert "docker ps" in out.messages[-1].content


def test_middleware_without_provider_is_noop():
    req = FakeRequest([HumanMessage(content="hi")])
    assert via_wrap(ManualHistoryMiddleware(None), req) is req


def test_middleware_async_hook_also_works():
    """真实链路走 astream → awrap_model_call，同步那份够不着。"""
    import asyncio

    mw = ManualHistoryMiddleware(lambda: "【手动命令】\n- `ls`")
    req = FakeRequest([HumanMessage(content="hi")])
    seen = {}

    async def handler(r):
        seen["r"] = r
        return r

    asyncio.run(mw.awrap_model_call(req, handler))
    assert "ls" in seen["r"].messages[-1].content


# --- 装配 ---

def test_build_agent_wires_manual_history(monkeypatch):
    from openterminal.agent import build as B
    from openterminal.agent.sysprobe import SystemProfile
    from openterminal.config import Config

    captured: dict = {}
    real = B.create_deep_agent

    def spy(**kwargs):
        captured.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(B, "create_deep_agent", spy)
    profile = SystemProfile(
        host="local", os_family="debian", distro="Ubuntu", version="22.04",
        kernel="5.15", pkg_manager="apt", service_mgr="systemd",
        shell="/bin/bash", tools={},
    )

    class S:
        cwd = "/tmp"

    history = ManualHistory()
    # 传对象而不是 take_new 方法——与 core/ai_flow.py 的真实接线一致
    B.build_agent(profile, S(), Config.load(), manual_history=history)
    names = [type(m).__name__ for m in captured["middleware"]]
    assert "ManualHistoryMiddleware" in names

    captured.clear()
    B.build_agent(profile, S(), Config.load())
    names = [type(m).__name__ for m in captured["middleware"]]
    assert "ManualHistoryMiddleware" not in names, "没数据源就不该挂"
