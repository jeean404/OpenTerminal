"""最小复现：免审任务能否收到 task_end（不走 HTTP，直接 worker 层）。"""
import asyncio
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "src"))

os.environ["OPENTERMINAL_HOME"] = os.path.join(REPO, ".tmp", "mini-home")
os.makedirs(os.environ["OPENTERMINAL_HOME"], exist_ok=True)
with open(os.path.join(os.environ["OPENTERMINAL_HOME"], "config.toml"), "w") as f:
    f.write("""
[model]
provider = "anthropic"
base_url = "http://127.0.0.1:15721"
model = "claude-sonnet-4-6"
api_key_env = "ANTHROPIC_API_KEY"
[policy]
mode = "tiered"
[web]
host = "127.0.0.1"
port = 8271
""")
os.environ["ANTHROPIC_API_KEY"] = "mini-key"
os.environ["PYTHON_KEYRING_BACKEND"] = "keyring.backends.null.Keyring"
os.environ["PYTHONIOENCODING"] = "utf-8"

print("importing...", flush=True)
import serve_scripted_model  # noqa: E402
import openterminal.core as core  # noqa: E402
from openterminal.config import Config  # noqa: E402
from openterminal.web.worker import TabWorker  # noqa: E402
from openterminal.core import ClientMsg  # noqa: E402

print("imported ok", flush=True)


class Sink:
    def __init__(self):
        self.msgs = []

    async def send_bytes(self, d):
        self.msgs.append(("b", d))

    async def send_text(self, t):
        try:
            self.msgs.append(("j", json.loads(t)))
        except Exception:
            pass


async def main():
    core.build_chat_model = lambda cfg: serve_scripted_model.ScriptedFlowModel()
    cfg = Config.load()
    print("config loaded, targets:", list(cfg.targets.keys()), flush=True)
    w = TabWorker(cfg, "default")
    sink = Sink()
    w.attach(sink)
    await asyncio.wait_for(w.connected.wait(), timeout=30)
    print("connected, interactive=", w._interactive, flush=True)
    seen = set()
    for label, text in (("T1", "免审"), ("T2", "批准"), ("T3", "拒绝")):
        n0 = len(sink.msgs)
        await w.handle_client(ClientMsg(type="submit", text=text))
        print(f"[{label}] submitted {text!r}", flush=True)
        t0 = asyncio.get_event_loop().time()
        got_end = False
        while asyncio.get_event_loop().time() - t0 < 25:
            await asyncio.sleep(0.2)
            for k, m in sink.msgs[n0:]:
                if k == "j" and m.get("type") == "event":
                    ev = m.get("event", {})
                    kind = ev.get("kind")
                    if kind in ("task_start", "ai_result", "final",
                                "task_end", "error", "ai_card"):
                        key = (label, kind, str(ev.get("text", ""))[:40])
                        if key not in seen:
                            seen.add(key)
                            print(f"[{label}] EV:", kind,
                                  repr(str(ev.get("text", ev.get("markdown", ""))))[:60],
                                  flush=True)
                        if kind in ("task_end", "error"):
                            got_end = True
            if got_end:
                break
        print(f"[{label}] done, got_end=", got_end, flush=True)
    print("all done, ai_task=", w._ai_task, flush=True)
    os._exit(0)


asyncio.run(main())
