"""技能管理面：清单、详情、启停，以及用户 skill 的新增/导入/删除。

技能本体仍是磁盘目录（挂载约定见 skills/__init__.py），本模块只做管理面，
不碰 agent 装配。三件事：

- **清单**：扫描内置与用户两层，解析 SKILL.md frontmatter，合并出模型
  视角的最终生效结果（同名用户版覆盖内置版，与 SkillsMiddleware 一致）。
- **写入**：用户 skill 落 `user_skills_dir()/<name>/SKILL.md`，写入端强制
  `name == 目录名`（deepagents 校验规则），否则模型侧加载会静默跳过。
- **启停**：落 SQLite 的 `skill_state` 表，由 GatedSkillsMiddleware 在每次
  组装提示词时读取——所以关掉后**下一轮模型调用即不再看到**，无需重建
  agent（重建会新建 MemorySaver，代价是清空该 tab 的对话检查点）。

内置 skill 只读（wheel 里可能是 site-packages），只能停用不能删除；删除
用户 skill 若该名仍有内置版，是「回退到内置版」而不是消失，UI 必须说清。
"""

from __future__ import annotations

import re
import shutil
import zipfile
from contextlib import contextmanager
from pathlib import Path

import yaml

from . import BUILTIN_DIR, BUILTIN_PREFIX, USER_PREFIX, user_skills_dir

# 与 deepagents 校验同口径：1-64 字符的小写字母数字与连字符
_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_SKILL_FILE = "SKILL.md"
_MAX_UPLOAD_BYTES = 8 * 1024 * 1024

# 启停集合的进程内缓存：_format_skills_list 每轮模型调用都会问一次，
# 而 connect() 带迁移脚本不宜高频跑；写路径负责失效。
_disabled_cache: frozenset[str] | None = None


class SkillError(ValueError):
    """业务校验失败（HTTP 400），文案可直接给用户看。"""


class SkillNotFound(LookupError):
    """skill 不存在（HTTP 404）。"""


# --------------------------------------------------------------------------
# 启停开关
# --------------------------------------------------------------------------

def _connection():
    from ..connections.db import connect

    conn = connect()
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS skill_state("
        "  name TEXT PRIMARY KEY,"
        "  enabled INTEGER NOT NULL"
        ");"
    )
    return conn


def _invalidate() -> None:
    global _disabled_cache
    _disabled_cache = None


def disabled_names() -> frozenset[str]:
    """当前被停用的 skill 名。无行 = 启用（缺省即启用，少一份状态要迁移）。"""
    global _disabled_cache
    if _disabled_cache is None:
        conn = _connection()
        try:
            rows = conn.execute(
                "SELECT name FROM skill_state WHERE enabled=0"
            ).fetchall()
            _disabled_cache = frozenset(row["name"] for row in rows)
        finally:
            conn.close()
    return _disabled_cache


def set_enabled(name: str, enabled: bool) -> None:
    conn = _connection()
    try:
        if enabled:
            conn.execute("DELETE FROM skill_state WHERE name=?", (name,))
        else:
            conn.execute(
                "INSERT INTO skill_state(name, enabled) VALUES(?, 0) "
                "ON CONFLICT(name) DO UPDATE SET enabled=0",
                (name,),
            )
        conn.commit()
    finally:
        conn.close()
    _invalidate()


# --------------------------------------------------------------------------
# 扫描与清单
# --------------------------------------------------------------------------

