// 诊断：嵌套换壳期间 xterm buffer 何时被清空/重置
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");
const PORT = Number(process.argv[2] || 8242);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const stats = page => page.evaluate(() => {
  try {
    const s = sessions[activeTabId];
    const b = s.term.buffer.active;
    const rows = [];
    for (let i = 0; i < b.length; i++) {
      const t = b.getLine(i) ? b.getLine(i).translateToString(true) : "";
      if (t.trim()) rows.push(i + ": " + t.slice(0, 60));
    }
    return { len: b.length, baseY: b.baseY, curY: b.cursorY, curX: b.cursorX,
             rows };
  } catch (e) { return { err: String(e) }; }
});

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  console.log("server", started.base, started.server ? "(new)" : "(reused!)");
  const browser = await lib.launch();
  const { page } = await lib.openTab(browser, started.base);
  await lib.pickTarget(page, "腾讯云主机");
  await sleep(2000);
  // 包装 term.write / reset / clear 留痕
  await page.evaluate(() => {
    const s = sessions[activeTabId];
    window.__wlog = [];
    const t = s.term;
    const ow = t.write.bind(t);
    t.write = (d, cb) => {
      const n = typeof d === "string" ? d.length : d.length;
      window.__wlog.push([Date.now() % 100000, n,
        (typeof d === "string" ? d : new TextDecoder().decode(d)).slice(0, 40)]);
      if (window.__wlog.length > 4000) window.__wlog.shift();
      return ow(d, cb);
    };
    const oi = s._ingestBytes.bind(s);
    window.__ilog = [];
    s._ingestBytes = u8 => {
      window.__ilog.push([Date.now() % 100000, u8.length,
        new TextDecoder().decode(u8).slice(0, 40)]);
      if (window.__ilog.length > 4000) window.__ilog.shift();
      return oi(u8);
    };
    for (const m of ["reset", "clear"]) {
      if (typeof t[m] === "function") {
        const om = t[m].bind(t);
        t[m] = (...a) => { window.__wlog.push([Date.now() % 100000, m]);
                            return om(...a); };
      }
    }
  }).catch(e => console.log("wrap failed:", String(e).slice(0, 120)));
  const t0 = Date.now();
  const trace = [];
  while (Date.now() - t0 < 45000) {
    const st = await stats(page);
    st.rows = st.rows || [];
    trace.push({ t: Date.now() - t0, ...st });
    await sleep(500);
  }
  fs.writeFileSync(path.join(lib.OUT, "wipe-trace.json"),
                   JSON.stringify(trace, null, 1));
  const wlog = await page.evaluate(() => window.__wlog || []);
  const ilog = await page.evaluate(() => window.__ilog || []);
  const hold = await page.evaluate(() => {
    const s = sessions[activeTabId];
    return { depth: s._holdDepth, tags: s._holdTags,
             welcome: !!s._welcomeHold,
             holdBuf: s._holdBuf ? s._holdBuf.length : 0 };
  });
  fs.writeFileSync(path.join(lib.OUT, "wipe-ilog.json"),
                   JSON.stringify(ilog, null, 1));
  console.log("--- hold state ---", JSON.stringify(hold));
  console.log("--- ingest log: password/Last login/prompt rows ---");
  console.log(ilog.filter(w => /password|Last login|centos|ubuntu@/.test(w[2]))
    .map(w => JSON.stringify(w)).join("\n"));
  fs.writeFileSync(path.join(lib.OUT, "wipe-wlog.json"),
                   JSON.stringify(wlog, null, 1));
  // 打印 buffer 行数变化点
  let prev = null;
  for (const ev of trace) {
    const sig = ev.len + "/" + ev.baseY + "/" + ev.rows.length;
    if (sig !== prev) {
      console.log(ev.t + "ms len=" + ev.len + " baseY=" + ev.baseY +
                  " nonEmpty=" + ev.rows.length);
      prev = sig;
    }
  }
  console.log("--- final rows ---");
  console.log((trace[trace.length - 1].rows || []).join("\n"));
  console.log("--- write log tail 25 ---");
  console.log(wlog.slice(-25).map(w => JSON.stringify(w)).join("\n"));
  await browser.close().catch(() => {});
  process.exit(0);
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
