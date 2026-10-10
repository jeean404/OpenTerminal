"""SSH config 解析、目标列举、记住的连接（SQLite）与会话工厂。"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import connections_db
from .config import TargetConfig
from .connections_db import RenameConflictError  # noqa: F401 - 供调用方统一 import


def display_name(host: str, user: str | None, port: int | None) -> str:
    """连接的展示名：user@host（非标准端口再附 :port）。"""
    name = f"{user}@{host}" if user else host
    return f"{name}:{port}" if port else name


# 补存/记住失败的可见提示（keyring 不可用等降级场景；文案全链路统一）
PW_STORE_FAIL_HINT = "密码未能写入系统凭据库，下次连接仍需手输"


def cred_alias_eq(a: tuple[str | None, str | None, int | None],
                  b: tuple[str | None, str | None, int | None]) -> bool:
    """凭据三元组按 keyring 键别名语义比较：port None/22 视同相等。

    display_name 只在 port 真值时拼 :port——None 与 22 会落成两个键名，
    但指向同一凭据（ssh 默认端口）。补存去重（_backfill_password）与
    共享凭据防误删（credential_referenced）都按此语义判「同一个凭据」。
    """
    (h1, u1, p1), (h2, u2, p2) = a, b
    return (h1 == h2 and u1 == u2
            and (p1 == p2 or (p1 in (None, 22) and p2 in (None, 22))))


def saved_targets_path() -> Path:
    """记住的连接存储位置（SQLite，用户主目录，不在 git 仓库内）。"""
    return connections_db.db_path()


def load_saved_targets(path: Path | None = None) -> list[TargetConfig]:
    """读取记住的连接；库不存在/为空返回空列表。"""
    conn = connections_db.connect(path)
    try:
        return [TargetConfig(
            name=r["name"], mode="ssh", host=r["host"] or r["name"],
            user=r["user"], port=r["port"],
            commands=(r["commands"] or "").splitlines(),
        ) for r in connections_db.fetch_saved(conn)]
    finally:
        conn.close()


def save_saved_targets(targets: list[TargetConfig],
                       path: Path | None = None) -> None:
    """整表重写记住的连接。"""
    conn = connections_db.connect(path)
    try:
        connections_db.replace_saved(conn, [
            {"name": t.name, "host": t.host or t.name, "port": t.port,
             "user": t.user,
             "commands": "\n".join(t.commands)} for t in targets])
    finally:
        conn.close()


@dataclass
class TargetList:
    local: bool = True
    direct: list[TargetConfig] = field(default_factory=list)


# --- 单条 CRUD（Web 表单：添加 / 编辑 / 删除）---

def find_saved_target(name: str, path: Path | None = None) -> TargetConfig | None:
    for t in load_saved_targets(path):
        if t.name == name:
            return t
    return None


def upsert_saved_target(*, name: str, host: str, port: int | None = None,
                        user: str | None = None,
                        commands: str | None = None,
                        path: Path | None = None) -> None:
    """添加/编辑一条记住的连接（按 name 唯一键 upsert）。

    commands 传 None 不改动既有命令集（旧调用方兼容），空串显式清空。
    """
    conn = connections_db.connect(path)
    try:
        connections_db.upsert_saved(conn, {
            "name": name, "host": host, "port": port, "user": user,
            "commands": commands})
    finally:
        conn.close()


def delete_saved_target(name: str, path: Path | None = None) -> TargetConfig | None:
    """删除一条记住的连接；返回被删条目（供调用方清理凭据），不存在返回 None。"""
    conn = connections_db.connect(path)
    try:
        row = connections_db.delete_saved(conn, name)
    finally:
        conn.close()
    if row is None:
        return None
    return TargetConfig(name=row["name"], mode="ssh", host=row["host"],
                        user=row["user"], port=row["port"])


def rename_saved_target(old: str, *, name: str, host: str,
                        port: int | None = None, user: str | None = None,
                        commands: str | None = None,
                        path: Path | None = None) -> TargetConfig | None:
    """编辑连接（name 可能改）：单事务删旧行、写新行；返回被删的旧行。

    旧条目不存在返回 None（不写入）；新名字撞既有条目抛
    RenameConflictError（库不动，Web 层映射 409 / CLI 层提示）。
    """
    conn = connections_db.connect(path)
    try:
        row = connections_db.rename_saved(conn, old, {
            "name": name, "host": host, "port": port, "user": user,
            "commands": commands})
    finally:
        conn.close()
    if row is None:
        return None
    return TargetConfig(name=row["name"], mode="ssh", host=row["host"],
                        user=row["user"], port=row["port"])


def build_target_list(saved: list[TargetConfig] | None = None) -> TargetList:
    """记住的连接即直连列表（跳板机分组已随跳板机下线移除）。"""
    saved = saved if saved is not None else load_saved_targets()
    return TargetList(direct=list(saved))


@dataclass
class SshTarget:
    name: str
    hostname: str = ""
    user: str | None = None
    port: int | None = None
    identity: str = ""


def parse_ssh_config(path: Path) -> dict[str, SshTarget]:
    """极简 ssh_config 解析器：仅取连接所需字段；首定义优先（与 OpenSSH
    一致——同名 Host 的后续块不覆盖已取到的字段）。"""
    hosts: dict[str, SshTarget] = {}
    current: list[str] = []
    if not path.exists():
        return hosts
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        key = parts[0].lower()
        if key == "host":
            current = parts[1:]
            for name in current:
                hosts.setdefault(name, SshTarget(name=name))
            continue
        if not current:
            continue
        value = " ".join(parts[1:])
        for name in current:
            t = hosts[name]
            if key == "hostname":
                t.hostname = t.hostname or value
            elif key == "user":
                t.user = t.user or value
            elif key == "port" and value.isdigit() and t.port is None:
                t.port = int(value)
            elif key == "identityfile":
                t.identity = t.identity or value
    return hosts


def list_ssh_hosts(path: Path | None = None) -> list[str]:
    path = path or (Path.home() / ".ssh" / "config")
    return [n for n in parse_ssh_config(path) if "*" not in n and "?" not in n]


def parse_user_at_host(text: str) -> tuple[str, str | None, int | None]:
    user, port = None, None
    host = text
    if "@" in text:
        user, host = text.split("@", 1)
    if ":" in host:
        host, p = host.rsplit(":", 1)
        port = int(p) if p.isdigit() else None
    return host, user, port


def _backfill_password(target: TargetConfig, session) -> bool:
    """连接已记住但凭据缺失时，把本次实际使用的密码补进系统凭据库。

    记住的连接（connections.db）意味着用户已同意「记住该连接含密码」；
    缺失来自上次存库失败或凭据库当时不可用。CLI / Web / Picker 全路径
    都经 open_session，补存放这里一处生效。未记住的连接不动——那由
    _maybe_remember 的 y/n 询问把关。

    已有凭据按端口别名去重（None/22 视同同一键，见
    secrets_store.load_password_alias）：档案流按 port=22 存
    ``user@host:22``、本次连接解析出 port=None 时，单键直查看不到别名
    键会再存一个 ``user@host``——同一密码两个键、读取侧永远错位。saved
    匹配同样按别名语义（cred_alias_eq）：port None/22 视同一条连接。

    返回 True = 本该补存但写库失败（调用方给出可见提示，不再静默——
    「以为记住了其实没记住」是每次重讨密码的隐形根因）；补存成功或
    无需补存均返回 False。
    """
    if target.mode != "ssh" or not target.host:
        return False
    from .secrets_store import load_password_alias, store_password

    used = getattr(session, "last_password", None)
    if used is None:
        return False  # 本次没用密码（密钥认证）或未记录
    if load_password_alias(target.host, target.user, target.port) is not None:
        return False  # 已有凭据（含 None/22 别名键；旧 CLI 的失效写回路径已随换心退场）
    if not any(cred_alias_eq((t.host, t.user, t.port),
                             (target.host, target.user, target.port))
               for t in load_saved_targets()):
        return False  # 连接未记住：不替用户做主存密码
    return not store_password(target.host, target.user, target.port, used)


async def open_session(target: TargetConfig, password: str | None = None,
                       *, notify=None, **kwargs_session):
    """按 TargetConfig 创建会话。password 为记住的密码（可为 None）；
    kwargs_session 透传给会话构造器（超时/截断）。

    notify：降级提示的可见化通道（同步回调，收一句文案），如 core 的
    _emit_nowait(status)。补存失败经它转发 PW_STORE_FAIL_HINT——不设
    则维持旧的静默降级（headless 等无 UI 通道的调用方）。
    """
    # 认证回调只属于 SSH 会话；本地 PTY 构造器不接受，需先剥离再路由
    prompt_kwargs = {k: kwargs_session.pop(k)
                     for k in ("password_prompt", "host_key_prompt")
                     if k in kwargs_session}
    if target.mode == "local":
        if sys.platform == "win32":
            # Windows：ConPTY 会话（pywinpty 仅 win32 安装）
            from .local_win import WinPtySession

            s = WinPtySession(**kwargs_session)
        else:
            # 延迟导入：local_pty 依赖 POSIX 专属模块（fcntl/termios），
            # Windows 上只要不进本地模式就不应触发导入
            from .local_pty import LocalPtySession

            s = LocalPtySession(**kwargs_session)
    else:
        from .ssh_pty import SshPtySession

        host = target.host or target.name
        s = SshPtySession(
            host,
            username=target.user,
            port=target.port,
            password=password,
            **prompt_kwargs,
            **kwargs_session,
        )
    await s.start()
    if _backfill_password(target, s) and notify is not None:
        # 补存失败不再静默：凭据库不可用时「以为记住了其实没记住」，
        # 用户只能以为密码丢了反复手输（任务书 §2-5）
        notify(PW_STORE_FAIL_HINT)
    return s
