import json

from openterminal.web.protocol import (
    ClientMsg, ServerMsg, encode_server, parse_client,
)


def test_parse_raw_binary():
    # 二进制帧 = 键盘字节直发（唯一输入管线）
    m = parse_client(b"\x03")
    assert m.type == "raw" and m.data == b"\x03"


def test_parse_decision():
    m = parse_client('{"type":"decision","decision":{"type":"approve"}}')
    assert m.type == "decision" and m.decision == {"type": "approve"}


def test_parse_interrupt():
    m = parse_client('{"type":"interrupt"}')
    assert m.type == "interrupt"


def test_parse_change_model():
    m = parse_client('{"type":"change_model","model":"gpt-5"}')
    assert m.type == "change_model" and m.model == "gpt-5"


def test_parse_line_type_dropped():
    # 单管线契约：line/complete/exit_raw 已删除——未知类型原样带过来，
    # worker _dispatch 不认识即忽略
    m = parse_client('{"type":"line","text":"ls"}')
    assert m.type == "line" and m.text == "ls"
    m = parse_client('{"type":"complete","text":"gi","seq":1}')
    assert m.type == "complete"


def test_encode_server_omits_none():
    s = encode_server(ServerMsg(type="ready", tab_id="abc", host="h"))
    assert json.loads(s) == {"type": "ready", "tab_id": "abc", "host": "h"}


def test_roundtrip_resize():
    m = parse_client('{"type":"resize","cols":80,"rows":24}')
    assert m.type == "resize" and m.cols == 80 and m.rows == 24


def test_parse_auth_remember_defaults_false():
    m = parse_client('{"type":"auth","auth_kind":"password","text":"pw"}')
    assert m.remember is False
    m2 = parse_client('{"type":"auth","auth_kind":"password","text":"pw","remember":true}')
    assert m2.remember is True


def test_encode_server_omits_interactive_when_zero():
    s = encode_server(ServerMsg(type="ready", tab_id="a"))
    assert "interactive" not in json.loads(s)
    s = encode_server(ServerMsg(type="ready", tab_id="a", interactive=1))
    assert json.loads(s)["interactive"] == 1


def test_parse_mode_message():
    m = parse_client('{"type":"mode","text":"ssh"}')
    assert m.type == "mode" and m.text == "ssh"


def test_parse_submit_dirty_flag():
    # submit 的 dirty：半行镜像被转义/控制键清过 → worker 走 \x03 安全路径
    m = parse_client('{"type":"submit","text":"帮我查询","dirty":true}')
    assert m.type == "submit" and m.text == "帮我查询" and m.dirty is True
    m2 = parse_client('{"type":"submit","text":"帮我查询"}')
    assert m2.dirty is False


def test_encode_event_kinds():
    # 事件契约：task_start/ai_token/ai_think/ai_collapse/ai_card/final/denied/limit/error
    for kind, extra in (("task_start", {"text": "看看磁盘"}),
                        ("ai_token", {"text": "分"}),
                        ("ai_think", {"text": "思考"}),
                        ("ai_collapse", {"command": "df -h"}),
                        ("ai_card", {"markdown": "# 总结"}),
                        ("final", {"text": "完了"}),
                        ("denied", {"text": "拒绝"}),
                        ("limit", {"text": "限流"}),
                        ("error", {"text": "出错"})):
        s = encode_server(ServerMsg(type="event", event={"kind": kind, **extra}))
        obj = json.loads(s)
        assert obj["type"] == "event" and obj["event"]["kind"] == kind
        assert obj["event"][list(extra)[0]] == extra[list(extra)[0]]
