// 诊断：打字后 xterm 是否真的 write（区分字节被吞 vs 渲染没跟上）。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8126);
const TARGET = process.argv[3] || "local";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const snapState = page => page.evaluate(() => {
  const out = { err: "" };
  try {
    const s = sessions[activeTabId];
    const buf = s.term.buffer.active;
    out.writes = window.__otWrites || 0;
    out.wroteBytes = window.__otWroteBytes || 0;
    out.welcomeHold = !!s._welcomeHold;
    out.welcomeHoldAge = s._welcomeHold ? Math.round(performance.now() - s._welcomeHold.at) : -1;
    out.holdDepth = s._holdDepth || 0;
    out.holdBufLen = s._holdBuf ? s._holdBuf.length : 0;
    out.wsState = s.ws ? s.ws.readyState : null;
    out.dead = !!s._dead;
    out.cursor = { x: buf.cursorX, y: buf.cursorY };
    out.buf = { len: buf.length, baseY: buf.baseY, viewportY: buf.viewportY };
    out.ghostHide = !!s._ghostHide;
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
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const p = await page.evaluate(() => {
        const vis = id => {
          const el = document.querySelector(`[id^="${id}-"]`);
          return el ? el.hidden : true;
        };
        return vis("conn") && vis("connov");
      });
      if (p) break;
      await sleep(500);
    }
    console.log("就绪:", Date.now() - t0, "ms");

    // 挂 write 计数器
    await page.evaluate(() => {
      window.__otWrites = 0; window.__otWroteBytes = 0;
      const s = sessions[activeTabId];
      const orig = s._writeTerm.bind(s);
      s._writeTerm = (data) => {
        window.__otWrites++;
        try { window.__otWroteBytes += data.length; } catch (e) {}
        return orig(data);
      };
    });

    await page.locator(".term").click();
    const st0 = await snapState(page);
    const txt0 = await lib.snapshot(page);
    console.log("打字前:", JSON.stringify(st0));
    console.log("打字前末行:", JSON.stringify(txt0.split("\n").slice(-2).join(" | ")));

    await page.keyboard.type("ZDIAG", { delay: 30 });
    await sleep(1500);
    const st1 = await snapState(page);
    const txt1 = await lib.snapshot(page);
    console.log("打字后:", JSON.stringify(st1));
    console.log("打字后末行:", JSON.stringify(txt1.split("\n").slice(-2).join(" | ")));
    console.log("write 调用增量:", st1.writes - st0.writes, " 字节增量:", st1.wroteBytes - st0.wroteBytes);
    console.log("回显:", txt1.includes("ZDIAG") ? "有" : "无", " 屏幕变化:", txt1 === txt0 ? "无" : "有");
    fs.writeFileSync(path.join(lib.OUT, "diag-b3-typed.txt"), txt1);

    await page.keyboard.press("Enter");
    await sleep(2000);
    const st2 = await snapState(page);
    const txt2 = await lib.snapshot(page);
    console.log("回车后:", JSON.stringify(st2));
    console.log("回车后末行:", JSON.stringify(txt2.split("\n").slice(-2).join(" | ")));
    console.log("write 调用增量:", st2.writes - st1.writes);
    fs.writeFileSync(path.join(lib.OUT, "diag-b3-enter.txt"), txt2);
    await page.screenshot({ path: path.join(lib.OUT, "diag-b3-final.png") });
    console.log("JS 错误:", errors.length ? errors.join("\n") : "(none)");
  } finally {
    await browser.close();
    if (started.server) started.server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
