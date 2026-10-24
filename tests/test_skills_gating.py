"""技能启用开关的 agent 侧行为（skills/gating.py）。

过滤点选在 `_format_skills_list` 而不是 `before_agent`，是有意为之：
`modify_request` 每轮都从 state 取清单再格式化提示词，所以在这里过滤能让
设置页的开关**下一轮对话即生效**。若过滤写进 `before_agent`，清单会被
thread 缓存住，只有重建 agent 才刷新，而重建会新建 MemorySaver、清空对话。
"""

from __future__ import annotations

from deepagents.backends import CompositeBackend, FilesystemBackend

from openterminal.skills import skill_routes, skill_sources, store
from openterminal.skills.gating import GatedSkillsMiddleware
from openterminal.skills.store import user_skill_dir


def _write_skill(name: str, description: str) -> None:
    d = user_skill_dir(name)
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n正文\n",
        encoding="utf-8")


def _middleware() -> GatedSkillsMiddleware:
    """与 build._with_skills 同一套挂载，行为对齐真实 agent。"""
    routes = skill_routes()
    composite = CompositeBackend(
        default=FilesystemBackend(root_dir=".", virtual_mode=False),
        routes={p: FilesystemBackend(root_dir=str(d)) for p, d in routes.items()},
    )
    return GatedSkillsMiddleware(backend=composite, sources=skill_sources())


def _loaded_skills() -> list[dict]:
    update = _middleware().before_agent({}, runtime=None, config=None) or {}
    return update.get("skills_metadata", [])


def test_disabled_skill_disappears_from_prompt():
    _write_skill("alpha-skill", "第一个技能")
    _write_skill("beta-skill", "第二个技能")
    skills = _loaded_skills()
    names = {s["name"] for s in skills}
    assert {"alpha-skill", "beta-skill"} <= names

    mw = _middleware()
    text = mw._format_skills_list(skills)
    assert "alpha-skill" in text and "beta-skill" in text

    store.set_enabled("alpha-skill", False)
    text = mw._format_skills_list(skills)
    assert "alpha-skill" not in text, "停用的 skill 不能出现在模型可见的清单里"
    assert "beta-skill" in text, "其余 skill 不受影响"

    store.set_enabled("alpha-skill", True)
    text = mw._format_skills_list(skills)
    assert "alpha-skill" in text, "重新启用要立刻回来，无需重建 agent"


def test_builtin_skill_cannot_be_switched_off():
    """内置技能恒启用：停用请求不该让它从模型可见的清单里消失。"""
    store.set_enabled("markdown-tables", False)
    skills = _loaded_skills()
    text = _middleware()._format_skills_list(skills)
    assert "markdown-tables" in text, "内置技能没有开关，必须始终出现在清单里"


def test_all_disabled_says_so_instead_of_prompting_to_create():
    """全被关掉时别沿用基类那句「你可以创建 skill」——会诱导模型去新建。"""
    _write_skill("only-skill", "唯一技能")
    skills = [s for s in _loaded_skills() if s["name"] == "only-skill"]
    assert skills
    store.set_enabled("only-skill", False)
    text = _middleware()._format_skills_list(skills)
    assert "disabled" in text.lower()
    assert "create skills" not in text.lower()


def test_before_agent_still_loads_full_metadata():
    """清单本身照旧入 state（只是提示词被过滤）——这样开关才能来回切。"""
    _write_skill("gamma-skill", "第三个技能")
    store.set_enabled("gamma-skill", False)
    names = {s["name"] for s in _loaded_skills()}
    assert "gamma-skill" in names
