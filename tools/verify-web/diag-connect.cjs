// 诊断：连接过程采样（连接栏/状态栏/终端/弹窗），定位卡在哪一步。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8124);
const TARGET = process.argv[3] || "腾讯云主机";
const DUR = Number(process.argv[4] || 60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function probe(page) {
  return page.evaluate(() => {
    const g = id => {
      const el = document.querySelector(`[id^="${id}-"]`);
      return el ? (el.innerText || "").trim() : "";
    };
    const rows = document.querySelector(".xterm-rows");
    const modal = document.querySelector("#modal-root .modal");
    const think = document.querySelector('[id^="think-"]');
    return {
      conn: g("conn"),
      status: g("status"),
      cs: g("cs"),
      term: rows ? (rows.textContent || "") : "",
      modal: modal ? (modal.innerText || "").slice(0, 200) : "",
      think: think ? (think.hidden ? "hidden" : "shown") : "missing",
    };
  });
}

async function main() {
  const { base, server } = await lib.startServer(PORT);
  const browser = await lib.launch();
  try {
    const { page, errors } = await lib.openTab(browser, base);
    await lib.pickTarget(page, TARGET);
    const t0 = Date.now();
    let prev = "";
    while (Date.now() - t0 < DUR) {
      const p = await probe(page);
      const line = `[+${String(Date.now() - t0).padStart(6)}ms] conn=${JSON.stringify(p.conn)} cs=${JSON.stringify(p.cs)} think=${p.think} modal=${JSON.stringify(p.modal)} termLen=${p.term.length}`;
      if (line !== prev) {
        console.log(line);
        if (p.term) console.log("      term=" + JSON.stringify(p.term.slice(-300)));
        if (p.status) console.log("      status=" + JSON.stringify(p.status));
        prev = line;
      }
      await sleep(500);
    }
    await page.screenshot({ path: path.join(lib.OUT, "diag-final.png") });
    fs.writeFileSync(path.join(lib.OUT, "diag-screen.txt"), (await probe(page)).term);
    console.log("JS 错误:", errors.length ? errors.join("\n") : "(none)");
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
