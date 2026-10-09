// 真机探针：宏式 Enter 收尾几何（补丁已内置，无需手工 bind）。
//   ① 半行输出（printf abc）：补白把陈旧重绘推到空白行，收尾擦行不吃真实输出
//   ② cd 后空闲提示符目录刷新
//   ③ 满屏（seq 1 60）后 cd：已知取舍＝空闲提示符在倒数第二行、底行空白
//   ④ history 号连续、无空条目
// 用法: node tools/verify-web/probe-cleanup-geometry.cjs <port>
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8281);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = lib.OUT;

const probe = page => page.evaluate(() => {
  const g = id => {
    const el = document.querySelector('[id^="' + id + '-"]');
    return el ? (el.innerText || "").trim() : "";
  };
  const vis = id => {
    const el = document.querySelector('[id^="' + id + '-"]');
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  };
  let cur = null;
  try {
    const s = sessions[activeTabId];
    const b = s.term.buffer.active;
    cur = { x: b.cursorX, y: b.baseY + b.cursorY };
  } catch (e) { cur = { err: String(e) }; }
  return { status: g("status"), cs: g("cs"), connVis: vis("conn"),
           overlayVis: vis("connov"), cur };
});

async function clickTerm(page, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await page.locator(".term").click({ timeout: 3000 }); return true; }
    catch (e) {}
    await sleep(300);
  }
  return false;
}

async function send(page, text, tag, shot) {
  await page.keyboard.type(text, { delay: 25 });
  await sleep(350);
  await page.keyboard.press("Enter");
  await sleep(2200);
  const snap = await lib.snapshot(page);
  fs.writeFileSync(path.join(OUT, "clean-" + tag + ".txt"), snap);
  if (shot) await page.screenshot({ path: path.join(OUT, "clean-" + tag + ".png") });
  console.log("--- " + tag + " 尾 8 行 ---");
  console.log(snap.split("\n").slice(-8).map(l => JSON.stringify(l)).join("\n"));
  return snap;
}

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用!)");
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);
  try {
    const picked = await lib.pickTarget(page, "腾讯云主机");
    console.log("点选保存连接:", picked);
    await sleep(3000);
    let ready = null;
    for (let i = 0; i < 40; i++) {
      const p = await probe(page);
      if (p.connVis === "hidden" && p.overlayVis === "hidden" && p.status) { ready = p; break; }
      await sleep(500);
    }
    console.log("就绪:", ready ? ready.status : "未就绪");
    // 等连接后命令集跑完再打字：往 ssh 密码窗里敲命令会搅乱注入链（上一轮
    // 8281 的 syntax error 即由此而来，与本次改动无关——8277 正确时序零错误）
    let idle = false;
    for (let i = 0; i < 120; i++) {
      const snap = await lib.snapshot(page);
      const lines = snap.split("\n").filter(l => l.trim());
      const last = lines[lines.length - 1] || "";
      if (snap.includes("cd /tmp") && /\]# *$/.test(last)) { idle = true; break; }
      await sleep(500);
    }
    console.log("命令集空闲:", idle);
    await clickTerm(page);
    await sleep(500);

    // ① 半行输出 + 紧跟一条命令：abc 不得被擦、提示符独立成行
    await send(page, "printf abc", "partial", false);
    await send(page, "echo AFTERABC", "partial2", true);
    const s2 = fs.readFileSync(path.join(OUT, "clean-partial2.txt"), "utf8");
    const rows = s2.split("\n");
    const abcRow = rows.findIndex(l => l.includes("abc"));
    console.log("abc 行存在:", abcRow >= 0, JSON.stringify(rows[abcRow] || null));
    console.log("abc 行后两行:", JSON.stringify(rows.slice(abcRow + 1, abcRow + 3)));

    // ② cd 后空闲提示符
    await send(page, "cd /etc", "cdetc", false);
    const s3 = fs.readFileSync(path.join(OUT, "clean-cdetc.txt"), "utf8");
    console.log("空闲提示符含 /etc]:", /\[root@[^\]]* \/etc\]#/.test(s3.split("\n").slice(-3).join("\n")));

    // ③ 满屏后 cd：观察底行取舍
    await send(page, "seq 1 60", "full", false);
    await send(page, "cd /", "fullcd", true);
    const p3 = await probe(page);
    console.log("满屏后光标:", JSON.stringify(p3.cur));

    // ④ history 连续性
    await send(page, "history | tail -8", "hist", false);

    console.log("页面错误:", errors.length ? errors : "无");
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
