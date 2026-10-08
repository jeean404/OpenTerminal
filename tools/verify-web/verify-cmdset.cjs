// 真机浏览器验证：连接后命令集时序 bug（2026-10-07 真机反馈）
//   「只显示第 1 条命令的执行记录，后续的命令没显示执行」
//   「含 sudo su - 时界面要按 Enter 键才刷新状态」
//
// 复刻手法：隔离 OPENTERMINAL_HOME（不碰用户真实配置/连接库），config.toml 给
// 本机目标挂上连接后命令；第 1 条解析到 fixtures/ssh.cmd（PATH 前置），它复刻
// 真机 ssh/sudo 读密码的时序——无回显 `Password: ` → 读完先吐「裸 CRLF」→
// 3s auth 窗口（TTY 仍关回显）→ 这才回新 shell 提示符。
//
// 核心断言：裸 CRLF 之后、新 shell 提示符回来之前，下一条命令绝不能被注入
// （旧逻辑把「提示文本消失 + 一小段静默」当跑完，命令就射进无回显窗口）；
// 且每条连接后命令的原文都要上屏（回显或补画），否则用户只看得到第 1 条。
//
// 用法: node tools/verify-web/verify-cmdset.cjs [port]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8231);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FIXTURES = path.join(__dirname, "fixtures");
const HOME = path.join(lib.OUT, "cmdset-home");
const CMDS = ["ssh demo", "echo MARK-SECOND-RAN", "echo MARK-THIRD-RAN"];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}

const probe = page => page.evaluate(() => {
  const g = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.innerText || "").trim() : "";
  };
  const vis = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  };
  const modal = document.querySelector("#modal-root .modal");
  return {
    conn: g("conn"), connVis: vis("conn"), overlayVis: vis("connov"),
    status: g("status"), cs: g("cs"), tokens: g("tokens"),
    modal: modal ? (modal.innerText || "").trim().slice(0, 160) : "",
  };
});

async function clickTerm(page, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.locator(".term").click({ timeout: 3000 });
      return true;
    } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function waitReady(page, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    if (p.connVis === "hidden" && p.overlayVis === "hidden" && p.status) {
      return { ok: true, waited: Date.now() - t0, status: p.status.slice(0, 80) };
    }
    await sleep(300);
  }
  return { ok: false, waited: Date.now() - t0, status: (await probe(page)).status.slice(0, 80) };
}

// 时间线采样：屏幕文本 / 命令集状态 / 弹窗 三者任一变化就记一帧
function startSampler(page) {
  const timeline = [];
  let prev = null, stop = false;
  const t0 = Date.now();
  (async () => {
    while (!stop) {
      const [txt, p] = await Promise.all([lib.snapshot(page), probe(page)]);
      const sig = txt + "|" + p.cs + "|" + p.modal;
      if (sig !== prev) {
        timeline.push({ t: Date.now() - t0, text: txt, cs: p.cs, modal: p.modal });
        prev = sig;
      }
      await sleep(100);
    }
  })();
  return {
    timeline,
    stop() { stop = true; return timeline; },
    firstAt(re) {
      for (const ev of timeline) {
        if (re.test(ev.text)) return { t: ev.t };
      }
      return null;
    },
  };
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const toml = [
    "# verify-cmdset 专用：本机目标挂连接后命令（隔离 home，不碰用户配置）",
    "[target.local]",
    'mode = "local"',
    "commands = [",
    ...CMDS.map(c => `  ${JSON.stringify(c)},`),
    "]",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(HOME, "config.toml"), toml, "utf8");
}

