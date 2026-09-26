"""会话 JSONL 记录。"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from .config import app_dir


class Transcript:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, kind: str, **fields) -> None:
        row = {"ts": dt.datetime.now().isoformat(timespec="seconds"),
               "kind": kind, **fields}
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def open_transcript(session_id: str) -> Transcript:
    day = dt.date.today().isoformat()
    return Transcript(app_dir() / "sessions" / day / f"{session_id}.jsonl")