def _split_frontmatter(text: str) -> tuple[dict, str]:
    """取 SKILL.md 的 YAML 头与正文。缺头或 YAML 坏 → ({}, 全文)，由调用方跳过。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    raw = text[3:end]
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        return {}, text
    if not isinstance(data, dict):
        return {}, text
    body = text[end + 4:]
    if body.startswith("\n"):
        body = body[1:]
    return data, body


def _read_skill(root: Path, name: str, *, builtin: bool) -> dict | None:
    """读单个 skill 目录。缺 name/description 的按 deepagents 规则跳过。"""
    skill_dir = root / name
    md = skill_dir / _SKILL_FILE
    if not md.is_file():
        return None
    try:
        text = md.read_text(encoding="utf-8")
    except OSError:
        return None
    meta, body = _split_frontmatter(text)
    skill_name = str(meta.get("name") or "").strip()
    description = str(meta.get("description") or "").strip()
    if not skill_name or not description:
        return None
    files = []
    total = 0
    for path in sorted(skill_dir.rglob("*")):
        if not path.is_file():
            continue
        size = path.stat().st_size
        total += size
        files.append({
            "name": path.relative_to(skill_dir).as_posix(),
            "size": size,
        })
    prefix = BUILTIN_PREFIX if builtin else USER_PREFIX
    return {
        "name": skill_name,
        "description": description,
        "builtin": builtin,
        "path": f"{prefix}{name}/{_SKILL_FILE}",
        "dir": str(skill_dir),
        "files": files,
        "size": total,
        "_body": body,
        "_text": text,
    }


def _scan(root: Path | None, *, builtin: bool) -> dict[str, dict]:
    found: dict[str, dict] = {}
    if root is None or not root.is_dir():
        return found
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        entry = _read_skill(root, child.name, builtin=builtin)
        if entry:
            found[child.name] = entry
    return found


def _merged() -> dict[str, dict]:
    """内置 → 用户，后源覆盖先源（与 SkillsMiddleware 的 last-one-wins 同）。"""
    merged = _scan(BUILTIN_DIR, builtin=True)
    for name, entry in _scan(user_skills_dir(), builtin=False).items():
        previous = merged.get(name)
        if previous:
            entry["overridden"] = True
        merged[name] = entry
    for entry in merged.values():
        entry.setdefault("overridden", False)
    return merged


def list_skills() -> list[dict]:
    """技能卡片页的数据：生效清单 + 启停态 + 可删除性。"""
    disabled = disabled_names()
    items = []
    for entry in _merged().values():
        items.append({
            "name": entry["name"],
            "description": entry["description"],
            # builtin=True 表示「当前生效的是内置版」→ 不可删除，只可停用
            "builtin": entry["builtin"],
            "overridden": entry["overridden"],
            "enabled": entry["name"] not in disabled,
            "path": entry["path"],
            "size": entry["size"],
            "file_count": len(entry["files"]),
        })
    items.sort(key=lambda s: (s["builtin"], s["name"]))
    return items


def get_skill(name: str) -> dict:
    entry = _merged().get(name)
    if entry is None:
        raise SkillNotFound(f"skill「{name}」不存在")
    return {
        "name": entry["name"],
        "description": entry["description"],
        "builtin": entry["builtin"],
        "overridden": entry["overridden"],
        "enabled": entry["name"] not in disabled_names(),
        "path": entry["path"],
        "dir": entry["dir"],
        "files": entry["files"],
        "size": entry["size"],
        "body": entry["_text"],
    }


def user_skill_dir(name: str) -> Path:
    return user_skills_dir() / name


def has_user_skill(name: str) -> bool:
    return (user_skill_dir(name) / _SKILL_FILE).is_file()


# --------------------------------------------------------------------------
# 写入（用户 skill）
# --------------------------------------------------------------------------

def _check_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise SkillError(
            "skill 名称需为 1-64 位小写字母、数字或连字符，且不能以连字符开头或结尾")
    return name


def _write_user_skill(name: str, description: str, body: str) -> Path:
    name = _check_name(name)
    description = (description or "").strip()
    if not description:
        raise SkillError("描述不能为空——模型靠它判断何时使用该 skill")
    if len(description) > 1024:
        raise SkillError("描述不能超过 1024 个字符")
    target = user_skill_dir(name)
    target.mkdir(parents=True, exist_ok=True)
    text = (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        "---\n\n"
        f"{body.lstrip()}\n"
    )
    (target / _SKILL_FILE).write_text(text, encoding="utf-8")
    return target


def create_skill(name: str, description: str, body: str) -> dict:
    name = _check_name(name)
    if name in _merged() and not has_user_skill(name):
        raise SkillError(f"内置 skill「{name}」不可新建同名覆盖，换个名字吧")
    _write_user_skill(name, description, body)
    return get_skill(name)


def import_skill_dir(src: str) -> dict:
    """从本机已有目录导入（目录内须有 SKILL.md），整体拷进用户 skill 目录。"""
    source = Path(str(src or "")).expanduser()
    if not source.is_dir():
        raise SkillError(f"目录不存在：{source}")
    md = source / _SKILL_FILE
    if not md.is_file():
        raise SkillError(f"{source} 下没有 {_SKILL_FILE}，不是可导入的 skill 目录")
    meta, _ = _split_frontmatter(md.read_text(encoding="utf-8"))
    name = str(meta.get("name") or "").strip() or source.name
    name = _check_name(name)
    description = str(meta.get("description") or "").strip()
    if not description:
        raise SkillError(f"{_SKILL_FILE} 缺少 description 字段，模型无法判断何时使用")
    target = user_skill_dir(name)
    if target.exists():
        shutil.rmtree(target)
    try:
        shutil.copytree(source, target)
    except OSError as exc:
        raise SkillError(f"导入失败：{exc}") from exc
    return get_skill(name)


def install_skill_archive(data: bytes, filename: str = "") -> list[dict]:
    """上传 .md 或 .zip 装成用户 skill。zip 里可以有多个 skill 目录。"""
    if not data:
        raise SkillError("上传内容为空")
    if len(data) > _MAX_UPLOAD_BYTES:
        raise SkillError(f"上传文件不能超过 {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    lower = (filename or "").lower()
    if lower.endswith(".zip") or data[:2] == b"PK":
        return _install_zip(data)
    return [_install_single_md(data, filename)]


def _install_single_md(data: bytes, filename: str) -> dict:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SkillError("SKILL.md 必须是 UTF-8 文本") from exc
    meta, body = _split_frontmatter(text)
    name = str(meta.get("name") or "").strip()
    if not name:
        stem = Path(filename or "").stem or ""
        name = _check_name(stem) if stem else ""
        if not name:
            raise SkillError("SKILL.md 缺少 frontmatter 的 name 字段")
    description = str(meta.get("description") or "").strip()
    if not description:
        raise SkillError("SKILL.md 缺少 description 字段，模型无法判断何时使用")
    _write_user_skill(name, description, body)
    return get_skill(name)


def _install_zip(data: bytes) -> list[dict]:
    import io
    import tempfile

    installed: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="ot-skill-") as tmp:
        tmp_path = Path(tmp)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for info in archive.infolist():
                    # zip slip：绝不允许归档把文件写到目标目录之外
                    dest = (tmp_path / info.filename).resolve()
                    if not str(dest).startswith(str(tmp_path.resolve())):
                        raise SkillError(f"压缩包内含非法路径：{info.filename}")
                archive.extractall(tmp_path)
        except zipfile.BadZipFile as exc:
            raise SkillError("压缩包无法解析，请确认是有效的 .zip 文件") from exc

        bundles = _locate_skill_dirs(tmp_path)
        if not bundles:
            raise SkillError(f"压缩包里没找到带 {_SKILL_FILE} 的 skill")
        for source in bundles:
            installed.append(import_skill_dir(str(source)))
    return installed


def _locate_skill_dirs(root: Path) -> list[Path]:
    """找所有含 SKILL.md 的目录（支持单个 skill 平铺或一包多个 skill）。"""
    found = []
    for md in sorted(root.rglob(_SKILL_FILE)):
        if md.is_file():
            found.append(md.parent)
    return found


def delete_skill(name: str) -> dict:
    """删用户版。若同名仍有内置版，删完是「回退到内置版」而非消失。"""
    if not has_user_skill(name):
        if name in _merged():
            raise SkillError(f"「{name}」是内置 skill，不能删除，只能停用")
        raise SkillNotFound(f"skill「{name}」不存在")
    shutil.rmtree(user_skill_dir(name), ignore_errors=True)
    set_enabled(name, True)  # 清掉停用标记，别让回退出来的内置版一上来就是关的
    remaining = _merged().get(name)
    return {
        "deleted": True,
        "name": name,
        "reverted_to_builtin": remaining is not None,
    }
