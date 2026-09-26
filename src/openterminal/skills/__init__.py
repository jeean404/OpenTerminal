"""内置 Agent Skills（数据包）。

目录结构遵循 Anthropic Agent Skills 约定：每个 skill 一个子目录，
内含带 YAML frontmatter（name + description）的 SKILL.md。加载、
校验与渐进式披露由 deepagents 的 SkillsMiddleware 完成（见 agent.py
的 build_agent），本包只承载数据并描述内置/用户两层挂载点。

挂载方式：内置与用户目录都不在 agent 文件沙箱（shell cwd）内，故经
CompositeBackend 以虚拟前缀挂进文件系统——模型用 read_file 读
/skills/.../SKILL.md 即可加载全文，用户目录后挂、同名覆盖内置。
"""

from __future__ import annotations

from pathlib import Path

# 打包后的内置 skill 根目录（wheel/sdist 均为真实目录）
BUILTIN_DIR = Path(__file__).resolve().parent

# 虚拟挂载前缀：出现在系统提示词与模型 read_file 的路径里
BUILTIN_PREFIX = "/skills/builtin/"
USER_PREFIX = "/skills/user/"


def user_skills_dir() -> Path:
    """用户级 skill 目录：同名 skill 覆盖内置版。"""
    return Path.home() / ".openterminal" / "skills"


def skill_routes() -> dict[str, Path]:
    """虚拟前缀 → 实际 skill 目录。用户目录不存在时不挂载，
    避免无意义的加载告警。"""
    routes = {BUILTIN_PREFIX: BUILTIN_DIR}
    user = user_skills_dir()
    if user.is_dir():
        routes[USER_PREFIX] = user
    return routes


def skill_sources() -> list[tuple[str, str]]:
    """SkillsMiddleware 的 sources：内置在前、用户在后（后源覆盖先源）。"""
    return [
        (prefix, "内置" if prefix == BUILTIN_PREFIX else "用户")
        for prefix in skill_routes()
    ]
