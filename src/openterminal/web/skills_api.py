"""设置页的技能/工具 REST 面（`/api/skills*`、`/api/mcp-servers*`）。

照 model_profiles 的口径：每个 handler 先 `_check_token`，业务错映射成
400（校验）/404（不存在）/409（撞名），成功回资源本身或 `{"ok": True}`。
401 专留给访问令牌，业务错绝不用它（files_api 的注释里钉过这条）。

磁盘扫描与 SQLite 都是同步阻塞，一律丢进 `asyncio.to_thread`，别把事件
循环卡在 scp 大目录或慢盘上。
"""

from __future__ import annotations

import asyncio
import base64

from fastapi import APIRouter, HTTPException, Request

from ..skills import store as skills_store


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, skills_store.SkillNotFound):
        return HTTPException(404, str(exc))
    if isinstance(exc, skills_store.SkillError):
        return HTTPException(400, str(exc))
    return HTTPException(500, f"技能操作失败：{exc}")


async def _io(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except (skills_store.SkillError, skills_store.SkillNotFound) as exc:
        raise _http(exc) from exc
    except OSError as exc:
        raise HTTPException(500, f"磁盘操作失败：{exc}") from exc


def make_skills_router(check_token) -> APIRouter:
    router = APIRouter(prefix="/api/skills")

    @router.get("")
    async def list_skills(request: Request):
        check_token(request.headers)
        skills = await _io(skills_store.list_skills)
        return {"skills": skills, "user_dir": str(skills_store.user_skills_dir())}

    @router.get("/{name}")
    async def get_skill(request: Request, name: str):
        check_token(request.headers)
        return await _io(skills_store.get_skill, name)

    @router.post("")
    async def create_skill(request: Request, payload: dict):
        check_token(request.headers)
        return await _io(
            skills_store.create_skill,
            str(payload.get("name") or ""),
            str(payload.get("description") or ""),
            str(payload.get("body") or ""),
        )

    @router.post("/import")
    async def import_skill(request: Request, payload: dict):
        """从本机目录导入（该目录内须有 SKILL.md）。"""
        check_token(request.headers)
        path = str(payload.get("path") or "").strip()
        if not path:
            raise HTTPException(400, "请填写 skill 目录路径")
        return await _io(skills_store.import_skill_dir, path)

    @router.post("/upload")
    async def upload_skill(request: Request, payload: dict):
        """上传 .md 或 .zip（base64）。与文件面板同用 JSON+base64，避免 multipart。"""
        check_token(request.headers)
        try:
            data = base64.b64decode(str(payload.get("data") or ""), validate=True)
        except Exception as exc:
            raise HTTPException(400, "上传内容不是合法的 base64") from exc
        filename = str(payload.get("filename") or "")
        installed = await _io(skills_store.install_skill_archive, data, filename)
        return {"installed": installed}

    @router.post("/{name}/enabled")
    async def set_enabled(request: Request, name: str, payload: dict):
        check_token(request.headers)
        if "enabled" not in payload:
            raise HTTPException(400, "缺少 enabled 字段")
        enabled = bool(payload.get("enabled"))
        # 开关是写状态，不校验 skill 是否在册：删掉的用户 skill 留个开关
        # 无害，而「先停用再删」是正常操作顺序
        await _io(skills_store.set_enabled, name, enabled)
        return {"ok": True, "name": name, "enabled": enabled}

    @router.delete("/{name}")
    async def delete_skill(request: Request, name: str):
        check_token(request.headers)
        return await _io(skills_store.delete_skill, name)

    return router
