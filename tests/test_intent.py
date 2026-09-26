"""intent 单测（单管线 §5.1）：启发式全删，只留 hook 前缀 + LLM 兜底。"""
import pytest

from openterminal.intent import IntentClassifier


def _llm(answer="command", calls=None, fail=False):
    async def _cls(text):
        if calls is not None:
            calls.append(text)
        if fail:
            raise RuntimeError("llm down")
        return answer
    return _cls


@pytest.mark.asyncio
async def test_empty_is_task():
    c = IntentClassifier()
    assert await c.classify("") == "task"
    assert await c.classify("   ") == "task"


@pytest.mark.asyncio
async def test_bang_forces_command():
    c = IntentClassifier(llm_classify=_llm("task"))
    assert await c.classify("!ls -la") == "command"


@pytest.mark.asyncio
async def test_question_forces_ai():
    c = IntentClassifier(llm_classify=_llm("command"))
    assert await c.classify("?ls -la") == "task"


@pytest.mark.asyncio
async def test_slash_is_task_without_llm():
    # 斜杠命令由 worker 拦截，分类器直接归 task 且不进 LLM
    calls = []
    c = IntentClassifier(llm_classify=_llm("command", calls))
    assert await c.classify("/clear") == "task"
    assert calls == []


@pytest.mark.asyncio
async def test_unknown_slash_falls_to_llm():
    # 绝对路径命令不被斜杠命令分支吞掉（真机：/usr/bin/x 被整行送 AI）
    calls = []
    c = IntentClassifier(llm_classify=_llm("command", calls))
    assert await c.classify("/usr/local/bin/tool --flag") == "command"
    assert calls == ["/usr/local/bin/tool --flag"]
    # 带参数的已知斜杠命令仍直接归 task
    assert await c.classify("/target prod-web") == "task"


@pytest.mark.asyncio
async def test_llm_fallback_command():
    c = IntentClassifier(llm_classify=_llm("command"))
    assert await c.classify("systemctl restart nginx") == "command"


@pytest.mark.asyncio
async def test_llm_fallback_task():
    c = IntentClassifier(llm_classify=_llm("task"))
    assert await c.classify("看看磁盘占用") == "task"


@pytest.mark.asyncio
async def test_llm_receives_stripped_text():
    calls = []
    c = IntentClassifier(llm_classify=_llm("command", calls))
    await c.classify("  df -h  ")
    assert calls == ["df -h"]


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_task():
    c = IntentClassifier(llm_classify=_llm(fail=True))
    assert await c.classify("df -h") == "task"


@pytest.mark.asyncio
async def test_no_llm_defaults_task():
    # 无 LLM 时除前缀外一律归 task（误判双向无损，见 §5.1）
    c = IntentClassifier()
    assert await c.classify("ls -la") == "task"
    assert await c.classify("sudo systemctl restart nginx") == "task"
