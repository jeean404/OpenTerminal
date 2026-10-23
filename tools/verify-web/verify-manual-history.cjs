// 真机验证：用户手动命令是否进**消息历史**、有没有动**系统提示词**。
// 用法：node tools/verify-web/verify-manual-history.cjs [port]
//
// 流程（同一次会话，前后对照）：
//   ① 问一次 AI            → 截获 系统提示词 A / 消息
//   ② 手动敲 echo 标记命令  → 走真 PTY + hook + manual_history
//   ③ 再问一次 AI          → 截获 系统提示词 B / 消息
// 断言：A === B（系统提示词一字未动）、标记只出现在 ③ 的 messages 里，
//       且 ① 的消息里没有（增量注入，不是无脑全塞）。
//
// 一律用 ASCII：page.keyboard.type 打 CJK 走不通 IME 链路（ghost.test.cjs
// 就是为这事写的）。`? ` 前缀是产品约定的「强制走 AI」。
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib");
const { chromium } = require("playwright");

const PORT = Number(process.argv[2] || 8271);
const HOME = path.join(lib.REPO, ".tmp", "manual-hist-home");
const CAPTURE = path.join(lib.OUT, "manual-history-capture.jsonl");
const LOG = path.join(lib.OUT, "manual-history.log");
const MARK = "ot-manual-marker-42";
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

let browser = null;
let server = null;
let page = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (e) { /* ignore */ }
  try { if (server) server.kill(); } catch (e) { /* ignore */ }
}

async function dumpScene(tag) {
  if (!page) return;
  try {
    await page.screenshot({ path: path.join(lib.OUT, `manual-history-${tag}.png`) });
    const info = await page.evaluate(() => {
      let rows = document.querySelectorAll(".xterm-rows .xterm-row");
      const alt = rows.length;
      if (!rows.length) rows = document.querySelectorAll(".xterm-rows > div");
      return {
        rowsDirect: alt, rowsNested: rows.length,
        hasXterm: !!document.querySelector(".xterm"),
        text: Array.from(rows).map(r => r.textContent || "").join("\n"),
        body: (document.body.innerText || "").slice(-800),
      };
    });
    log(`--- ${tag} 终端 --- xterm=${info.hasXterm} 行=${info.rowsNested}/${info.rowsDirect}`);
    log((info.text || "(xterm 行为空)").split("\n").slice(-30).join("\n"));
    log(`--- ${tag} body 尾部 ---`);
    log(info.body);
  } catch (e) {
    log("现场抓取失败: " + e.message);
  }
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(lib.OUT, { recursive: true });
  fs.writeFileSync(LOG, "", "utf8");
  fs.writeFileSync(CAPTURE, "", "utf8");

  step("起服务端（模型边界截获）");
  const logFd = fs.openSync(path.join(lib.OUT, "manual-history-server.log"), "w");
  const exe = path.join(lib.REPO, ".venv-win", "Scripts", "python.exe");
  server = spawn(exe, ["tools/verify-web/serve_manual_history.py",
    "--port", String(PORT), "--no-open"], {
    cwd: lib.REPO,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, OPENTERMINAL_HOME: HOME, OT_MANUAL_CAPTURE: CAPTURE },
  });
  const base = `http://127.0.0.1:${PORT}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { if ((await fetch(base + "/")).ok) break; } catch (e) { /* retry */ }
    await sleep(400);
  }
  log("服务端: " + base);

  browser = await chromium.launch({
    headless: true, channel: "chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  await lib.pickTarget(page, "local");

  step("等终端就绪");
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll(".xterm-rows > div, .xterm-rows .xterm-row");
    return rows.length > 3;
  }, null, { timeout: 40000 });
  await sleep(2000);
  await page.click(".xterm-screen").catch(() => page.click(".term"));
  await sleep(500);

  const typeAndEnter = async (text) => {
    await page.keyboard.type(text, { delay: 25 });
    await page.keyboard.press("Enter");
  };
  // AI 的收尾文案落在「总结」卡片里（block 层），不在 .xterm-rows——
  // 只查 xterm 行会一直等不到（实测踩过）。查整页文本两种都覆盖。
  const waitTerm = (needle) => page.waitForFunction(n =>
    (document.body.innerText || "").includes(n), needle, { timeout: 60000 });

  step("① 先问一次 AI（拿基线系统提示词）");
  await typeAndEnter("? what is going on");
  await waitTerm("MODEL-REPLY-1");
  await sleep(600);

  step("② 手动敲一条命令");
  await typeAndEnter(`echo ${MARK}`);
  await waitTerm(MARK);
  await sleep(1500);   // 等 exec_end 记账

  step("③ 再问一次 AI");
  await typeAndEnter("? and now");
  await waitTerm("MODEL-REPLY-2");
  await sleep(800);
  await page.screenshot({ path: path.join(lib.OUT, "manual-history.png") });

  step("读截获");
  const rows = fs.readFileSync(CAPTURE, "utf8").trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line));
  log(`截获 ${rows.length} 次模型调用`);
  check("截到两次模型调用", rows.length >= 2, "实际 " + rows.length);
  if (rows.length < 2) throw new Error("截获不足两次，无法前后对照");

  const first = rows[0];
  const second = rows[rows.length - 1];

  check("系统提示词一字未动",
    first.system === second.system,
    `A ${first.system.length} 字 / B ${second.system.length} 字` +
    (first.system === second.system ? "" : "，内容不一致"));

  const inSecond = second.messages.some(m => String(m.content).includes(MARK));
  const inSecondSys = String(second.system).includes(MARK);
  const inFirst = first.messages.some(m => String(m.content).includes(MARK));
  check("手动命令进了消息历史", inSecond === true);
  check("系统提示词里没有手动命令", inSecondSys === false,
    inSecondSys ? "泄漏进系统提示词" : "干净");
  check("没重复注入（① 的消息里不该有）", inFirst === false,
    inFirst ? "提前泄漏" : "增量正确");

  const hit = second.messages.filter(m => String(m.content).includes(MARK)).pop();
  check("命令出现在末条消息", hit === second.messages[second.messages.length - 1],
    hit ? `落在 ${hit.type}` : "没找到");
  const hitText = String(hit && hit.content);
  check("摘要带退出码与输出行数",
    /退出 \d+/.test(hitText) && /输出 \d+ 行/.test(hitText),
    hitText.replace(/\s+/g, " ").slice(0, 160));

  cleanup();
  const failed = results.filter(r => !r.ok);
  log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    log("失败项：");
    failed.forEach(f => log(`  - ${f.name}: ${f.detail}`));
  }
  process.exit(failed.length ? 1 : 0);
})().catch(async e => {
  console.error("验证脚本异常:", (e && e.stack) || e);
  await dumpScene("fail");
  try { fs.appendFileSync(LOG, "异常: " + ((e && e.stack) || e) + "\n", "utf8"); } catch (_) {}
  cleanup();
  process.exit(1);
});
