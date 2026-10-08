// 诊断：提问后前端到底收到了哪些事件（定位「AI 正在思考」不收的卡点）。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8127);
const TARGET = process.argv[3] || "local";
const QUESTION = process.argv[4] || "查看当前docker容器";
const DUR = Number(process.argv[5] || 200000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const started = await lib.startServer(PORT);
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用)");
  const browser = await lib.launch();
  try {
    const { page, errors } = await lib.openTab(browser, started.base);
    await lib.pickTarget(page, TARGET);
    // hook 必须在 tab 对象建好之后（openTab 时 sessions 还是空的）
    await page.waitForFunction(() =>
      typeof sessions !== "undefined" && typeof activeTabId !== "undefined" &&
      sessions[activeTabId], null, { timeout: 30000 });
    await page.evaluate(() => {
      window.__otMsgs = [];
      const s = sessions[activeTabId];
      const orig = s.handleMsg.bind(s);
      s.handleMsg = (m) => {
        const rec = { t: Date.now(), type: m.type };
        if (m.type === "event" && m.event) {
          rec.kind = m.event.kind;
          if (m.event.kind === "tool_start" || m.event.kind === "tool_call")
            rec.text = (m.event.text || m.event.command || "").slice(0, 60);
        } else if (m.type === "ai_token") {
          rec.n = (m.text || "").length;
        } else if (m.text) {
          rec.text = String(m.text).slice(0, 50);
        }
        window.__otMsgs.push(rec);
        return orig(m);
      };
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const ok = await page.evaluate(() => {
        const vis = id => {
          const el = document.querySelector(`[id^="${id}-"]`);
          return el ? el.hidden : true;
        };
        return vis("conn") && vis("connov");
      });
      if (ok) break;
      await sleep(400);
    }
    console.log("就绪:", Date.now() - t0, "ms");

    await page.locator(".term").click();
    await page.keyboard.type(QUESTION, { delay: 25 });
    await page.keyboard.press("Enter");
    const askAt = Date.now();
    console.log("已提问:", JSON.stringify(QUESTION));

    let lastN = 0, lastThink = "";
    while (Date.now() - askAt < DUR) {
      const st = await page.evaluate(() => ({
        msgs: (window.__otMsgs || []).length,
        tail: (window.__otMsgs || []).slice(-8),
        think: (() => {
          const el = document.querySelector('[id^="think-"]');
          return el ? (el.hidden ? "hidden" : "shown") : "missing";
        })(),
        runtime: (() => {
          const s = sessions[activeTabId];
          return { taskActive: !!s._taskActive, ws: s.ws ? s.ws.readyState : null,
                   hold: s._holdDepth || 0 };
        })(),
      }));
      if (st.msgs !== lastN || st.think !== lastThink) {
        const ms = Date.now() - askAt;
        console.log(`[+${String(ms).padStart(6)}ms] msgs=${st.msgs} think=${st.think} ` +
                    `taskActive=${st.runtime.taskActive} ws=${st.runtime.ws}`);
        for (const r of st.tail) console.log("      ", JSON.stringify(r));
        lastN = st.msgs; lastThink = st.think;
      }
      if (st.think === "hidden" && Date.now() - askAt > 8000) {
        console.log("任务收束，用时", Date.now() - askAt, "ms");
        break;
      }
      await sleep(1000);
    }
    const all = await page.evaluate(() => window.__otMsgs || []);
    fs.writeFileSync(path.join(lib.OUT, "diag-b4-msgs.json"), JSON.stringify(all, null, 1));
    console.log("总消息数:", all.length);
    const kinds = {};
    for (const m of all) { const k = m.kind || m.type; kinds[k] = (kinds[k] || 0) + 1; }
    console.log("事件分布:", JSON.stringify(kinds));
    console.log("末 20 条:");
    for (const r of all.slice(-20)) console.log("   ", JSON.stringify(r));
    fs.writeFileSync(path.join(lib.OUT, "diag-b4-screen.txt"), await lib.snapshot(page));
    console.log("JS 错误:", errors.length ? errors.join("\n") : "(none)");
  } finally {
    await browser.close();
    if (started.server) started.server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
