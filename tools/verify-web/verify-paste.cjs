// 真机回归：Windows Ctrl+C/Ctrl+V 复制粘贴 + 右键粘贴焦点保持 + 旧功能不回退。
// 用 Windows UA 起 context 激活 app.js 的 IS_APPLE=false 分支；CDP 授权剪贴板。
// 注：无头/有头 Chromium 对 CDP 注入的 Ctrl+V 都不合成浏览器默认 paste 动作
// （对照实验：纯 textarea 同样不触发），故 Ctrl+V 断言拆为三层可测行为：
//   ① keydown 不再发 \x16 进 PTY（onData 轨迹）
//   ② paste 事件到达 xterm textarea 即粘贴上屏（合成 ClipboardEvent）
//   ③ 焦点丢失时按键会把终端拉回焦点（焦点抢救）
// 真实硬件键盘的默认 paste 动作由真机回归确认。
// 用法: node tools/verify-web/verify-paste.cjs [port]
"use strict";
const lib = require("./lib");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const PORT = Number(process.argv[2] || 8298);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  say(ok ? "PASS" : "FAIL", name, detail ? `(${detail})` : "");
}

async function clickTerm(page) {
  for (let i = 0; i < 6; i++) {
    try { await page.locator(".term").click({ timeout: 3000, force: true });
          await sleep(120); return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function snap(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    return Array.from(rows).map(r => r.textContent || "").join("\n");
  });
}

function lastRow(s) {
  const rows = s.split("\n").filter(r => r.trim().length);
  return rows.length ? rows[rows.length - 1] : "";
}

// 三击选中最后一个非空行（xterm 原生三击整行选中；拖选在注入事件下不稳定）
async function selectLastLine(page) {
  const r = await page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    for (let i = rows.length - 1; i >= 0; i--) {
      if ((rows[i].textContent || "").trim()) {
        const rect = rows[i].getBoundingClientRect();
        return { x: rect.x + Math.min(rect.width / 2, 420), y: rect.y + rect.height / 2 };
      }
    }
    return null;
  });
  if (!r) throw new Error("找不到可选中行");
  await page.mouse.click(r.x, r.y, { clickCount: 3 });
  await sleep(200);
}

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  say("服务端:", started.base, started.server ? "(新起)" : "(复用!)");
  const browser = await lib.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  const onData = [];
  page.on("console", m => {
    if (m.text().includes("[ot onData]")) onData.push(m.text());
  });
  await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("otdbg", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  await page.locator("#targets .target", { hasText: "local" }).first().click();
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => {
      const c = document.querySelector('[id^="conn-"]');
      return c ? c.hidden : false;
    })) break;
    await sleep(400);
  }
  await sleep(1200);
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  say("local tab 就绪");

  // ---- S1: Windows 裸 Ctrl+V——不再发 \x16，paste 事件路径可达 ----
  onData.length = 0;
  await page.keyboard.press("Control+v");
  await sleep(300);
  const hasX16 = onData.some(t => t.includes("\\u0016") || t.includes("\x16"));
  check("S1 Ctrl+V 不再译成 \\x16 发进 PTY", !hasX16,
    onData.length ? onData.join(";") : "(无 onData)");
  await page.evaluate(() => {
    const ta = document.querySelector(".xterm-helper-textarea");
    const dt = new DataTransfer();
    dt.setData("text/plain", "echo OT_PASTE_OK_1");
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await sleep(300);
  const s1 = await snap(page);
  check("S1 paste 事件到达 xterm 即粘贴上屏", s1.includes("echo OT_PASTE_OK_1"));
  await page.keyboard.press("Enter");
  await sleep(600);
  check("S1 粘贴命令可执行", (await snap(page)).split("OT_PASTE_OK_1").length >= 3);

  // ---- S2: Ctrl+V 焦点抢救（焦点落 body 时拉回终端）----
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
  await page.keyboard.press("Control+v");
  await sleep(200);
  const ae2 = await page.evaluate(() => {
    const a = document.activeElement;
    return a && a.closest && a.closest(".xterm") ? "xterm" : (a ? a.tagName : "none");
  });
  check("S2 焦点丢失时 Ctrl+V 拉回终端焦点", ae2 === "xterm", `焦点=${ae2}`);
  await page.keyboard.press("Control+c");
  await sleep(200);

  // ---- S3: 右键粘贴 + 焦点保持 ----
  await page.evaluate(() => navigator.clipboard.writeText("echo OT_PASTE_OK_3"));
  await page.locator(".term").click({ button: "right", force: true });
  await page.waitForSelector(".ctxmenu", { timeout: 3000 });
  await page.locator(".ctxmenu button", { hasText: "粘贴" }).click();
  await sleep(400);
  const ae3 = await page.evaluate(() => {
    const a = document.activeElement;
    return a && a.closest && a.closest(".xterm") ? "xterm" : (a ? a.tagName : "none");
  });
  check("S3 粘贴后焦点仍在终端", ae3 === "xterm", `焦点=${ae3}`);
  check("S3 右键粘贴内容上屏", (await snap(page)).includes("echo OT_PASTE_OK_3"));
  await page.keyboard.press("Enter");          // 不点击，直接操作键盘
  await sleep(500);
  await page.keyboard.type("echo FOCUS_OK_3", { delay: 25 });
  await page.keyboard.press("Enter");
  await sleep(600);
  check("S3 粘贴后直接打字可输入", (await snap(page)).includes("FOCUS_OK_3"));

  // ---- S4: 回归——Tab 补全 ----
  await page.keyboard.type("ec", { delay: 40 });
  await page.keyboard.press("Tab");
  await sleep(400);
  const row4 = lastRow(await snap(page));
  check("S4 Tab 补全 ec→echo", /\becho\b/.test(row4), `行="${row4}"`);
  await page.keyboard.press("Control+c");
  await sleep(200);

  // ---- S5: 回归——上箭头翻历史 ----
  await page.keyboard.type("echo HIST_MARK_5", { delay: 25 });
  await page.keyboard.press("Enter");
  await sleep(500);
  await page.keyboard.press("ArrowUp");
  await sleep(300);
  const row5 = lastRow(await snap(page));
  check("S5 上箭头召回历史", row5.includes("echo HIST_MARK_5"), `行="${row5}"`);
  await page.keyboard.press("Control+c");
  await sleep(200);

  // ---- S8a: Ctrl+C 中断（无选区）----
  await page.keyboard.type("sleep 5", { delay: 25 });
  await page.keyboard.press("Enter");
  await sleep(300);
  const t0 = Date.now();
  await page.keyboard.press("Control+c");
  await sleep(600);
  const dt8 = Date.now() - t0;
  check("S8a 无选区 Ctrl+C 照常中断", (await snap(page)).includes("^C") && dt8 < 3000,
    `耗时=${dt8}ms`);

  // ---- S8b: Windows 有选区 Ctrl+C 复制（三击整行选中）----
  await page.keyboard.type("SEL_MARK_8_TEXT", { delay: 25 });
  await sleep(200);
  await selectLastLine(page);
  await page.keyboard.press("Control+c");
  await sleep(300);
  const clip8 = await page.evaluate(() => navigator.clipboard.readText());
  check("S8b 有选区 Ctrl+C 复制到剪贴板", clip8.includes("SEL_MARK_8"),
    `剪贴板="${clip8.slice(0, 50)}"`);
  check("S8b 复制不误发中断（命令行未被 ^C 打断）",
    (await snap(page)).includes("SEL_MARK_8_TEXT"));
  await page.keyboard.press("Control+c");   // 清行（点按已清选区，此处发 ^C）
  await sleep(200);

  // ---- S9: 右键复制 + 焦点保持 ----
  await page.keyboard.type("CTX_COPY_MARK_9", { delay: 25 });
  await sleep(200);
  await selectLastLine(page);
  await page.locator(".term").click({ button: "right", force: true });
  await page.waitForSelector(".ctxmenu", { timeout: 3000 });
  await page.locator(".ctxmenu button", { hasText: "复制" }).click();
  await sleep(300);
  const clip9 = await page.evaluate(() => navigator.clipboard.readText());
  const ae9 = await page.evaluate(() => {
    const a = document.activeElement;
    return a && a.closest && a.closest(".xterm") ? "xterm" : (a ? a.tagName : "none");
  });
  check("S9 右键复制进剪贴板", clip9.includes("CTX_COPY_MARK_9"),
    `剪贴板="${clip9.slice(0, 50)}"`);
  check("S9 复制后焦点仍在终端", ae9 === "xterm", `焦点=${ae9}`);
  await page.keyboard.press("Control+c");
  await sleep(200);

  // ---- 汇总 ----
  const bad = results.filter(r => !r.ok);
  say(`\n==== ${results.length - bad.length}/${results.length} PASS ====`);
  if (errors.length) say("页面错误:", errors.join(" | "));
  await browser.close();
  if (started.server) { try { started.server.kill(); } catch (e) {} }
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error("ABORT:", e); process.exit(2); });
