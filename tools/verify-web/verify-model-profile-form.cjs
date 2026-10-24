// 真机浏览器验证：模型配置弹框两处交互缺陷。
// 用法：node tools/verify-web/verify-model-profile-form.cjs [port]
//
//   ① 按住 API Key 小眼睛 —— 眼睛不得下移、modal-body 不得被撑出滚动条
//     （根因：全局 button:active 的 transform: scale(.97) 盖掉了 translateY(-50%)，
//       绝对定位溢出又落在 overflow-y:auto 的 .modal-body 里）
//   ② 「连接测试」成功 —— 只显示「连接成功」，不再糊出模型应答原文的 JSON
// 截图与逐步日志落 .tmp/live/。
"use strict";
const lib = require("./lib");
const path = require("node:path");
const fs = require("node:fs");
const PORT = 8477;
const HOME = path.join(lib.REPO, ".tmp", "mp-form-home");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const ok = (n, v, d) => {
  if (!v) failed += 1;
  console.log((v ? "PASS " : "FAIL ") + n + (d ? "  -> " + d : ""));
};

// 眼睛中心 vs 输入框中心的偏差，以及 modal-body 的可滚动溢出量
async function measure(page) {
  return page.evaluate(() => {
    const eye = document.querySelector(".mp-eye");
    const input = document.querySelector(".mp-secret input");
    const body = document.querySelector(".modal-body");
    const e = eye.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    return {
      eyeCenter: e.top + e.height / 2,
      inputCenter: i.top + i.height / 2,
      overflow: body.scrollHeight - body.clientHeight,
      transform: getComputedStyle(eye).transform,
    };
  });
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  const { base, server } = await lib.startServer(PORT, { env: { OPENTERMINAL_HOME: HOME } });
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, base);

  await page.click("#btn-settings");
  await sleep(250);
  await page.click('[data-settings-section="models"]');
  await sleep(250);
  await page.click("#btn-add-model-profile");
  await page.waitForSelector("#mp-form", { timeout: 10000 });

  await page.fill('#mp-form [name="name"]', "verify-mp");
  await page.fill('#mp-form [name="base_url"]', "https://api.example.com/v1");
  await page.fill('#mp-form [name="model"]', "gpt-5");
  await page.fill('#mp-form [name="api_key"]', "sk-verify-1234");
  await sleep(200);

  // --- ① 按住小眼睛 ---
  const rest = await measure(page);
  await page.locator(".mp-eye").hover();
  await page.mouse.down();          // 按住不松，复现 :active
  await sleep(150);
  const held = await measure(page);
  await page.mouse.up();
  await sleep(150);
  const after = await measure(page);

  console.log("rest:", JSON.stringify(rest));
  console.log("held:", JSON.stringify(held));
  ok("静止时眼睛与输入框垂直居中", Math.abs(rest.eyeCenter - rest.inputCenter) < 1.5,
     "偏差 " + (rest.eyeCenter - rest.inputCenter).toFixed(2) + "px");
  ok("按住时眼睛不下移", Math.abs(held.eyeCenter - rest.eyeCenter) < 1,
     "位移 " + (held.eyeCenter - rest.eyeCenter).toFixed(2) + "px");
  ok("按住时仍与输入框居中", Math.abs(held.eyeCenter - held.inputCenter) < 1.5,
     "偏差 " + (held.eyeCenter - held.inputCenter).toFixed(2) + "px");
  // matrix(a,b,c,d,e,f) 的 f 就是 translateY：全局 :active 把 transform 整条盖成
  // scale(.97) 时 f 会归零，这正是眼睛下沉的那一步
  const m = /^matrix\(([^)]+)\)$/.exec(held.transform || "");
  const ty = m ? Number(m[1].split(",")[5]) : 0;
  ok("按住时 transform 仍带 translateY", ty !== 0,
     "ty=" + ty + " (" + held.transform + ")");
  ok("按住不撑出滚动条", held.overflow <= rest.overflow,
     "溢出 " + rest.overflow + " -> " + held.overflow);
  ok("松开后复位", Math.abs(after.eyeCenter - rest.eyeCenter) < 1);

  await page.screenshot({ path: path.join(lib.OUT, "mp-eye-held.png") });

  // --- ② 连接测试成功只报结论 ---
  const dump = "[{'type': 'text', 'text': 'pong\n\nI am here and ready to help." +
               " What is on your mind?', 'signature': '', 'thinking': ...}]";
  await page.route("**/api/model-profiles/test", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: true, detail: dump.slice(0, 200) }),
  }));
  await page.getByRole("button", { name: "连接测试" }).click();
  await page.waitForFunction(() => {
    const el = document.getElementById("mp-test");
    return el && !el.hidden && el.textContent && el.textContent !== "正在测试连接…";
  }, null, { timeout: 10000 });
  const successText = (await page.textContent("#mp-test")).trim();
  ok("成功只显示「连接成功」", successText === "连接成功", JSON.stringify(successText));
  ok("成功不糊出 JSON 原文",
     successText.indexOf("{") === -1 && successText.indexOf("[") === -1
       && successText.indexOf("type") === -1, JSON.stringify(successText));
  await page.screenshot({ path: path.join(lib.OUT, "mp-test-success.png") });

  // 失败仍要带原因，别把排查信息一起砍了
  await page.route("**/api/model-profiles/test", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ ok: false, detail: "401 Unauthorized: invalid api key" }),
  }));
  await page.getByRole("button", { name: "连接测试" }).click();
  await page.waitForFunction(() => {
    const el = document.getElementById("mp-test");
    return el && /401/.test(el.textContent || "");
  }, null, { timeout: 10000 });
  const failText = (await page.textContent("#mp-test")).trim();
  ok("失败仍带原因", failText.indexOf("401") !== -1 && failText.indexOf("连接失败") === 0,
     JSON.stringify(failText));
  await page.screenshot({ path: path.join(lib.OUT, "mp-test-fail.png") });

  ok("无页面报错", errors.length === 0, errors.join(" | "));
  console.log(failed ? ("FAILED " + failed) : "ALL PASS");
  await browser.close();
  if (server) server.kill();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
