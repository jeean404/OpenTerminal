// 最小诊断：点设置按钮为什么没反应。抓控制台/页面异常 + 按钮是否有 handler。
"use strict";
const lib = require("./lib");
const path = require("node:path");
const { chromium } = require("playwright");

const PORT = Number(process.argv[2] || 8450);
const HOME = path.join(lib.REPO, ".tmp", "diag-settings-home");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { base, server } = await lib.startServer(PORT, { env: { OPENTERMINAL_HOME: HOME } });
  console.log("服务端:", base);
  const browser = await chromium.launch({
    headless: true, channel: "chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  page.on("console", m => {
    if (m.type() === "error") console.log("CONSOLE:", m.text());
  });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 20000 });
  await sleep(800);

  const probe = await page.evaluate(() => {
    const btn = document.getElementById("btn-settings");
    return {
      hasBtn: !!btn,
      // onclick 属性有没有被赋上
      onclickType: typeof (btn && btn.onclick),
      hasShowSettings: typeof showSettings,
      hasT: typeof t,
      hasSetLang: typeof setLang,
      hasCurrentLang: typeof currentLang,
      hasApplyStaticI18n: typeof applyStaticI18n,
      hasModalShell: typeof modalShell,
      hasAuthFetch: typeof authFetch,
      hasEsc: typeof esc,
      langAttr: document.documentElement.lang,
      scripts: [...document.scripts].map(s => s.src.split("/").pop()).filter(Boolean),
    };
  });
  console.log("探针:", JSON.stringify(probe, null, 2));

  const before = await page.evaluate(() => {
    const v = document.getElementById("settings-view");
    return { hidden: v ? v.hidden : "no-el", bodyOpen: document.body.className };
  });
  console.log("点击前:", JSON.stringify(before));

  await page.click("#btn-settings");
  await sleep(600);
  const after = await page.evaluate(() => {
    const v = document.getElementById("settings-view");
    return { hidden: v ? v.hidden : "no-el", bodyOpen: document.body.className };
  });
  console.log("点击后:", JSON.stringify(after));

  await page.screenshot({ path: path.join(lib.OUT, "diag-settings-click.png") });
  await browser.close();
  if (server) server.kill();
  process.exit(0);
})().catch(e => {
  console.error("诊断异常:", e && e.stack || e);
  process.exit(1);
});
