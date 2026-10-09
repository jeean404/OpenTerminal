// 取证：Windows UA 下按 Ctrl+V 后 onData 轨迹里有无 \x16（旧行为会发）；
// 再用合成 ClipboardEvent('paste') 验证 xterm paste 监听路径可达。
// 用法: node tools/verify-web/diag-ctrlv-trace.cjs [port]
"use strict";
const lib = require("./lib");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const PORT = Number(process.argv[2] || 8299);

async function clickTerm(page) {
  for (let i = 0; i < 6; i++) {
    try { await page.locator(".term").click({ timeout: 3000, force: true });
          await sleep(120); return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  const browser = await lib.launch();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  const onData = [];
  page.on("console", m => {
    if (m.text().includes("[ot onData]")) onData.push(m.text());
  });
  await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("otdbg", "1"));
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  await page.locator("#targets .target", { hasText: "local" }).first().click();
  for (let i = 0; i < 60; i++) {
    const hid = await page.evaluate(() => {
      const c = document.querySelector('[id^="conn-"]');
      return c ? c.hidden : false;
    });
    if (hid) break;
    await sleep(400);
  }
  await sleep(1200);
  if (!(await clickTerm(page))) throw new Error("点不到终端");

  onData.length = 0;
  await page.keyboard.press("Control+v");
  await sleep(400);
  say("Ctrl+V 后 onData:", onData.length ? onData.map(encodeTrace).join(" ; ") : "(无任何 onData——未发 \\x16 ✓)");
  const ae = await page.evaluate(() => {
    const a = document.activeElement;
    return a && a.closest && a.closest(".xterm") ? "xterm" : (a ? a.tagName : "none");
  });
  say("焦点:", ae);

  // 合成 paste 事件：验证 xterm 的 paste 监听路径本身可达（返回 false 放行后
  // 真机浏览器默认动作产生的就是这个事件）
  await page.evaluate(() => {
    const ta = document.querySelector(".xterm-helper-textarea");
    const dt = new DataTransfer();
    dt.setData("text/plain", "echo SYNTH_PASTE_OK");
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await sleep(400);
  const snap = await lib.snapshot(page);
  say(snap.includes("SYNTH_PASTE_OK") ? "PASS 合成 paste → xterm 粘贴上屏" :
    "FAIL 合成 paste 未上屏");

  // Ctrl+V 后接一个普通字符：旧行为（\x16 quoted-insert）会把下一字符按字面
  // 引入（看不见/乱码），新行为则正常上屏
  onData.length = 0;
  await page.keyboard.press("Control+v");
  await page.keyboard.type("Z", { delay: 30 });
  await sleep(300);
  const snap2 = await lib.snapshot(page);
  say(snap2.includes("Z") ? "PASS Ctrl+V 不再吞后续字符" : "FAIL 后续字符被 quoted-insert 吞掉");
  await page.keyboard.press("Control+c");
  await sleep(200);
  await browser.close();
  if (started.server) { try { started.server.kill(); } catch (e) {} }
}

function encodeTrace(s) {
  // console 文本里 \u0016 可能已被 JSON.stringify 成 "\\u0016"
  return s.includes("\\u0016") || s.includes("\x16") ? s + "  <<< 含 \\x16！" : s;
}

main().catch(e => { console.error("ABORT:", e); process.exit(2); });
