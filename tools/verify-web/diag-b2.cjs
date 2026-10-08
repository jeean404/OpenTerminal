// 诊断：local 目标就绪耗时 + 打字前后前端运行时状态（hold/ws/回显）。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8125);
const TARGET = process.argv[3] || "local";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const runtime = page => page.evaluate(() => {
  const out = { err: "" };
  try {
    const s = (typeof sessions !== "undefined" && typeof activeTabId !== "undefined")
      ? sessions[activeTabId] : null;
    if (!s) { out.err = "sessions/activeTabId 不可见"; return out; }
    out.mode = s.mode;
    out.dead = !!s._dead;
    out.taskActive = !!s._taskActive;
    out.status = s.status;
    out.statusText = s.statusText;
    out.wsState = s.ws ? s.ws.readyState : null;
    out.keyBacklog = s._keyBacklog ? s._keyBacklog.length : 0;
    out.holdDepth = s._holdDepth || 0;
    out.holdTags = (s._holdTags || []).slice();
    out.holdSince = s._holdSince || 0;
    out.bufLen = s._holdBuf ? s._holdBuf.length : 0;
    out.everRetried = !!s._everRetried;
    out.wsRetries = s._wsRetries || 0;
    out.lastSendAt = s._lastSendAt || 0;
    out.lastMsgAt = s._lastMsgAt || 0;
    out.lastByteAt = s._lastByteAt || 0;
  } catch (e) { out.err = String(e); }
  return out;
});

const probe = page => page.evaluate(() => {
  const vis = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  };
  const g = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.innerText || "").trim() : "";
  };
  return { connVis: vis("conn"), overlayVis: vis("connov"),
           think: vis("think"), status: g("status"), cs: g("cs") };
});

async function main() {
  const started = await lib.startServer(PORT);
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用)");
  const browser = await lib.launch();
  try {
    const { page, errors } = await lib.openTab(browser, started.base);
    await lib.pickTarget(page, TARGET);
    const t0 = Date.now();
    let readyAt = null;
    while (Date.now() - t0 < 240000) {
      const p = await probe(page);
      if (p.connVis === "hidden" && p.overlayVis === "hidden") { readyAt = Date.now() - t0; break; }
      await sleep(500);
    }
    console.log("就绪耗时:", readyAt === null ? ">240s" : readyAt + "ms");
    console.log("就绪后 probe:", JSON.stringify(await probe(page)));
    console.log("就绪后 runtime:", JSON.stringify(await runtime(page), null, 1));
    await page.screenshot({ path: path.join(lib.OUT, "diag-b2-ready.png") });
    fs.writeFileSync(path.join(lib.OUT, "diag-b2-ready.txt"), await lib.snapshot(page));

    // 打字探针
    await page.locator(".term").click();
    const before = await lib.snapshot(page);
    await page.keyboard.type("ZDIAG", { delay: 20 });
    await sleep(1200);
    const mid = await lib.snapshot(page);
    console.log("打字后 runtime:", JSON.stringify(await runtime(page), null, 1));
    console.log("打字回显:", mid.includes("ZDIAG") ? "有" : "无");
    console.log("屏幕变化:", mid === before ? "无" : "有");
    fs.writeFileSync(path.join(lib.OUT, "diag-b2-typed.txt"), mid);

    await page.keyboard.press("Enter");
    await sleep(1500);
    const after = await lib.snapshot(page);
    console.log("回车后 runtime:", JSON.stringify(await runtime(page), null, 1));
    console.log("回车后屏幕变化:", after === mid ? "无" : "有");
    fs.writeFileSync(path.join(lib.OUT, "diag-b2-enter.txt"), after);
    await page.screenshot({ path: path.join(lib.OUT, "diag-b2-final.png") });
    console.log("JS 错误:", errors.length ? errors.join("\n") : "(none)");
  } finally {
    await browser.close();
    if (started.server) started.server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
