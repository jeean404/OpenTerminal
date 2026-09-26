"""无头执行面：ot exec / ot list——供外部 AI 编程工具（Claude Code、opencode
等）以子进程方式调用，无需进入 REPL。

设计对齐"Agent 优先"原则：
- --output json 输出结构化结果，退出码分层：远程命令退出码原样透传（< 64），
  工具自身错误使用 ≥ 64 的保留码，Agent 可据此区分"远程成败"与"调用问题"。
- 审批不走交互：Policy 分级映射为协议行为——auto 执行、deny/APPROVAL
  结构化拒绝，出路只有"人的动作"（交互界面记住允许 / 编辑 config）。
- 主机指纹沿用 TOFU，但无头下不询问：known_hosts 未收录即结构化报错，
  请用户先在交互界面连接一次。

退出码表：
  0/1~63  远程命令退出码透传（与 SSH 行为一致）
  64      用法错误
  65      目标不存在
  66      策略拒绝（deny）
  67      需要用户审批（approve）
  68      连接/认证失败
  69      主机指纹未收录（TOFU）
  124     超时（由会话层哨兵超时返回，经透传路径自然到达）
"""

from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import sys

from .config import Config, TargetConfig

EXIT_USAGE = 64
EXIT_TARGET_NOT_FOUND = 65
EXIT_DENIED = 66
EXIT_APPROVAL_REQUIRED = 67
EXIT_CONNECT_FAILED = 68
EXIT_HOST_KEY = 69

DEFAULT_EXEC_TIMEOUT = 30


# ---------------------------------------------------------------------------
# 目标解析
# ---------------------------------------------------------------------------

def all_targets(cfg: Config) -> list[TargetConfig]:
    """配置文件目标 + 记住的连接（后者按 host 去重靠前）。"""
    saved = []
    try:
        from .connections import load_saved_targets

        saved = load_saved_targets()
    except Exception:
        pass  # 凭据库不可用时仍可使用 config.toml 里的目标
    seen: set[tuple] = set()
    merged: list[TargetConfig] = []
    for t in saved + list(cfg.targets.values()):
        key = (t.mode, t.host or t.name, t.user, t.port)
        if key not in seen:
            seen.add(key)
            merged.append(t)
    return merged


def resolve_target(name: str, cfg: Config) -> tuple[TargetConfig | None, list[str]]:
    """按名字解析目标：精确 → 模糊。返回 (目标 | None, 候选名列表)。"""
    targets = all_targets(cfg)
    names = [t.name for t in targets]
    for t in targets:
        if t.name == name:
            return t, names
    return None, difflib.get_close_matches(name, names, n=5, cutoff=0.6)


# ---------------------------------------------------------------------------
# JSON 输出
# ---------------------------------------------------------------------------

def _emit(payload: dict, *, as_json: bool, file) -> None:
    if as_json:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")
    else:
        file.write(payload.get("message") or payload.get("output") or "")


# ---------------------------------------------------------------------------
# ot exec
# ---------------------------------------------------------------------------

def _gate(command: str, cfg: Config) -> tuple[int, dict] | None:
    """Policy 分级 → 无头协议行为。返回 (退出码, 错误 payload) 或 None（放行）。"""
    from .policy import Policy

    p = cfg.policy
    decision = Policy(
        mode=p.mode,
        auto_extra=p.auto_extra,
        approve_extra=p.approve_extra,
        deny_extra=p.deny_extra,
    ).classify(command)
    if decision.level == "auto":
        return None
    if decision.level == "deny":
        return EXIT_DENIED, {
            "code": "DENIED",
            "command": command,
            "reasons": decision.reasons,
            "message": f"策略拒绝执行该命令：{'；'.join(decision.reasons)}",
        }
    return EXIT_APPROVAL_REQUIRED, {
        "code": "APPROVAL_REQUIRED",
        "command": command,
        "reasons": decision.reasons,
        "hint": "无头模式不执行需人工审批的命令。请让用户在 ot 交互界面执行一次"
                "并选择『记住允许』，或将其加入 config.toml 的 policy.auto_extra。",
        "message": f"该命令需要用户审批：{'；'.join(decision.reasons)}",
    }


async def _exec_async(target: TargetConfig, command: str, *, timeout: int) -> int:
    from .connections import open_session
    from .secrets_store import load_password

    password = load_password(target.host, target.user, target.port)
    session = await open_session(
        target,
        password=password,
        # 无头模式不交互：密码提示直接失败，主机指纹预先检查
        password_prompt=lambda label: None,
        host_key_prompt=lambda message: False,
    )
    try:
        result = await session.run(command, timeout=timeout)
        return result
    finally:
        await session.close()


