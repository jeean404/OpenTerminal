// 真机浏览器验证：设置页开着时点「连接服务器」必须直接跳回终端界面。
// 用法：node tools/verify-web/verify-settings-jump.cjs [port]
//
// 背景：body.settings-open 会把 #tabbar/#panes display:none，设置页盖住终端。
// 侧栏点主机 / 添加远程机器保存都走 openTab——tab 建好了却仍停在设置页。
//
// 覆盖点：
//   侧栏点主机 —— openTab 成功后设置页让位，tabbar/panes 回来
//   添加远程机器保存 —— 同上（保存成功也会 openTab 去连）
//   返回终端按钮 —— 原有关闭路径不受影响
// 截图与逐步日志落 .tmp/live/；无论成败都回收浏览器与服务端后退出。
"use strict";
const lib = require("./lib");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8439);
const HOME = path.join(lib.REPO, ".tmp", "settings-jump-home");
const LOG = path.join(lib.OUT, "settings-jump.log");

const results = [];
function log(line) {
  try { fs.appendFileSync(LOG, line + "\n", "utf8"); } catch (e) { /* ignore */ }
  console.log(line);
}
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}
const step = name => log("… " + name);

// 三处可见性一起读：hidden 属性只是其一，真正盖住终端的是 body.settings-open
// 那两条 display:none 规则，光看 hidden 会漏判。
async function viewState(page) {
  return page.evaluate(() => {
    const v = document.getElementById("settings-view");
    const panes = document.getElementById("panes");
    const tabbar = document.getElementById("tabbar");
    return {
      settingsHidden: v ? v.hidden : null,
      bodyOpen: document.body.classList.contains("settings-open"),
      panesShown: panes ? getComputedStyle(panes).display !== "none" : null,
      tabbarShown: tabbar ? getComputedStyle(tabbar).display !== "none" : null,
    };
  });
}
const isTerminal = s => s.settingsHidden === true && !s.bodyOpen
  && s.panesShown === true && s.tabbarShown === true;
const isSettings = s => s.settingsHidden === false && s.bodyOpen === true
  && s.panesShown === false && s.tabbarShown === false;

async function waitState(page, pred, ms = 15000) {
  const t0 = Date.now();
  let last = await viewState(page);
  while (Date.now() - t0 < ms) {
    if (pred(last)) return last;
    await sleep(200);
    last = await viewState(page);
  }
  return last;
}

let browser = null;
let serverRef = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (e) { /* ignore */ }
  try { if (serverRef) serverRef.kill(); } catch (e) { /* ignore */ }
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(lib.OUT, { recursive: true });
  fs.writeFileSync(LOG, "", "utf8");

  const started = await lib.startServer(PORT, { env: { OPENTERMINAL_HOME: HOME } });
  serverRef = started.server;
  const base = started.base;
  log("服务端: " + base + (serverRef ? "（本次启动）" : "（复用已有）"));

  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      browser = await chromium.launch({
        headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], ...opts,
      });
      log("浏览器: " + (opts.channel || "bundled chromium"));
      break;
    } catch (e) { /* 换下一个 */ }
  }
  if (!browser) throw new Error("无法启动浏览器");

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems = [];
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  page.on("response", r => {
    if (r.status() >= 400 && !/favicon/i.test(r.url())) problems.push("http " + r.status() + " " + r.url());
  });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  await sleep(500);

  // --- 1. 进设置页（前置状态）---
  step("打开设置页");
  await page.click("#btn-settings");
  await sleep(400);
  let st = await viewState(page);
  check("设置页打开后盖住终端", isSettings(st), JSON.stringify(st));

  // 「返回终端」要钉在左上角：整颗按钮落在 header 的左半 + 上半。
  // 旧版式把按钮 space-between 推到右上（中心约在 header 宽度 94% 处），
  // 这两条一起卡死它回不去右边。
  step("返回终端按钮位置");
  const geo = await page.evaluate(() => {
    const b = document.getElementById("btn-close-settings").getBoundingClientRect();
    const h = document.querySelector(".settings-header").getBoundingClientRect();
    return { bx: Math.round(b.x + b.width / 2), by: Math.round(b.y + b.height / 2),
             hx: Math.round(h.x), hy: Math.round(h.y), hw: Math.round(h.width), hh: Math.round(h.height) };
  });
  check("返回终端按钮在左上角",
    geo.bx < geo.hx + geo.hw * 0.35 && geo.by < geo.hy + geo.hh * 0.55,
    JSON.stringify(geo));
  await page.screenshot({ path: path.join(lib.OUT, "settings-jump-layout.png") });

  // --- 2. 侧栏点主机 = 「连接服务器」---
  step("侧栏点主机连接");
  await page.click("#targets .target");
  st = await waitState(page, isTerminal);
  check("点主机后跳到终端界面", isTerminal(st), JSON.stringify(st));
  await page.screenshot({ path: path.join(lib.OUT, "settings-jump-after-click.png") });

  // --- 3. 添加远程机器：保存成功即连接，同样要跳回终端 ---
  step("设置页里添加远程机器");
  await page.click("#btn-settings");
  await sleep(400);
  await page.click("#btn-add-remote");
  await page.waitForSelector("#f-host", { timeout: 5000 });
  await page.fill("#f-name", "jump-test");
  await page.fill("#f-host", "127.0.0.1");
  await page.fill("#f-port", "1");          // 必连失败，只验视图切换
  await page.fill("#f-user", "nobody");
  await page.click(".modal-btns button.primary");
  st = await waitState(page, isTerminal);
  check("保存连接后跳到终端界面", isTerminal(st), JSON.stringify(st));
  await page.screenshot({ path: path.join(lib.OUT, "settings-jump-after-save.png") });

  // --- 4. 回归：「返回终端」按钮照旧 ---
  step("返回终端按钮");
  await page.click("#btn-settings");
  await sleep(400);
  st = await viewState(page);
  check("再次进设置页", isSettings(st), JSON.stringify(st));
  await page.click("#btn-close-settings");
  await sleep(300);
  st = await viewState(page);
  check("返回终端按钮仍能关闭设置", isTerminal(st), JSON.stringify(st));

  check("无页面异常", problems.length === 0, problems.slice(0, 5).join(" | "));
  cleanup();
  const bad = results.filter(r => !r.ok);
  log("");
  log(bad.length ? `失败 ${bad.length} 项` : `全部通过（${results.length} 项）`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => {
  log("异常: " + (e && e.stack || e));
  cleanup();
  process.exit(1);
});
