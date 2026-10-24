"""复杂任务的待办清单：write_todos 工具 + 工具卡正文。

背景：模型对多步任务本该先列待办再逐项推进，但 deepagents 的默认工具面
（ls/read_file/write_file/edit_file/glob/grep/execute/task）里**没有**待办工具
——TodoListMiddleware（langchain 自带，提供 write_todos）没被挂进中间件栈，
模型根本没有可调的工具，前端也就长不出待办卡。这里钉住两半：

  1. 装配：中间件栈里有 TodoListMiddleware，且它真的交出 write_todos；
  2. 卡片：write_todos 的入参 todos 是列表，通用摘要只取字符串参数会返回空
     （空壳卡），必须按清单渲染。
"""

from openterminal.agent.runner import _tool_args_summary, _todos_summary


TODOS = [
    {"content": "收集需求", "status": "completed"},
    {"content": "写实现", "status": "in_progress"},
    {"content": "补测试", "status": "pending"},
]


# --- 装配 ---

def test_build_agent_wires_todo_tool(monkeypatch):
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

    B.build_agent(profile, S(), Config.load())
    mws = captured["middleware"]
    todo = [m for m in mws if type(m).__name__ == "TodoListMiddleware"]
    assert todo, "复杂任务要能列待办，中间件栈必须挂 TodoListMiddleware"
    names = [t.name for t in todo[0].tools]
    assert "write_todos" in names, f"实际交出的工具：{names}"


# --- 工具卡正文 ---

def test_todo_args_render_as_checklist():
    """列表入参不能走通用摘要（只取字符串参数 → 空壳卡）。"""
    text = _tool_args_summary("write_todos", {"todos": TODOS})
    lines = text.splitlines()
    assert len(lines) == 3
    assert lines[0].startswith("✓") and "收集需求" in lines[0]
    assert lines[1].startswith("▸") and "写实现" in lines[1]
    assert lines[2].startswith("○") and "补测试" in lines[2]


def test_todo_summary_counts_and_order():
    """序号按入参顺序，状态符号一一对应，不把内容挤成一行。"""
    assert _todos_summary(TODOS) == chr(10).join([
        "✓ 1. 收集需求", "▸ 2. 写实现", "○ 3. 补测试",
    ])


def test_todo_summary_is_capped():
    """待办可以很长：卡正文封顶，别把卡片撑满屏。"""
    many = [{"content": "t%d" % i, "status": "pending"} for i in range(60)]
    assert len(_todos_summary(many).splitlines()) == 20


def test_todo_summary_survives_junk_items():
    """模型偶尔吐脏数据（缺字段/非 dict）不该让整张卡炸掉。"""
    text = _todos_summary([None, "x", {"content": "  前后空白  "}, {}])
    # 脏项不占序号、空内容不留符号行：清单只列真正渲染出来的项
    assert text == "○ 1. 前后空白"


def test_other_tools_keep_short_summary():
    """非待办工具的摘要行为不变。"""
    assert _tool_args_summary("read_file", {"file_path": "/etc/hosts"}) == "/etc/hosts"
    assert _tool_args_summary("glob", {"pattern": "*.py"}) == "*.py"