def cmd_exec(args: argparse.Namespace, cfg: Config, out, err) -> int:
    command = args.command
    if not command:
        _emit({"code": "USAGE", "message": "缺少 -c/--command"}, as_json=args.json, file=err)
        return EXIT_USAGE

    target, candidates = resolve_target(args.target, cfg)
    if target is None:
        payload = {"code": "TARGET_NOT_FOUND",
                   "message": f"目标 '{args.target}' 不存在。"}
        if candidates:
            payload["candidates"] = candidates
            payload["message"] += f" 相近的可用目标: {', '.join(candidates)}"
        _emit(payload, as_json=args.json, file=err)
        return EXIT_TARGET_NOT_FOUND

    verdict = _gate(command, cfg)
    if verdict is not None:
        exit_code, payload = verdict
        _emit(payload, as_json=args.json, file=err)
        return exit_code

    # 主机指纹 TOFU 预检：无头模式不询问，未收录直接报错
    if target.mode == "ssh":
        from .ssh_pty import known_hosts_has_entry, known_hosts_path

        host = target.host or target.name
        if not known_hosts_has_entry(known_hosts_path(), host, target.port):
            _emit({"code": "HOST_KEY_UNKNOWN", "host": host,
                   "hint": "首次连接请先在 ot 交互界面完成指纹确认（TOFU）。",
                   "message": f"known_hosts 中没有主机 {host} 的指纹记录。"},
                  as_json=args.json, file=err)
            return EXIT_HOST_KEY

    try:
        result = asyncio.run(_exec_async(target, command, timeout=args.timeout))
    except Exception as e:
        _emit({"code": "CONNECT_FAILED", "target": target.name,
               "message": f"连接或执行失败：{type(e).__name__}: {e}"},
              as_json=args.json, file=err)
        return EXIT_CONNECT_FAILED

    payload = {"output": result.output,
               "exit_code": result.exit_code,
               "truncated": result.truncated,
               "cwd": result.cwd,
               "target": target.name}
    _emit(payload, as_json=args.json, file=out)
    return result.exit_code & 0xFF  # 与 shell 退出码语义一致（0~255）


# ---------------------------------------------------------------------------
# ot list targets
# ---------------------------------------------------------------------------

def cmd_list(args: argparse.Namespace, cfg: Config, out, err) -> int:
    if args.what != "targets":
        _emit({"code": "USAGE", "message": f"未知子项 '{args.what}'，可用: targets"},
              as_json=args.json, file=err)
        return EXIT_USAGE
    targets = [{"name": t.name, "mode": t.mode, "host": t.host or t.name,
                "user": t.user, "port": t.port, "jump": t.jump}
               for t in all_targets(cfg)]
    if args.json:
        json.dump({"targets": targets}, out, ensure_ascii=False, indent=2)
        out.write("\n")
    else:
        for t in targets:
            where = t["user"] + "@" if t["user"] else ""
            where += t["host"]
            if t["port"]:
                where += f":{t['port']}"
            suffix = f" (经跳板机 {t['jump']})" if t["jump"] else ""
            out.write(f"{t['name']}\t{where}{suffix}\n")
    return 0


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ot",
        description="无头执行面：供脚本与 AI 编程工具调用。无参数时进入交互 REPL。",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p_exec = sub.add_parser(
        "exec", help="在目标上执行一条命令并返回结果",
        epilog="退出码：<64 为远程命令退出码透传；64 用法 65 目标不存在 "
               "66 策略拒绝 67 需审批 68 连接失败 69 指纹未收录 124 超时。"
               "失败详情看 --output json 的 code/message 字段。",
    )
    p_exec.add_argument("-t", "--target", required=True, help="目标名（ot list targets 可查）")
    p_exec.add_argument("-c", "--command", required=True, help="要执行的命令")
    p_exec.add_argument("--timeout", type=int, default=DEFAULT_EXEC_TIMEOUT,
                        help=f"超时秒数（默认 {DEFAULT_EXEC_TIMEOUT}）")
    p_exec.add_argument("--output", "-o", choices=["text", "json"], default="text",
                        help="输出格式，Agent 建议用 json")

    p_list = sub.add_parser("list", help="列举资源")
    # 不用 argparse choices：未知子项要走结构化 USAGE 错误（cmd_list 校验），
    # 否则 argparse 直接 SystemExit(2)，Agent 拿不到 JSON
    p_list.add_argument("what", nargs="?", default="targets",
                        help="targets：可用目标列表")
    p_list.add_argument("--output", "-o", choices=["text", "json"], default="text",
                        help="输出格式")
    for p in (p_exec, p_list):
        p.set_defaults(json=False)
        # argparse 处理 -o json 与 --output 同义；json 布尔由 output 推导
    return parser


def run_headless(argv: list[str], cfg: Config | None = None,
                 out=None, err=None) -> int:
    """无头入口。cfg/out/err 可注入（测试用）。返回进程退出码。"""
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    cfg = cfg if cfg is not None else Config.load()
    parser = build_parser()
    args = parser.parse_args(argv)
    # --output json → args.json
    args.json = getattr(args, "output", "text") == "json"
    if args.subcommand == "exec":
        return cmd_exec(args, cfg, out, err)
    return cmd_list(args, cfg, out, err)
