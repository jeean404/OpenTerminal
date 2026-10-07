// Bug1 复现：连接档案「腾讯云主机」的命令集 ssh/sudo su/cd 三行应逐条等
// 密码，实测是否抢跑。采样 xterm 行时间线 + 截图。
// 用法：node tools/verify-web/bug1-repro.cjs [port]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8123);
const TARGET = process.argv[3] || "腾讯云主机";
const DURATION = Number(process.argv[4] || 45000);

async function main() {
  const { base, server } = await lib.startServer(PORT);
  const browser = await lib.launch();
  try {
    const { page, errors } = await lib.openTab(browser, base);
    await lib.pickTarget(page, TARGET);

    // 时间线采样：每 150ms 对比 xterm 文本，记录新增片段
    const timeline = [];
    let prev = "";
    const t0 = Date.now();
    await page.screenshot({ path: path.join(lib.OUT, "b1-00-open.png") });
    while (Date.now() - t0 < DURATION) {
      const cur = await lib.snapshot(page);
      if (cur !== prev) {
        timeline.push({ t: Date.now() - t0, len: cur.length, text: cur });
        prev = cur;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    await page.screenshot({ path: path.join(lib.OUT, "b1-99-final.png") });
    const finalText = await lib.snapshot(page);

    // 逐条打印「文本变化点」，只打增量
    console.log("===== BUG1 时间线（增量） =====");
    let shown = "";
    for (const ev of timeline) {
      const add = ev.text.slice(shown.length);
      if (add.trim()) {
        console.log(`[+${String(ev.t).padStart(5)}ms] ${JSON.stringify(add).slice(0, 400)}`);
      }
      shown = ev.text;
    }
    console.log("\n===== 最终屏幕 =====");
    console.log(finalText.split("\n").map((l, i) => `${i}| ${l}`).join("\n"));
    console.log("\n===== JS 错误 =====");
    console.log(errors.length ? errors.join("\n") : "(none)");

    // 断言口径
    const lines = finalText.split("\n");
    const idxPw = lines.findIndex(l => /password\s*[:：]/i.test(l));
    const idxSudo = lines.findIndex(l => /^\s*sudo su -\s*$/.test(l));
    const idxCd = lines.findIndex(l => /^\s*cd \/root\s*$/.test(l));
    console.log("\n===== 位置 =====");
    console.log("password 行号:", idxPw, " sudo su 行号:", idxSudo, " cd/root 行号:", idxCd);
    if (idxPw >= 0 && idxSudo >= 0) {
      console.log(idxSudo < idxPw
        ? "FAIL  `sudo su -` 回显早于密码提示 → 抢跑（bug1）"
        : "PASS  `sudo su -` 在密码提示之后");
    }
    fs.writeFileSync(path.join(lib.OUT, "b1-timeline.json"),
      JSON.stringify(timeline.map(e => ({ t: e.t, text: e.text })), null, 1));
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
