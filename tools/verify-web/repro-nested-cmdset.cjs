// 真机复现：保存连接「腾讯云主机」的连接后命令集
//   ssh xiaojian@101.33.233.232 / sudo su - / cd /tmp
// 用户预期：① sudo su - 回显也青色；② cd /tmp 上屏执行；③ 光标停在提示符。
// 采集：屏幕时间线 / 命令集状态 / 光标位置 / 命令行 DOM 颜色 / 存活探针。
// 用法: node tools/verify-web/repro-nested-cmdset.cjs [port]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8241);
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
    cur = { x: b.cursorX, y: b.baseY + b.cursorY, type: b.type };
  } catch (e) { cur = { err: String(e) }; }
  return { status: g("status"), cs: g("cs"), connVis: vis("conn"),
           overlayVis: vis("connov"), cur };
});

// 命令行颜色：找含 needle 的行，取该行所有带前景色的 span 颜色
const rowColors = (page, needle) => page.evaluate(n => {
  const rows = document.querySelectorAll(".xterm-rows > div");  // xterm v5 无 .xterm-row 类
  for (const r of rows) {
    if ((r.textContent || "").includes(n)) {
      const cols = [];
      r.querySelectorAll("span").forEach(sp => {
        const c = sp.style ? sp.style.color : "";
        if (c && (sp.textContent || "").trim())
          cols.push(JSON.stringify(sp.textContent) + "=" + c);
      });
      return { line: r.textContent, cols };
    }
  }
  return { line: null, cols: [] };
}, needle);

async function clickTerm(page, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await page.locator(".term").click({ timeout: 3000 }); return true; }
    catch (e) {}
    await sleep(300);
  }
  return false;
}

function startSampler(page) {
  const timeline = [];
  let prev = null, stop = false;
  const t0 = Date.now();
  (async () => {
    while (!stop) {
      let txt = "", p = null;
      try { [txt, p] = await Promise.all([lib.snapshot(page), probe(page)]); }
      catch (e) { await sleep(150); continue; }
      const sig = txt + "|" + p.cs + "|" + JSON.stringify(p.cur);
      if (sig !== prev) {
        timeline.push({ t: Date.now() - t0, text: txt, cs: p.cs, cur: p.cur });
        prev = sig;
      }
      await sleep(150);
    }
  })();
  return { timeline, stop() { stop = true; return timeline; },
           firstAt(n) { for (const ev of timeline) if (ev.text.includes(n)) return ev.t; return null; } };
}

async function main() {
  const started = await lib.startServer(PORT, { env: { OT_WEB_DEBUG: "1" } });
  console.log("服务端:", started.base, started.server ? "(新起)" : "(复用!)");
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);
  const sampler = startSampler(page);
  try {
    const picked = await lib.pickTarget(page, "腾讯云主机");
    console.log("点选保存连接 腾讯云主机:", picked);
    // 等连接就绪 + 命令集自己跑；总预算 75s
    await sleep(3000);
    let ready = null;
    for (let i = 0; i < 40; i++) {
      const p = await probe(page);
      if (p.connVis === "hidden" && p.overlayVis === "hidden" && p.status) { ready = p; break; }
      await sleep(500);
    }
    console.log("就绪:", ready ? ready.status : "未就绪");
    // 等命令集收尾（done / 屏幕稳定）
    let doneAt = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const p = await probe(page);
      if (/完成|done/.test(p.cs)) { doneAt = Date.now() - t0; break; }
      await sleep(500);
    }
    await sleep(3000);
    const tl = sampler.stop();
    const final = await lib.snapshot(page);
    const pFin = await probe(page);
    fs.writeFileSync(path.join(OUT, "nested-final.txt"), final);
    fs.writeFileSync(path.join(OUT, "nested-timeline.json"), JSON.stringify(tl, null, 1));
    await page.screenshot({ path: path.join(OUT, "nested-final.png") });

    console.log("\n########## 里程碑（时间线 ms） ##########");
    for (const n of ["'s password:", "Last login", "sudo su -", "pts/",
                     "root@VM-0-11-centos", "cd /tmp", "ZZPROBE"]) {
      console.log("  " + n + " -> " + sampler.firstAt(n));
    }
    console.log("\n########## 命令集状态 ##########");
    console.log("  done at:", doneAt, " final cs:", JSON.stringify(pFin.cs));
    console.log("  final status:", JSON.stringify(pFin.status));
    console.log("  cursor:", JSON.stringify(pFin.cur));
    console.log("\n########## 屏幕尾 12 行 ##########");
    console.log(final.split("\n").filter(l => l.trim()).slice(-12).join("\n"));
    console.log("\n########## 颜色 DOM ##########");
    console.log("  ssh 行:", JSON.stringify(await rowColors(page, "ssh xiaojian@")));
    console.log("  sudo 行:", JSON.stringify(await rowColors(page, "sudo su -")));
    console.log("  cd 行:", JSON.stringify(await rowColors(page, "cd /tmp")));

    console.log("\n########## 存活探针 ##########");
    await clickTerm(page);
    await page.keyboard.type("echo ZZPROBE", { delay: 30 });
    await sleep(400);
    const during = await lib.snapshot(page);
    await page.keyboard.press("Enter");
    await sleep(2000);
    const after = await lib.snapshot(page);
    const pAfter = await probe(page);
    fs.writeFileSync(path.join(OUT, "nested-after-probe.txt"), after);
    await page.screenshot({ path: path.join(OUT, "nested-after-probe.png") });
    console.log("  键入回显 ZZPROBE:", during.includes("ZZPROBE"));
    console.log("  回车后输出 ZZPROBE 次数:", (after.match(/ZZPROBE/g) || []).length);
    console.log("  探针后光标:", JSON.stringify(pAfter.cur));
    console.log("  探针后屏幕尾 6 行:");
    console.log(after.split("\n").filter(l => l.trim()).slice(-6).join("\n"));

    console.log("########## pwd 探针（提示符 ~ vs /tmp） ##########");
    await page.keyboard.type("pwd", { delay: 30 });
    await page.keyboard.press("Enter");
    await sleep(2000);
    const afterPwd = await lib.snapshot(page);
    fs.writeFileSync(path.join(OUT, "nested-after-pwd.txt"), afterPwd);
    await page.screenshot({ path: path.join(OUT, "nested-after-pwd.png") });
    console.log(afterPwd.split("\n").filter(l => l.trim()).slice(-6).join("\n"));
    console.log("########## cd / 探针（空闲提示符目录是否刷新） ##########");
    await page.keyboard.type("cd /", { delay: 30 });
    await page.keyboard.press("Enter");
    await sleep(2000);
    const afterCd = await lib.snapshot(page);
    fs.writeFileSync(path.join(OUT, "nested-after-cdroot.txt"), afterCd);
    await page.screenshot({ path: path.join(OUT, "nested-after-cdroot.png") });
    console.log(afterCd.split("\n").filter(l => l.trim()).slice(-6).join("\n"));

    console.log("########## 行完整性（历史被吃行数） ##########");
    const cnt = (hay, n) => hay.split(n).length - 1;
    for (const n of ["Last login", "on pts/", "cd /tmp", "ZZPROBE", "sudo su -", "/tmp]#"]) {
      console.log("  " + JSON.stringify(n) + " x" + cnt(afterCd, n));
    }

    console.log("\n页面错误:", errors.length ? errors.slice(0, 6) : "无");
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
