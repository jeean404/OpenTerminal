// 诊断：审批帧到达瞬间抓现场——审批卡/模态到底有没有、能不能点。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8128);
const TARGET = process.argv[3] || "local";
const QUESTION = process.argv[4] || "查看当前docker容器";
const DUR = Number(process.argv[5] || 90000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dump = page => page.evaluate(() => {
  const out = { err: "" };
  try {
    const s = sessions[activeTabId];
    out.approvalOpen = !!s._approvalOpen;
    out.approvalCmd = s._approvalCmd;
    out.feedReady = !!s._feed;
    out.feedPromise = !!s._feedPromise;
    out.slots = [];
    for (const [id, sl] of (s._slots || new Map())) {
      out.slots.push({ id, mounted: !!sl.mounted, pinnedRows: sl.pinnedRows,
                       hasHost: !!sl.host, kind: sl.kind, frozen: !!sl.frozen });
    }
    const modal = document.querySelector("#modal-root .modal");
    out.modal = modal ? (modal.innerText || "").slice(0, 200) : null;
    const think = document.querySelector('[id^="think-"]');
    out.thinkText = think ? (think.innerText || "").trim() : null;
    out.thinkHidden = think ? !!think.hidden : null;
    out.taskActive = !!s._taskActive;
    out.cardHosts = document.querySelectorAll(".xterm-rows .ot-host, .ot-host").length;
    out.anyIsland = document.querySelectorAll("[class*=island], [class*=ot-card], .ot-host").length;
  } catch (e) { out.err = String(e); }
  return out;
});

async function main() {
  const started = await lib.startServer(PORT);
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用)");
  const browser = await lib.launch();
  try {
    const { page, errors } = await lib.openTab(browser, started.base);
    await lib.pickTarget(page, TARGET);
    await page.waitForFunction(() =>
      typeof sessions !== "undefined" && sessions[activeTabId], null, { timeout: 30000 });
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
    console.log("已提问");

    let approvalAt = null;
    while (Date.now() - askAt < DUR) {
      const st = await page.evaluate(() => {
        const s = sessions[activeTabId];
        return {
          approvalOpen: !!s._approvalOpen,
          approvalCmd: s._approvalCmd,
          think: (() => {
            const el = document.querySelector('[id^="think-"]');
            return el ? (el.hidden ? "hidden" : (el.innerText || "").trim()) : "missing";
          })(),
          modal: !!document.querySelector("#modal-root .modal"),
        };
      });
      if (st.approvalOpen || st.modal) {
        approvalAt = Date.now() - askAt;
        console.log("审批 UI 出现 @+" + approvalAt + "ms", JSON.stringify(st));
        break;
      }
      if (st.think === "hidden" && Date.now() - askAt > 8000) {
        console.log("任务收束 @+" + (Date.now() - askAt) + "ms（没走审批）");
        break;
      }
      await sleep(400);
    }
    // 给看门狗留出 grace 之后再抓
    await sleep(5000);
    const d = await dump(page);
    console.log("现场:", JSON.stringify(d, null, 1));
    fs.writeFileSync(path.join(lib.OUT, "diag-b5-dump.json"), JSON.stringify(d, null, 1));
    await page.screenshot({ path: path.join(lib.OUT, "diag-b5-approval.png") });
    fs.writeFileSync(path.join(lib.OUT, "diag-b5-screen.txt"), await lib.snapshot(page));
    console.log("审批出现时刻:", approvalAt);
    console.log("JS 错误:", errors.length ? errors.join("\n") : "(none)");
  } finally {
    await browser.close();
    if (started.server) started.server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
