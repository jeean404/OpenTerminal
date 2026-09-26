"""SSH config 解析、目标列举、记住的连接（SQLite）与会话工厂。"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import connections_db
from .config import TargetConfig


def display_name(host: str, user: str | None, port: int | None) -> str:
    """连接的展示名：user@host（非标准端口再附 :port）。"""
    name = f"{user}@{host}" if user else host
    return f"{name}:{port}" if port else name


def saved_targets_path() -> Path:
    """记住的连接存储位置（SQLite，用户主目录，不在 git 仓库内）。"""
    return connections_db.db_path()


def load_saved_targets(path: Path | None = None) -> list[TargetConfig]:
    """读取记住的连接；库不存在/为空返回空列表。"""
    conn = connections_db.connect(path)
    try:
        return [TargetConfig(
            name=r["name"], mode="ssh", host=r["host"] or r["name"],
            user=r["user"], port=r["port"], jump=r["jump"],
            commands=(r["commands"] or "").splitlines(),
        ) for r in connections_db.fetch_saved(conn)]
    finally:
        conn.close()


def save_saved_targets(targets: list[TargetConfig],
                       path: Path | None = None) -> None:
    """整表重写记住的连接（跳板机表不受影响）。"""
    conn = connections_db.connect(path)
    try:
        connections_db.replace_saved(conn, [
            {"name": t.name, "host": t.host or t.name, "port": t.port,
             "user": t.user, "jump": t.jump,
             "commands": "\n".join(t.commands)} for t in targets])
    finally:
        conn.close()


@dataclass
class JumpHost:
    name: str
    host: str
    user: str | None = None
    port: int | None = None


@dataclass
class JumpGroup:
    jump: JumpHost
    targets: list[TargetConfig]


@dataclass
class TargetList:
    local: bool = True
    direct: list[TargetConfig] = field(default_factory=list)
    jumps: list[JumpGroup] = field(default_factory=list)


def load_jump_hosts(path: Path | None = None) -> list[JumpHost]:
    conn = connections_db.connect(path)
    try:
        return [JumpHost(name=r["name"], host=r["host"] or r["name"],
                         user=r["user"], port=r["port"])
                for r in connections_db.fetch_jumps(conn)]
    finally:
        conn.close()


def save_jump_hosts(jumps: list[JumpHost], path: Path | None = None) -> None:
    """整表重写跳板机（记住的连接表不受影响）。"""
    conn = connections_db.connect(path)
    try:
        connections_db.replace_jumps(conn, [
            {"name": j.name, "host": j.host, "port": j.port, "user": j.user}
            for j in jumps])
    finally:
        conn.close()


# --- 单条 CRUD（Web 表单：添加 / 编辑 / 删除）---

def find_saved_target(name: str, path: Path | None = None) -> TargetConfig | None:
    for t in load_saved_targets(path):
        if t.name == name:
            return t
    return None


def find_jump_host(name: str, path: Path | None = None) -> JumpHost | None:
    for j in load_jump_hosts(path):
        if j.name == name:
            return j
    return None


def upsert_saved_target(*, name: str, host: str, port: int | None = None,
                        user: str | None = None, jump: str | None = None,
                        commands: str | None = None,
                        path: Path | None = None) -> None:
    """添加/编辑一条记住的连接（按 name 唯一键 upsert）。

    commands 传 None 不改动既有命令集（旧调用方兼容），空串显式清空。
    """
    conn = connections_db.connect(path)
    try:
        connections_db.upsert_saved(conn, {
            "name": name, "host": host, "port": port, "user": user,
            "jump": jump or None, "commands": commands})
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
                        user=row["user"], port=row["port"], jump=row["jump"])


def rename_saved_target(old: str, *, name: str, host: str,
                        port: int | None = None, user: str | None = None,
                        jump: str | None = None,
                        commands: str | None = None,
                        path: Path | None = None) -> TargetConfig | None:
    """编辑连接（name 可能改）：删旧行、写新行；返回被删的旧行。"""
    conn = connections_db.connect(path)
    try:
        row = connections_db.rename_saved(conn, old, {
            "name": name, "host": host, "port": port, "user": user,
            "jump": jump or None, "commands": commands})
    finally:
        conn.close()
    if row is None:
        return None
    return TargetConfig(name=row["name"], mode="ssh", host=row["host"],
                        user=row["user"], port=row["port"], jump=row["jump"])


def upsert_jump_host(*, name: str, host: str, port: int | None = None,
                     user: str | None = None,
                     path: Path | None = None) -> None:
    conn = connections_db.connect(path)
    try:
        connections_db.upsert_jump(conn, {
            "name": name, "host": host, "port": port, "user": user})
    finally:
        conn.close()


def delete_jump_host(name: str, path: Path | None = None) -> JumpHost | None:
    """删除跳板机；其下主机的 jump 引用置空（回落为直连）。"""
    conn = connections_db.connect(path)
    try:
        row = connections_db.delete_jump(conn, name)
    finally:
        conn.close()
    if row is None:
        return None
    return JumpHost(name=row["name"], host=row["host"], user=row["user"],
                    port=row["port"])


def jump_for(target: TargetConfig) -> JumpHost | None:
    if not target.jump:
        return None
    for j in load_jump_hosts():
        if j.name == target.jump:
            return j
    return None


def build_target_list(saved: list[TargetConfig] | None = None,
                      jumps: list[JumpHost] | None = None) -> TargetList:
    saved = saved if saved is not None else load_saved_targets()
    jumps = jumps if jumps is not None else load_jump_hosts()
    jump_names = {j.name for j in jumps}
    direct: list[TargetConfig] = []
    by_jump: dict[str, list[TargetConfig]] = {}
    for t in saved:
        if t.jump and t.jump in jump_names:
            by_jump.setdefault(t.jump, []).append(t)
        else:
            direct.append(t)
    return TargetList(
        direct=direct,
        jumps=[JumpGroup(jump=j, targets=by_jump.get(j.name, [])) for j in jumps],
    )


@dataclass
class SshTarget:
    name: str
    hostname: str = ""
    user: str | None = None
    port: int | None = None
    identity: str = ""
    jump: str | None = None


def parse_ssh_config(path: Path) -> dict[str, SshTarget]:
    """极简 ssh_config 解析器：仅取连接所需字段，Host 块后定义优先。"""
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
                t.hostname = value
            elif key == "user":
                t.user = value
            elif key == "port" and value.isdigit():
                t.port = int(value)
            elif key == "identityfile":
                t.identity = value
            elif key == "proxyjump":
                t.jump = value
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


def _backfill_password(target: TargetConfig, session) -> None:
    """连接已记住但凭据缺失时，把本次实际使用的密码补进系统凭据库。

    记住的连接（connections.db）意味着用户已同意「记住该连接含密码」；
    缺失来自上次存库失败或凭据库当时不可用。CLI / Web / Picker 全路径
    都经 open_session，补存放这里一处生效。未记住的连接不动——那由
    _maybe_remember 的 y/n 询问把关。
    """
    if target.mode != "ssh" or not target.host:
        return
    from .secrets_store import load_password, store_password

    used = getattr(session, "last_password", None)
    if used is None:
        return  # 本次没用密码（密钥认证）或未记录
    if load_password(target.host, target.user, target.port) is not None:
        return  # 已有凭据；失效由 switch_target 写回刷新
    if not any(t.host == target.host and t.user == target.user
               and t.port == target.port for t in load_saved_targets()):
        return  # 连接未记住：不替用户做主存密码
    store_password(target.host, target.user, target.port, used)


async def open_session(target: TargetConfig, password: str | None = None,
                       **kwargs_session):
    """按 TargetConfig 创建会话。password 为记住的密码（可为 None）；
    kwargs_session 透传给会话构造器（超时/截断）。"""
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
        jump = jump_for(target)
        jump_pw = None
        if jump is not None:
            from .secrets_store import load_password

            jump_pw = load_password(jump.host, jump.user, jump.port)
        s = SshPtySession(
            host,
            username=target.user,
            port=target.port,
            password=password,
            jump=jump,
            jump_password=jump_pw,
            **prompt_kwargs,
            **kwargs_session,
        )
    await s.start()
    _backfill_password(target, s)
    return s
