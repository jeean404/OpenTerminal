"""审批交互的纯决策部分；TUI 提示在 cli.py。"""

from __future__ import annotations

from typing import Literal

from .policy import Decision, Policy

Choice = Literal["y", "e", "n", "a"]


def reclassify_edited(new_command: str, policy: Policy) -> Decision:
    """编辑后的命令必须重新过一遍策略。"""
    return policy.classify(new_command)


def decision_for_choice(
    choice: str,
    command: str,
    policy: Policy,
    allowed: set[str],
) -> dict | None:
    if choice == "y":
        return {"type": "approve"}
    if choice == "a":
        allowed.add(command)
        return {"type": "approve"}
    if choice == "n":
        return {"type": "reject", "message": "用户拒绝了该命令"}
    return None  # e：由 CLI 收集编辑后的命令


def edit_decision(new_command: str) -> dict:
    return {
        "type": "edit",
        "edited_action": {
            "name": "execute",
            "args": {"command": new_command},
        },
    }
