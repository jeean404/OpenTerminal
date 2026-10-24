// 真机校验：状态栏不透明 + 任务进行中底边流动光带。
// 用法：node tools/verify-web/verify-statusbar-flow.cjs
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "statusbar-flow-home");
const PORT = 8268;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pythonExe() {
  for (const c of [
    path.join(REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "[model]", 'provider = "anthropic"', 'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"', 'api_key_env = "ANTHROPIC_API_KEY"', "",
    "[policy]", 'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat", "uname", "df"]', "",
    "[web]", 'host = "127.0.0.1"', `port = ${PORT}`, "",
  ].join("\n"), "utf8");
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if ((await fetch(base + "/")).ok) throw new Error("端口 " + PORT + " 残留服务端，换端口");
  } catch (e) {
    if (String(e.message).includes("残留")) throw e;
  }
  const logFd = fs.openSync(path.join(OUT, `server-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    [path.join(__dirname, "serve_scripted_model.py"),
     "--port", String(PORT), "--no-open"],
    { cwd: REPO, stdio: ["ignore", logFd, logFd],
      env: { ...process.env, OPENTERMINAL_HOME: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "bar-key",
        OT_WEB_DEBUG: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8" } });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try { if ((await fetch(base + "/")).ok) break; } catch (e) {}
    await sleep(400);
  }
  return { base, server };
}

// 底色 alpha 与「整条栏流动渐变」的实测状态
const PROBE = () => {
  const bar = document.querySelector(".statusbar");
  if (!bar) return null;
  const cs = getComputedStyle(bar);
  // color-mix 的混色结果 Chrome 报成 color(srgb r g b)——没有 alpha 通道
  // 就是不透明，别按 rgba 去抠第 4 段（抠不到会被误判成半透明）
  const alpha = (() => {
    const raw = cs.backgroundColor || "";
    const m = /rgba?\(([^)]+)\)/.exec(raw);
    if (!m) return raw.indexOf("color(") === 0 ? 1 : null;
    const parts = m[1].split(",").map(x => x.trim());
    return parts.length >= 4 ? Number(parts[3]) : 1;
  })();
  return {
    taskOn: bar.classList.contains("task-on"),
    bg: cs.backgroundColor,
    bgAlpha: alpha,
    flowAnim: cs.animationName,
    flowDur: cs.animationDuration,
    // 流动层是第二层背景：image 里应同时有渐变与纯色
    bgLayers: (cs.backgroundImage || "").split(",").length,
    bgSize: cs.backgroundSize,
  };
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  OK   " : "  FAIL ") + name + (detail ? "  -- " + detail : ""));
}

async function main() {
  prepareHome();
  const started = await startServer();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  try {
    await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    await page.locator('#targets .target[data-name="local"]').first().click();
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const ok = await page.evaluate(() => {
        const el = document.querySelector('[id^="model-"]');
        return !!(el && !el.hidden);
      }).catch(() => false);
      if (ok) break;
      await sleep(500);
    }
    await sleep(1500);
    // 等连接徽标撤掉再拍空闲态，别拍到「连接中」
    const tReady = Date.now();
    while (Date.now() - tReady < 15000) {
      const connecting = await page.evaluate(() => {
        const el = document.querySelector(".status-connect");
        return !!(el && !el.hidden);
      });
      if (!connecting) break;
      await sleep(300);
    }

    // ── ① 空闲态：底色不透明、无光带 ────────────────────────────
    const idle = await page.evaluate(PROBE);
    console.log("空闲态:", JSON.stringify(idle));
    check("① 空闲底色不透明", idle && idle.bgAlpha === 1,
      "bg=" + (idle && idle.bg) + " alpha=" + (idle && idle.bgAlpha));
    check("② 空闲时无流动渐变", idle && idle.flowAnim === "none",
      "animation=" + (idle && idle.flowAnim) + " layers=" + (idle && idle.bgLayers));
    await page.locator(".statusbar").first().screenshot(
      { path: path.join(OUT, "statusbar-idle.png") });

    // ── ③ 任务中：底色不透明 + 光带在跑 ─────────────────────────
    await page.locator(".term").click({ force: true });
    // 用「批准」场景：命令要过审批，任务停在等决策上——task-on 窗口够长够稳。
    // 脚本化模型收得飞快，跑「总结」时 task-on 一闪而过，轮询都未必抓到。
    await page.keyboard.type("批准", { delay: 45 });
    await sleep(300);
    await page.keyboard.press("Enter");
    let busy = null;
    const tb = Date.now();
    while (Date.now() - tb < 30000) {
      busy = await page.evaluate(PROBE);
      if (busy && busy.taskOn) break;
      await sleep(60);
    }
    console.log("任务中:", JSON.stringify(busy));
    check("③ 任务中底色仍不透明", busy && busy.bgAlpha === 1,
      "bg=" + (busy && busy.bg) + " alpha=" + (busy && busy.bgAlpha));
    check("④ 任务中整条栏流动渐变在跑",
      busy && busy.taskOn && busy.flowAnim === "otFlow" && busy.bgLayers >= 2,
      "taskOn=" + (busy && busy.taskOn) + " anim=" + (busy && busy.flowAnim) +
      " layers=" + (busy && busy.bgLayers) + " size=" + (busy && busy.bgSize));
    // 拍摄必须 animations:"allow"：默认会把 CSS 动画冻在初始态，三张全一样。
    // 连拍四张跨一个周期，光块位置不同＝确实在流。
    await page.locator(".statusbar").first().screenshot(
      { path: path.join(OUT, "statusbar-task.png"), animations: "allow" });
    for (const n of ["b", "c", "d"]) {
      await sleep(450);
      await page.locator(".statusbar").first().screenshot(
        { path: path.join(OUT, "statusbar-task-" + n + ".png"), animations: "allow" });
    }

    // ── ⑤ 任务收束后光带停 ────────────────────────────────────
    // 「输出完毕」的真代码路径是 _taskTeardown（final/task_end/task_fail 都汇到
    // 这里）：它调 _refreshThink 摘掉 task-on，光带随之消失。不等任务自己收尾——
    // 脚本化模型偶尔会停在思考态不收束，等它就是等一个不会来的信号。
    const done = await page.evaluate(() => {
      const s = sessions[activeTabId];
      if (s && s._taskTeardown) s._taskTeardown();
      const bar = document.querySelector(".statusbar");
      const cs = getComputedStyle(bar);
      const after = getComputedStyle(bar, "::after");
      return {
        taskOn: bar.classList.contains("task-on"),
        bg: cs.backgroundColor,
        flowAnim: cs.animationName,
      };
    });
    await sleep(300);
    console.log("收束后:", JSON.stringify(done));
    check("⑤ 收束后光带停止", done && !done.taskOn && done.flowAnim === "none",
      "taskOn=" + (done && done.taskOn) + " anim=" + (done && done.flowAnim));
    await page.locator(".statusbar").first().screenshot(
      { path: path.join(OUT, "statusbar-after.png") });

    // 浅色主题：光块必须改成「加深」才看得见（浅底提亮只是发白）
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
      const s = sessions[activeTabId];
      if (s && s._onTaskStart) s._onTaskStart();
    });
    await sleep(400);
    const light = await page.evaluate(PROBE);
    console.log("浅色主题:", JSON.stringify(light));
    check("7 浅色主题底色仍不透明、光块在跑",
      light && light.bgAlpha === 1 && light.flowAnim === "otFlow",
      "bg=" + (light && light.bg) + " anim=" + (light && light.flowAnim));
    await page.locator(".statusbar").first().screenshot(
      { path: path.join(OUT, "statusbar-task-light.png"), animations: "allow" });

    console.log("");
    console.log("JS 报错:", errors.length, errors.slice(0, 3));
    const bad = results.filter(r => !r.ok);
    console.log(bad.length ? ("失败 " + bad.length + " 条：") : "全部通过");
    for (const r of bad) console.log("  FAIL", r.name, r.detail || "");
  } catch (e) {
    console.log("异常:", String(e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {});
    started.server.kill();
    process.exit(0);
  }
}
main();
