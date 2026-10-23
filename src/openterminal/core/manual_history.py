"""用户手动命令的滚动摘要——agent 中间件的「现场感」数据源。

用户在终端自己敲的命令不在 agent 的消息历史里（`_run_task` 只把自然语言
原文交给 TaskRunner），模型因此不知道刚才发生了什么。但全塞进上下文又
太占，所以只留最近 N 条，并按结果给不同长度的尾部：

- 成功：短尾（够看清 `docker ps` 这类的结论）
- 失败：长尾（排错要看报错）

输出一律脱敏后才进摘要——命令输出里可能有密码、token、密钥。

`take_new()` 是**增量**：只返回还没送进模型的条目，送过就跳过。所以同一段
命令不会一轮轮重复，上下文只随新命令增长。
"""

from __future__ import annotations

import re
from collections import deque

# 滚动窗口：再早的命令对「现场感」没有价值，留着只占上下文
DEFAULT_LIMIT = 20
# 尾部截断：成功短、失败长（失败才需要报错全文）
TAIL_OK = 400
TAIL_FAIL = 1500

# 常见密钥形态：KEY=value、key: value。只脱值、保留键名，模型仍知道
# 「这里有个 token」但拿不到值。(?!) 让开 Bearer/Basic —— 那种交给下面
# _BEARER 整段处理，否则只脱掉 "Bearer"、真正的 token 还留在后面。
_SECRET_KEY = re.compile(
    r"(?i)\b([A-Z0-9_\-\.]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|"
    r"AUTH)[A-Z0-9_\-\.]*)\s*[:=]\s*([\"']?)(?!bearer\b|basic\b)"
    r"([^\s\"'\`,;*]{4,})\2")
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+([A-Za-z0-9._\-+/=]{8,})")


def redact(text: str) -> str:
    """把输出里的密钥值换成 ***（键名保留）。"""
    text = _SECRET_KEY.sub(lambda m: f"{m.group(1)}={m.group(2)}***{m.group(2)}", text)
    return _BEARER.sub(lambda m: f"{m.group(1)} ***", text)


def _tail(raw: bytes | str, limit: int) -> tuple[str, int, bool]:
    """返回 (尾部文本, 总行数, 是否截断)。取尾部是因为报错与结论都在后面。"""
    text = raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else raw
    stripped = text.strip()
    lines = text.count("\n") + (1 if stripped else 0)
    clipped = stripped
    if len(clipped) > limit:
        clipped = clipped[-limit:]
        nl = clipped.find("\n")          # 从行边界切，别把半行塞给模型
        if 0 <= nl < 40:
            clipped = clipped[nl + 1:]
        clipped = "……（前面已截断）\n" + clipped
    return clipped, lines, len(stripped) > limit


def format_section(items: list[dict]) -> str:
    """把一批命令渲染成要并进消息的文本块。"""
    rows = []
    for item in reversed(items):        # 最新在前
        head = f"- `{item['command']}` → 退出 {item['exit_code']}，输出 {item['lines']} 行"
        if item.get("cwd"):
            head += f"（cwd: {item['cwd']}）"
        rows.append(head)
        if item["tail"]:
            note = "，已截断" if item["truncated"] else ""
            rows.append(f"  ```\n  {item['tail']}\n  ```  # 输出{note}")
    return (
        "【你在任务外，用户手动执行了】\n"
        "这些命令不在你的工具调用记录里，是用户自己在终端敲的。"
        "据此了解现场，必要时提及相关结果；不要整段复述。\n\n"
        + "\n".join(rows)
    )


class ManualHistory:
    """手动命令的环形缓冲。只在事件循环里被调用，不做加锁。"""

    def __init__(self, limit: int = DEFAULT_LIMIT) -> None:
        self._items: deque[dict] = deque(maxlen=max(1, limit))
        self._seq = 0
        self._sent_seq = 0

    def record(self, command: str, exit_code, output: bytes | str = b"",
               *, cwd: str | None = None) -> None:
        command = (command or "").strip()
        if not command:
            return
        failed = isinstance(exit_code, int) and exit_code not in (0, 130, 143)
        limit = TAIL_FAIL if failed else TAIL_OK
        tail, lines, truncated = _tail(output, limit)
        self._seq += 1
        self._items.append({
            "seq": self._seq,
            "command": command,
            "exit_code": exit_code,
            "lines": lines,
            "tail": redact(tail),
            "truncated": truncated,
            "cwd": cwd,
        })

    def take_new(self) -> str:
        """返回尚未送进模型的命令摘要；送过的跳过，没有新的返回空串。

        读即标记：模型调用失败重试的窄边上会丢这一批（下次 take_new 不再给），
        代价是换来「绝不重复注入」——比偶尔重试丢一条摘要更值得。
        """
        fresh = [i for i in self._items if i["seq"] > self._sent_seq]
        if not fresh:
            return ""
        self._sent_seq = fresh[-1]["seq"]
        return format_section(fresh)

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)
