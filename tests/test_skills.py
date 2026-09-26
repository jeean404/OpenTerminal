"""内置 skill 机制测试。

OpenTerminal 的 skill 采用 Anthropic Agent Skills 约定（目录/SKILL.md +
frontmatter），加载与渐进式披露由 deepagents 原生 SkillsMiddleware 完成，
本项目只负责：打包内置 skill 目录 + 把内置/用户两层目录以 /skills/...
虚拟前缀挂进 agent 文件系统（CompositeBackend 路由）。
"""

from pathlib import Path

import pytest
from deepagents.backends import CompositeBackend, FilesystemBackend
from deepagents.middleware.skills import SkillsMiddleware

from openterminal.skills import (
    BUILTIN_PREFIX,
    USER_PREFIX,
    skill_routes,
    skill_sources,
    user_skills_dir,
)


def _scan(sources, routes):
    """用与 agent 相同的中间件 + 组合后端扫描，返回 (skills dict, errors)。"""
    composite = CompositeBackend(
        default=FilesystemBackend(root_dir=".", virtual_mode=False),
        routes={p: FilesystemBackend(root_dir=str(d)) for p, d in routes.items()},
    )
    mw = SkillsMiddleware(backend=composite, sources=sources)
    update = mw.before_agent({}, runtime=None, config=None) or {}
    skills = {s["name"]: s for s in update.get("skills_metadata", [])}
    return composite, skills, update.get("skills_load_errors", [])


def test_builtin_skill_discoverable():
    """打包在项目里的 markdown-tables 必须能被加载机制发现且校验通过。"""
    _, skills, errors = _scan(skill_sources(), skill_routes())
    assert errors == []
    assert "markdown-tables" in skills
    s = skills["markdown-tables"]
    assert "table" in s["description"].lower()
    assert s["path"] == f"{BUILTIN_PREFIX}markdown-tables/SKILL.md"


def test_model_can_read_skill_via_composite():
    """模型视角：read_file 虚拟路径能取到 SKILL.md 全文（渐进式披露的加载步）。"""
    composite, _, _ = _scan(skill_sources(), skill_routes())
    r = composite.read(f"{BUILTIN_PREFIX}markdown-tables/SKILL.md",
                      offset=0, limit=10)
    assert r.error is None
    assert r.file_data["content"].startswith("---\nname: markdown-tables")


def test_skill_sources_builtin_first():
    """sources 首个必须是内置挂载点（标签：内置）。"""
    sources = skill_sources()
    assert sources[0] == (BUILTIN_PREFIX, "内置")


def test_skill_sources_appends_user_dir(monkeypatch, tmp_path):
    """用户目录存在时追加为第二源（后源覆盖先源）。"""
    (tmp_path / "my-skill").mkdir()
    monkeypatch.setattr("openterminal.skills.user_skills_dir", lambda: tmp_path)
    sources = skill_sources()
    assert sources[1] == (USER_PREFIX, "用户")


def test_skill_sources_omits_missing_user_dir(monkeypatch, tmp_path):
    """用户目录不存在时只留内置源，避免无意义的加载告警。"""
    monkeypatch.setattr(
        "openterminal.skills.user_skills_dir",
        lambda: tmp_path / "nope",
    )
    assert skill_sources() == [(BUILTIN_PREFIX, "内置")]
    assert skill_routes() == {BUILTIN_PREFIX: skill_routes()[BUILTIN_PREFIX]}


def test_user_skill_overrides_builtin(monkeypatch, tmp_path):
    """同名 skill 用户版覆盖内置版（last one wins）。"""
    d = tmp_path / "markdown-tables"
    d.mkdir()
    (d / "SKILL.md").write_text(
        "---\nname: markdown-tables\ndescription: 用户覆盖版\n---\n\n正文\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("openterminal.skills.user_skills_dir", lambda: tmp_path)
    _, skills, _ = _scan(skill_sources(), skill_routes())
    assert skills["markdown-tables"]["description"] == "用户覆盖版"


def test_user_skills_dir_default_location():
    """默认用户目录是 ~/.openterminal/skills。"""
    assert user_skills_dir() == Path.home() / ".openterminal" / "skills"


def test_with_skills_wraps_backend_and_registers_middleware():
    """_with_skills：backend 包成 CompositeBackend，SkillsMiddleware 入列。"""
    from openterminal.agent import _with_skills

    class FakeBackend:
        pass

    middleware: list = []
    wrapped = _with_skills(FakeBackend(), middleware)
    assert isinstance(wrapped, CompositeBackend)
    assert wrapped.default is not None
    assert any(isinstance(m, SkillsMiddleware) for m in middleware)


def test_malformed_skill_skipped_without_breaking_scan(tmp_path):
    """缺 description 的 SKILL.md 被跳过，不阻断其他 skill 加载。"""
    d = tmp_path / "broken"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: broken\n---\n\n正文\n", encoding="utf-8")
    good = tmp_path / "good-skill"
    good.mkdir()
    (good / "SKILL.md").write_text(
        "---\nname: good-skill\ndescription: 正常的 skill\n---\n\n正文\n",
        encoding="utf-8",
    )
    _, skills, _ = _scan([(str(tmp_path), "测试")],
                         {"/skills/test/": tmp_path})
    assert "broken" not in skills
    assert "good-skill" in skills
