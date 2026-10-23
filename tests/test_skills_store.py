"""技能管理面（skills/store.py）：清单、增删导入、启停。"""

from __future__ import annotations

import io
import zipfile

import pytest

from openterminal.skills import store
from openterminal.skills.store import (
    SkillError, SkillNotFound, delete_skill, disabled_names, get_skill,
    import_skill_dir, install_skill_archive, list_skills, set_enabled,
    user_skill_dir,
)


def _write_skill(name: str, description: str, body: str = "正文\n") -> None:
    d = user_skill_dir(name)
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}",
        encoding="utf-8")


def test_list_includes_builtin_and_user():
    """内置 skill 一定在清单里；用户 skill 合并进来，且默认是启用的。"""
    _write_skill("my-skill", "用户自建技能")
    names = {s["name"]: s for s in list_skills()}
    assert "markdown-tables" in names, "内置 skill 必须出现在清单"
    assert names["markdown-tables"]["builtin"] is True
    assert names["my-skill"]["builtin"] is False
    assert names["my-skill"]["enabled"] is True
    assert names["my-skill"]["overridden"] is False


def test_user_skill_marks_overridden_builtin():
    """同名用户版覆盖内置版，清单要如实标注（UI 据此提示「删除后回退」）。"""
    _write_skill("markdown-tables", "用户覆盖版")
    entry = {s["name"]: s for s in list_skills()}["markdown-tables"]
    assert entry["builtin"] is False
    assert entry["overridden"] is True
    assert entry["description"] == "用户覆盖版"


def test_toggle_roundtrip_defaults_to_enabled():
    _write_skill("switchable", "可开关")
    assert "switchable" not in disabled_names()
    set_enabled("switchable", False)
    assert "switchable" in disabled_names()
    assert {s["name"]: s for s in list_skills()}["switchable"]["enabled"] is False
    set_enabled("switchable", True)
    assert "switchable" not in disabled_names()
    assert not disabled_names(), "全启用时不应残留任何停用记录"


def test_delete_user_skill_reverts_to_builtin():
    """删掉用户覆盖版 = 回退内置版，不是整个 skill 消失。"""
    _write_skill("markdown-tables", "用户覆盖版")
    result = delete_skill("markdown-tables")
    assert result == {"deleted": True, "name": "markdown-tables",
                      "reverted_to_builtin": True}
    entry = {s["name"]: s for s in list_skills()}["markdown-tables"]
    assert entry["builtin"] is True


def test_delete_builtin_skill_is_refused():
    with pytest.raises(SkillError, match="内置"):
        delete_skill("markdown-tables")


def test_delete_unknown_skill_raises():
    with pytest.raises(SkillNotFound):
        delete_skill("nope-not-here")


def test_delete_clears_stale_disabled_flag():
    """先停用再删用户版后，回退出来的内置版不该一上来就是关的。"""
    _write_skill("markdown-tables", "用户覆盖版")
    set_enabled("markdown-tables", False)
    delete_skill("markdown-tables")
    assert "markdown-tables" not in disabled_names()


def test_create_skill_enforces_name_rules():
    with pytest.raises(SkillError):
        store.create_skill("Bad Name", "描述", "正文")
    with pytest.raises(SkillError):
        store.create_skill("ok-name", "", "正文")
    created = store.create_skill("ok-name", "一个描述", "正文")
    assert created["name"] == "ok-name"
    assert not created["builtin"]
    assert (user_skill_dir("ok-name") / "SKILL.md").is_file()


def test_import_skill_dir_copies_tree(tmp_path):
    src = tmp_path / "src-skill"
    src.mkdir()
    (src / "SKILL.md").write_text(
        "---\nname: imported\ndescription: 导入进来的技能\n---\n\n正文\n",
        encoding="utf-8")
    (src / "extra.txt").write_text("附件", encoding="utf-8")
    entry = import_skill_dir(str(src))
    assert entry["name"] == "imported"
    names = {f["name"] for f in entry["files"]}
    assert {"SKILL.md", "extra.txt"} <= names


def test_import_skill_dir_rejects_dir_without_skill_md(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(SkillError, match="SKILL.md"):
        import_skill_dir(str(plain))


def test_install_single_md_and_zip():
    md = "---\nname: from-md\ndescription: 单文件技能\n---\n\n正文\n".encode("utf-8")
    [installed] = install_skill_archive(md, "from-md.md")
    assert installed["name"] == "from-md"

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "zipped/SKILL.md",
            "---\nname: zipped\ndescription: 压缩包里的技能\n---\n\n正文\n")
        archive.writestr("zipped/notes.txt", "附件")
    results = install_skill_archive(buffer.getvalue(), "skills.zip")
    assert [r["name"] for r in results] == ["zipped"]


def test_install_zip_without_skill_is_rejected():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("readme.txt", "没有技能")
    with pytest.raises(SkillError, match="SKILL.md"):
        install_skill_archive(buffer.getvalue(), "empty.zip")


def test_install_zip_rejects_path_escape(tmp_path):
    """zip slip：归档里的 ../ 不能把文件写到目标目录之外。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("../escape.md", "越狱")
        archive.writestr("ok/SKILL.md",
                         "---\nname: ok\ndescription: 正常\n---\n\n正文\n")
    with pytest.raises(SkillError, match="非法路径"):
        install_skill_archive(buffer.getvalue(), "evil.zip")


def test_get_skill_returns_full_body():
    _write_skill("detail", "详情用", "## 小节\n\n内容")
    detail = get_skill("detail")
    assert detail["name"] == "detail"
    assert "## 小节" in detail["body"]
    assert detail["path"].endswith("/detail/SKILL.md")


def test_malformed_skill_is_skipped_not_listed(tmp_path):
    """缺 description 的 SKILL.md 不该出现在清单（与加载器同口径）。"""
    d = user_skill_dir("broken")
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text("---\nname: broken\n---\n\n正文\n", encoding="utf-8")
    assert "broken" not in {s["name"] for s in list_skills()}
