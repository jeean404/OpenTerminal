// 真机取证：文件面板定时器泄漏（关 tab 后无限刷 404）。
//
// 现象（真机日志）：关掉 tab 之后，服务端每 1～2 秒刷一条
//   "GET /api/tabs/<tabId>/files/state HTTP/1.1" 404 Not Found
// 直到刷新页面才停。
//
// 根因：两条定时链都不跟会话一起死
//   ① _startFollow 的 2 秒 _followTick —— 404 被 `if (!r.ok) return` 吞掉；
//   ② _fetchState 把 404 当「未就绪」走 _pending 退避重试。
// Session.close() 清了别的定时器却没碰 filesPanel。
//
// 三条断言，缺一不可：
//   A（正向对照）面板展开期间 /files/state 是**持续**轮询（≥2 次 / 6s），
//     不是一次性探测——否则 0 请求只是 follow 根本没武装，B 会假绿；
//   B（回归）关掉 tab 之后一个新请求都不许再有；
//   B2 页面无 JS 报错。
//
// 时序坑（两个，都会让 A 只有 1 次、B 假绿）：
//   · app.js 在 WS ready 时调 probeSupport()，local target 会
//     setSupported(false) → _stopFollow()。必须等它跑完再 toggle；
//   · open() 里 `if (!st.supported) setSupported(false)` 同样会关面板并停
//     follow。故用 page.route 把 supported 翻成 true——**模拟 SSH 会话的
//     面板态**（local target 本该 false）。被测的是定时器生命周期，与
//     supported 无关；服务端日志仍由真实请求写入，计数不掺假。
//
// 拓扑：local target 即可。
// 用法: node tools/verify-web/diag-files-panel-dispose.cjs [port]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8399);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = path.join(lib.OUT, "fp-dispose-home");
const LOG = path.join(lib.OUT, `server-${PORT}.log`);

const results = [];
function record(name, ok, detail) {
  results.push({name, ok, detail});
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}
function finish() {
  const fails = results.filter((r) => !r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`\n合计 ${results.length - fails}/${results.length} 通过`);
  process.exit(fails ? 1 : 0);
}

function logOffset() {
  return fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
}

function readLog(from) {
  if (!fs.existsSync(LOG)) return "";
  return fs.readFileSync(LOG).slice(from).toString("utf8");
}

/** 统计某 tab 的 /files/state 请求条数（不看状态码：请求本身就该绝迹）。 */
function countState(text, tabId) {
  const re = new RegExp(`/api/tabs/${tabId}/files/state`, "g");
  return (text.match(re) || []).length;
}

function prepareHome() {
  fs.rmSync(HOME, {recursive: true, force: true});
  fs.mkdirSync(HOME, {recursive: true});
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# diag-files-panel-dispose 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'api_key = "sk-test"',
    'model = "claude-sonnet-5"',
    "",
  ].join("\r\n"));
}

(async () => {
  prepareHome();
  const started = await lib.startServer(PORT, {
    env: {OPENTERMINAL_HOME: HOME, USERPROFILE: HOME},
  });
  console.log(`服务端 ${started.base}${started.reused ? "（复用已在跑的）" : ""}`);

  const browser = await lib.launch();
  const {page, errors} = await lib.openTab(browser, started.base);

  // 模拟 SSH 会话的面板态：local target 的 supported=false 会让 open() 直接
  // setSupported(false) 把面板关掉并 _stopFollow()，follow 根本跑不起来。
  // 只翻 supported / defaults.supported 两个标志位，其余透传真实响应。
  await page.route(/\/api\/tabs\/[^/]+\/files\/state/, async (route) => {
    const resp = await route.fetch();
    let body = {};
    try { body = await resp.json(); } catch (e) { /* 非 JSON 就原样放行 */ }
    body.supported = true;
    body.defaults = Object.assign({}, body.defaults || {}, {supported: true});
    await route.fulfill({response: resp, json: body});
  });

  // 建一个真 tab（走真实 UI，不直接打 API）
  await lib.pickTarget(page, "local");
  await page.waitForSelector(".tab .tab-x", {timeout: 20000});
  const tabId = await page.evaluate(() => {
    const b = document.querySelector(".tab");
    return b.id.replace(/^tabbtn-/, "");
  });
  console.log(`建好 tab: ${tabId}`);

  // 同步点：等 probeSupport 的那次 /files/state 落到日志，再等它跑完
  // setSupported(false)（会 _stopFollow）。之后 toggle 才能稳定武装 follow。
  const markProbe = logOffset();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (countState(readLog(markProbe), tabId) > 0) break;
    await sleep(150);
  }
  await sleep(1200);   // 让 setSupported 的收尾落定
  console.log("probeSupport 已落定");

  await page.waitForSelector(`#filesbtn-${tabId}`, {timeout: 20000});
  // 强开文件面板：local target 下入口被藏起来了，但定时器生命周期与
  // supported 无关，这里用真实 toggle() 武装 _startFollow
  await page.evaluate((id) => {
    document.getElementById(`filesbtn-${id}`).click();
  }, tabId);

  // --- A 正向对照：面板展开期间必须是**持续**轮询 -------------------------
  const markA = logOffset();
  await sleep(6500);
  const alive = countState(readLog(markA), tabId);
  record("A 面板展开期间 /files/state 持续轮询（正向对照）", alive >= 2,
    `6.5s 内 ${alive} 次请求（须 ≥2，证明 follow 在跑而非一次性探测；`
    + `否则 B 会假绿）`);

  // --- B 回归：关掉 tab 后必须绝迹 ---------------------------------------
  await page.evaluate((id) => {
    document.getElementById(`tabbtn-${id}`).querySelector(".tab-x").click();
  }, tabId);
  await sleep(250);   // 让 close() 跑完
  const markB = logOffset();
  await sleep(6500);
  const afterText = readLog(markB);
  const leaked = countState(afterText, tabId);
  const notFound = (afterText.match(/\/files\/state[^"]*" 404/g) || []).length;
  record("B 关掉 tab 后不再轮询死 tabId", leaked === 0,
    `关 tab 后 6.5s 内 ${leaked} 次请求（须为 0）；其中 404 有 ${notFound} 条`);

  record("B2 页面无 JS 报错", errors.length === 0,
    errors.length ? errors.join("\n") : "干净");

  await browser.close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
