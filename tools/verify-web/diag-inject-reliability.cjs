// 取证：连接期集成注入成功率（竞态自愈验证）。
// 每轮新开 tab 连 local 目标，读服务端日志增量判定该次注入结果：
//   成功 = "prompt= True"（分片 drain 中见到提示符标记）
//   失败 = "纯终端直通"（探测未识别 / 注入后 8s 无标记）
// 用法：node tools/verify-web/diag-inject-reliability.cjs [port] [轮数]
"use strict";
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8297);
const ROUNDS = Number(process.argv[3] || 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用!)");
  const logPath = lib.OUT + `/server-${PORT}.log`;
  const browser = await lib.launch();
  const results = [];
  try {
    for (let i = 1; i <= ROUNDS; i++) {
      const before = fs.existsSync(logPath)
        ? fs.readFileSync(logPath, "utf8").length : 0;
      const { page } = await lib.openTab(browser, started.base);
      await page.waitForSelector("#targets .target", { timeout: 20000 });
      await page.locator("#targets .target", { hasText: "local" }).first().click();
      // 等连接完成（连接遮罩消失）
      let ready = false;
      for (let k = 0; k < 120; k++) {
        const st = await page.evaluate(() => {
          const conn = document.querySelector('[id^="conn-"]');
          const ov = document.querySelector('[id^="connov-"]');
          return { conn: conn ? conn.hidden : "missing",
                   ov: ov ? ov.hidden : "missing" };
        });
        if (st.conn === true && st.ov === true) { ready = true; break; }
        await sleep(400);
      }
      if (!ready) { results.push({ round: i, ok: false, why: "连接未就绪" }); }
      // 等注入结果落日志（成功 prompt= True / 失败 纯终端直通）
      let verdict = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const delta = fs.readFileSync(logPath, "utf8").slice(before);
        if (delta.includes("prompt= True")) { verdict = "ok"; break; }
        if (delta.includes("纯终端直通")) {
          verdict = delta.includes("probe 未识别") ? "probe-fail" : "inject-fail";
          break;
        }
        await sleep(300);
      }
      results.push({ round: i, ok: verdict === "ok", verdict: verdict || "timeout" });
      console.log(`round ${i}: ${results[i - 1].verdict}`);
      await page.close();
      await sleep(600);
    }
  } finally {
    await browser.close();
  }
  const ok = results.filter(r => r.ok).length;
  console.log(`\n注入成功 ${ok}/${ROUNDS}`, JSON.stringify(results));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
