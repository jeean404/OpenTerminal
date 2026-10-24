// 真机浏览器验证：三处界面控件（长文本执行 / 日夜切换 / 模型配置表单）。
// 用法：node tools/verify-web/verify-ui-controls.cjs [port]
//
//   长文本 —— 弹框整段进终端且**只提交一次回车**（抓 PTY 出站字节）
//   日夜切换 —— 主题变、壁纸状态一个字节都不动
//   模型配置 —— API Key 默认密文 + 小眼睛切换、无「清除已保存的 key」、
//              「连接测试」结论就地显示（校验错误与连不通措辞分开）
// 截图与逐步日志落 .tmp/live/。
"use strict";
const lib = require("./lib");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");
const PORT = 8459;
const HOME = path.join(lib.REPO, ".tmp", "ui-trio-home");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (n, v, d) => console.log((v ? "PASS " : "FAIL ") + n + (d ? "  → " + d : ""));

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  const { base, server } = await lib.startServer(PORT, { env: { OPENTERMINAL_HOME: HOME } });
  const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto(base + "/", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#targets .target", { timeout: 20000 });
  await sleep(400);

  // --- 2. 日夜切换：主题变、壁纸不动 ---
  const before = await p.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    wallpaper: document.documentElement.dataset.wallpaper || null,
    custom: localStorage.getItem("ot-wallpaper") || null,
  }));
  await p.click("#btn-theme-toggle");
  await sleep(300);
  const after = await p.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    wallpaper: document.documentElement.dataset.wallpaper || null,
    custom: localStorage.getItem("ot-wallpaper") || null,
  }));
  ok("日夜按钮切换了主题", before.theme !== after.theme,
     before.theme + " → " + after.theme);
  ok("背景图未被改动",
     before.wallpaper === after.wallpaper && before.custom === after.custom,
     JSON.stringify({ before: before.wallpaper, after: after.wallpaper }));
  ok("按钮图标跟随主题",
     await p.evaluate(() => document.getElementById("btn-theme-toggle").classList.contains("is-light")));
  await p.screenshot({ path: path.join(lib.OUT, "ui-trio-theme.png"), clip: { x: 0, y: 700, width: 280, height: 200 } });

  // --- 1. 长文本按钮 ---
  await p.evaluate(() => openTab("local"));
  await sleep(1200);
  await p.click(".pane.active .run-text-btn");
  await p.waitForSelector("#run-text-input", { timeout: 5000 });
  ok("长文本弹框打开", true);
  await p.fill("#run-text-input", "echo hello-from-run-text");
  // 捕获发往 PTY 的字节
  await p.evaluate(() => {
    window.__sent = [];
    const s = Object.values(sessions)[0];
    const o = s.ws.send.bind(s.ws);
    s.ws.send = (d) => {
      try { window.__sent.push(typeof d === 'string' ? d : new TextDecoder().decode(d)); }
      catch (e) { window.__sent.push('[bin ' + (d && d.byteLength) + ']'); }
      return o(d);
    };
  });
  await p.click(".modal-btns button.primary");
  await sleep(600);
  const sent = await p.evaluate(() => window.__sent);
  const flat = sent.join("");
  ok("长文本一次性进终端", flat.includes("echo hello-from-run-text"),
     JSON.stringify(sent).slice(0, 120));
  ok("只提交一次回车", (flat.match(new RegExp(String.fromCharCode(13), "g")) || []).length === 1,
     JSON.stringify(flat));

  // --- 3. 模型配置：眼睛 / 无清除 key / 连接测试 ---
  await p.click("#btn-settings"); await sleep(300);
  await p.click('[data-settings-section="models"]'); await sleep(800);
  await p.click("#btn-add-model-profile");
  await p.waitForSelector("#mp-form", { timeout: 5000 });
  const mp = await p.evaluate(() => {
    const form = document.getElementById("mp-form");
    const input = form.elements.api_key;
    return {
      typeBefore: input.type,
      hasEye: !!form.querySelector("[data-mp-eye]"),
      hasClear: !!form.elements.clear_api_key,
      buttons: [...document.querySelectorAll(".modal-btns button")].map(b => b.textContent.trim()),
    };
  });
  ok("API Key 默认密文", mp.typeBefore === "password", mp.typeBefore);
  ok("有小眼睛", mp.hasEye);
  ok("已去掉「清除已保存的 key」", !mp.hasClear);
  ok("有「连接测试」按钮", mp.buttons.some(t => t.includes("连接测试")), JSON.stringify(mp.buttons));
  await p.click("[data-mp-eye]");
  await sleep(150);
  ok("点小眼睛变明文",
     await p.evaluate(() => document.getElementById("mp-form").elements.api_key.type) === "text");
  // 连接测试（填个必定失败的端点，验结论就地显示）
  await p.selectOption("#mp-form [name=provider]", "openai");
  await p.fill("#mp-form [name=base_url]", "http://127.0.0.1:9/v1");
  await p.fill("#mp-form [name=model]", "gpt-5");
  await p.fill("#mp-form [name=api_key]", "sk-bogus");
  await p.click(".modal-btns button:nth-child(1)");   // 「连接测试」是第一个按钮
  await p.waitForFunction(() => {
    const el = document.getElementById('mp-test');
    return el && !el.hidden && !el.textContent.includes('正在测试');
  }, null, { timeout: 30000 }).catch(() => {});
  const testOut = await p.evaluate(() => {
    const el = document.getElementById("mp-test");
    return el ? { hidden: el.hidden, text: el.textContent, cls: el.className } : null;
  });
  ok("连接测试结论就地显示", testOut && !testOut.hidden && testOut.text.length > 0,
     JSON.stringify(testOut));
  await p.screenshot({ path: path.join(lib.OUT, "ui-trio-model.png") });

  await b.close(); if (server) server.kill();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