async function main() {
  prepareHome();
  const started = await lib.startServer(PORT, {
    env: {
      OPENTERMINAL_HOME: HOME,
      // fixtures 目录前置：`ssh` 解析到 ssh.cmd（复刻密码时序），不是真 ssh
      PATH: FIXTURES + path.delimiter + process.env.PATH,
    },
  });
  console.log("服务端:", started.base, started.server ? "(新起，隔离 home)" : "(复用!)");
  if (!started.server) {
    record("隔离服务端", false, "端口上已有服务端，隔离 OPENTERMINAL_HOME 未生效");
    return finish();
  }
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);

  try {
    console.log("\n########## 连接后命令集时序（本机 + fake ssh） ##########");
    console.log("    命令集:", JSON.stringify(CMDS));
    await lib.pickTarget(page, "local");
    const ready = await waitReady(page, 60000);
    console.log("    连接就绪:", ready.ok, ready.waited + "ms", JSON.stringify(ready.status));
    record("C0 连接就绪", ready.ok, ready.ok ? ready.status : JSON.stringify(ready));

    const sampler = startSampler(page);
    // 等第 1 条命令的密码提示上屏（命令集暂停等输入）
    let t0 = Date.now(), sawPw = false;
    while (Date.now() - t0 < 30000) {
      const txt = await lib.snapshot(page);
      if (/Password\s*[:：]/i.test(txt)) { sawPw = true; break; }
      await sleep(200);
    }
    await sleep(800);   // 再留窗口：看有没有抢跑
    const atPw = await lib.snapshot(page);
    const stPw = await probe(page);
    fs.writeFileSync(path.join(lib.OUT, "cs-at-password.txt"), atPw);

    record("C1 第 1 条阻塞在密码提示", sawPw,
      sawPw ? ("屏幕含 Password: ；命令集状态=" + JSON.stringify(stPw.cs))
            : ("未等到密码提示，屏幕尾=" + JSON.stringify(atPw.slice(-300))));

    const early = /echo MARK-SECOND-RAN/.test(atPw) || /echo MARK-THIRD-RAN/.test(atPw);
    record("C2 密码提示期无命令抢跑", !early,
      early ? "bug 复现：密码提示期已出现后续命令"
            : "密码提示期屏幕干净（无 MARK-SECOND/MARK-THIRD）");

    // running 帧带命令原文；暂停后状态栏换说「请在终端输入密码」也算说清了
    const namedCmd = sampler.timeline.some(ev => /ssh demo/.test(ev.cs));
    record("C3 状态栏说清在跑哪条", namedCmd && /命令集/.test(stPw.cs),
      "running 帧含 ssh demo=" + namedCmd + "；当前状态=" + JSON.stringify(stPw.cs));

    // ---- 用户在终端手输密码（不回显），回车提交 ----
    await clickTerm(page);
    await page.keyboard.type("s3cret", { delay: 25 });
    await sleep(200);
    await page.keyboard.press("Enter");
    const typedAt = Date.now();

    // auth 窗口（fake-ssh 静默 3s）：裸 CRLF 之后提示文本已消失，但 shell
    // 提示符还没回来——此刻放行下一条就是真机 bug
    let sawPrompt = null;
    while (Date.now() - typedAt < 6000) {
      const txt = await lib.snapshot(page);
      if (/\[demo@fakehost ~\]\$/.test(txt)) { sawPrompt = Date.now() - typedAt; break; }
      await sleep(120);
    }
    // auth 窗口 = 裸 CRLF 之后、新 shell 提示符回来之前。这段里若已出现后续
    // 命令行文本，就是真机 bug（射进无回显窗口）。
    const evShEarly = sampler.firstAt(/\[demo@fakehost ~\]\$/);
    const cut = evShEarly ? evShEarly.t : Infinity;
    const injectedEarly = [];
    for (const ev of sampler.timeline) {
      if (ev.t >= cut) break;
      if (/echo MARK-SECOND-RAN/.test(ev.text)) injectedEarly.push("echo MARK-SECOND-RAN@" + ev.t);
      if (/echo MARK-THIRD-RAN/.test(ev.text)) injectedEarly.push("echo MARK-THIRD-RAN@" + ev.t);
    }
    const duringAuth = await lib.snapshot(page);
    fs.writeFileSync(path.join(lib.OUT, "cs-during-auth.txt"), duringAuth);
    record("C4 auth 窗口内不注入后续命令", injectedEarly.length === 0,
      injectedEarly.length
        ? ("bug 复现：无回显窗口里被注入 " + injectedEarly.join(", "))
        : ("新 shell 提示符 " + (sawPrompt === null ? "未在 6s 内出现" : "在 " + sawPrompt + "ms 回来") +
           "；该窗口内时间线无 MARK-SECOND/MARK-THIRD"));

    // 提示符回来后命令集要继续跑完
    let doneAt = null;
    t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const txt = await lib.snapshot(page);
      const p = await probe(page);
      if (/echo MARK-THIRD-RAN/.test(txt) || /命令集完成/.test(p.cs)) {
        doneAt = Date.now() - t0;
        break;
      }
      await sleep(250);
    }
    await sleep(1500);
    sampler.stop();
    const final = await lib.snapshot(page);
    const stFinal = await probe(page);
    fs.writeFileSync(path.join(lib.OUT, "cs-final.txt"), final);
    fs.writeFileSync(path.join(lib.OUT, "cs-timeline.json"),
      JSON.stringify(sampler.timeline, null, 1));

    record("C5 提示符回来后命令集继续跑完",
      /echo MARK-SECOND-RAN/.test(final) && /echo MARK-THIRD-RAN/.test(final),
      "完成耗时=" + doneAt + "ms；命令集状态=" + JSON.stringify(stFinal.cs) +
      "；屏幕尾=" + JSON.stringify(final.slice(-360)));

    // 每条连接后命令的原文都要上屏（回显或补画）——真机反馈「只显示第 1 条」
    const missing = CMDS.filter(c => !final.includes(c));
    record("C6 每条连接后命令都在屏幕上", missing.length === 0,
      missing.length ? ("缺这些命令行文本：" + missing.join(" | "))
                     : "三条命令行原文均在屏：" + CMDS.join(" | "));

    // 顺序硬断言：密码提示 < 新 shell 提示符 < 第 2 条命令
    const evPw = sampler.firstAt(/Password\s*[:：]/i);
    const evSh = sampler.firstAt(/\[demo@fakehost ~\]\$/);
    const evS2 = sampler.firstAt(/echo MARK-SECOND-RAN/);
    const seq = [];
    if (evPw) seq.push(["password", evPw.t]);
    if (evSh) seq.push(["shell-prompt", evSh.t]);
    if (evS2) seq.push(["cmd2", evS2.t]);
    const ordered = evPw && evSh && evS2 && evPw.t <= evSh.t && evSh.t <= evS2.t;
    record("C7 屏幕时序：密码提示 → 新提示符 → 第 2 条命令", !!ordered,
      "时间线(ms)=" + JSON.stringify(seq) +
      (ordered ? "" : "（期望 password ≤ shell-prompt ≤ cmd2）"));

    // 顺手确认终端还能收输入（真机「要按 Enter 才刷新状态」的对照）
    await clickTerm(page);
    await page.keyboard.type("ZAPROBE", { delay: 20 });
    await sleep(700);
    const typed = await lib.snapshot(page);
    record("C8 终端可输入", typed.includes("ZAPROBE"),
      typed.includes("ZAPROBE") ? "回显 ZAPROBE" : "尾=" + JSON.stringify(typed.slice(-200)));

    record("C9 无页面/控制台错误", errors.length === 0,
      errors.length ? errors.slice(0, 6).join(" | ") : "干净");
  } finally {
    await browser.close().catch(() => {});
  }
  return finish();
}

function finish() {
  const pass = results.filter(r => r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) {
    console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  }
  console.log(`\n合计 ${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exitCode = 1;
  // 显式退出：lib.startServer 起的服务端是子进程，不退会把 node 挂住
  process.exit(process.exitCode || 0);
  return results;
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
