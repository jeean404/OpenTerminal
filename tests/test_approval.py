import pytest

from openterminal.approval import (
    decision_for_choice, edit_decision, reclassify_edited,
)
from openterminal.policy import Policy


def test_approve_and_session_allow():
    allowed: set[str] = set()
    d = decision_for_choice("y", "touch f", Policy(), allowed)
    assert d == {"type": "approve"}
    d = decision_for_choice("a", "touch f", Policy(), allowed)
    assert d == {"type": "approve"}
    assert "touch f" in allowed


def test_reject():
    d = decision_for_choice("n", "rm f", Policy(), set())
    assert d["type"] == "reject" and d["message"]


def test_edit_decision_shape():
    d = edit_decision("touch g")
    assert d == {"type": "edit",
                 "edited_action": {"name": "execute",
                                   "args": {"command": "touch g"}}}


def test_edited_command_reclassified():
    p = Policy()
    assert reclassify_edited("rm -rf /", p).level == "deny"
    assert reclassify_edited("ls", p).level == "auto"
    assert reclassify_edited("touch f", p).level == "approve"
