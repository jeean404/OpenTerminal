import json

from openterminal.transcript import Transcript


def test_append_jsonl(tmp_path):
    p = tmp_path / "s.jsonl"
    t = Transcript(p)
    t.append("user", text="你好")
    t.append("tool", command="ls", exit_code=0)
    lines = p.read_text(encoding="utf-8").strip().splitlines()
    rows = [json.loads(x) for x in lines]
    assert rows[0]["kind"] == "user" and rows[0]["text"] == "你好"
    assert rows[1]["kind"] == "tool" and rows[1]["exit_code"] == 0
    assert "ts" in rows[0]
