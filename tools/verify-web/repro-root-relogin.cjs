// 真机浏览器复现：跳板机 → 远程机 xiaojian → sudo su - root → root 空闲自动
// 登出掉回 xiaojian → 再 sudo su - → 输入自然语言失效（2026-10-07 用户反馈）
//
// 环境（全真链路，只有「远端主机」换成本地 docker）：
//   真 Chromium + 真 xterm.js + 真 WebSocket + 真 PipelineCore
//   + 真 asyncssh + 真 OpenSSH 服务端 + 真 bash/readline + 真 sudo/su -
//   + 真模型网关（config [model] 指向本机 127.0.0.1:15721）
//
//   docker 容器 ot-repro（ubuntu:24.04 + openssh-server）扮演两台机器：
//     ubuntu@容器    = 跳板机（app 的 ssh 目标）
//     xiaojian@容器  = 远程机（连接后命令里 ssh 过去，= 嵌套 ssh 帧）
//     root           = sudo su - 之后；/etc/profile.d 给 root 挂 TMOUT=15，
//                      复刻「很久没操作 root 自动退出、掉回 xiaojian」
//
// 用法: node tools/verify-web/repro-root-relogin.cjs [port]
//   前置: docker 容器 ot-repro 已起（见 .tmp/repro/setup-container.sh）
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8242);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = path.join(lib.OUT, "rootrelogin-home");
const SSH_PORT = Number(process.env.OT_REPRO_SSH_PORT || 2222);
const TARGET = "jump";

const PW = { ubuntu: "ub123456", xiaojian: "xj123456", root: "root123456" };
const NL1 = "执行 echo MARK-AI-ONE 并把输出原样告诉我";
const NL2 = "执行 echo MARK-AI-TWO 并把输出原样告诉我";
// 上屏判据：MARK-* 至少出现两次 = 除自然语言回显外还有 echo 的**输出行**。
// 实测：报障态整行被裸壳当命令执行，屏幕上只有回显那 1 次；健康态 3 次
// （自然语言回显 + 工具命令回显 + 输出）。
// 不能用 ^…$ 行锚定：lib.snapshot 在 `.xterm-row` 选择器落空时回退到整块
// textContent，行间没有换行符（实测 newline 数 = 0），行锚定永不匹配。
const RAN = 2;
const countOf = (text, tok) => String(text || "").split(tok).length - 1;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}

// ---- 页面状态 ----
const probe = page => page.evaluate(() => {
  const g = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.innerText || "").trim() : "";
  };
  const vis = id => {
    const el = document.querySelector(`[id^="${id}-"]`);
    return el ? (el.hidden ? "hidden" : "shown") : "missing";
  };
  const think = document.querySelector('[id^="think-"]');
  const tt = think && think.querySelector ? think.querySelector(".ttext") : null;
  const modal = document.querySelector("#modal-root .modal");
  return {
    conn: g("conn"), connVis: vis("conn"), overlayVis: vis("connov"),
    status: g("status"), cs: g("cs"), tokens: g("tokens"),
    think: think ? (think.hidden ? "hidden" : "shown") : "missing",
    thinkText: tt ? (tt.textContent || "").trim() : "",
    modal: modal ? (modal.innerText || "").trim().slice(0, 200) : "",
  };
});

// ---- 模态代答（扮演用户：主机密钥信任 / 审批批准 / 密码填写）----
const BUTLER_CFG = {
  def: PW.xiaojian,   // sudo 的「密码: 」提示符不带主机信息
  rules: [["ubuntu", PW.ubuntu], ["xiaojian", PW.xiaojian], ["root", PW.root]],
};

let butlerSig = null;
let butlerSigAt = 0;
let butlerCooldownUntil = 0;

async function butlerTick(page) {
  if (Date.now() < butlerCooldownUntil) return null;
  const sig = await page.evaluate(() => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    return modal ? (modal.innerText || "").replace(/\s+/g, " ") : "";
  });
  if (!sig) { butlerSig = null; return null; }
  if (sig !== butlerSig) { butlerSig = sig; butlerSigAt = Date.now(); return null; }
  // 密码类模态：等在屏稳定，让应用的陈旧模态防抖先跑完
  if (/密码|令牌/.test(sig) && Date.now() - butlerSigAt < 900) return null;
  const act = await butlerAct(page);
  if (act) butlerCooldownUntil = Date.now() + 1500;
  return act;
}

async function butlerAct(page) {
  return page.evaluate((cfg) => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return null;
    const h3 = modal.querySelector("h3");
    const title = ((h3 && h3.innerText) || "").trim();
    const body = (modal.innerText || "").replace(/\s+/g, " ");
    const btn = re => Array.from(root.querySelectorAll(".modal-btns button"))
      .find(b => re.test(b.innerText || ""));
    if (title.indexOf("主机密钥") === 0) {
      const b = btn(/信任|确定/);
      if (b) { b.click(); return "hostkey:trust"; }
    }
    if (title.indexOf("审批") === 0) {
      const b = btn(/批准|同意|允许/);
      if (b) { b.click(); return "approve:" + title.slice(0, 40); }
    }
    if (title.indexOf("密码") === 0 || title.indexOf("令牌") === 0) {
      const v = document.getElementById("modal-value");
      const rem = document.getElementById("modal-remember");
      let pw = cfg.def;
      for (const r of cfg.rules) {
        if (body.indexOf(r[0]) !== -1) { pw = r[1]; break; }
      }
      if (v) v.value = pw;
      // 不写系统凭据库：keyring 是全局的，测试不该往用户真实凭据库里落条目
      if (rem) rem.checked = false;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw(" + pw + "):" + body.slice(0, 60); }
    }
    return null;
  }, BUTLER_CFG);
}

// ---- 终端里直接敲密码（扮演真人）----
// 模态不是唯一通道：命令集暂停时提示「请在终端输入密码」，而 _pw_prompt_seen
// 上升沿被吃掉后模态也不会再弹。真人此时会直接在终端里敲密码，harness 必须
// 同样做，否则复现卡死在密码提示符上（与被测缺陷无关）。
const PW_PROMPT_RE = /(password for ([A-Za-z0-9_.-]+)\s*:\s*$)|(([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)'s password:\s*$)|(密码\s*[:：]\s*$)/;

function pwForPrompt(tail) {
  const m = tail.match(PW_PROMPT_RE);
  if (!m) return null;
  const user = m[2] || m[4];
  if (user && PW[user]) return PW[user];
  return PW.xiaojian;
}

let termPwSig = null;
let termPwAt = 0;
let termPwCooldown = 0;

async function termPwTick(page) {
  if (Date.now() < termPwCooldown) return null;
  const hasModal = await page.evaluate(() => {
    const root = document.querySelector("#modal-root");
    return !!(root && root.querySelector(".modal"));
  });
  if (hasModal) { termPwSig = null; return null; }
  const txt = await lib.snapshot(page);
  const tail = txt.replace(/\s+$/, "").slice(-160);
  const pw = pwForPrompt(tail);
  if (!pw) { termPwSig = null; return null; }
  const sig = tail.slice(-60);
  if (sig !== termPwSig) { termPwSig = sig; termPwAt = Date.now(); return null; }
  if (Date.now() - termPwAt < 1600) return null;   // 等模态自己弹/自己关
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(pw, { delay: 18 });
  await page.keyboard.press("Enter");
  termPwSig = null;
  termPwCooldown = Date.now() + 4000;
  return "termpw(" + pw + ")";
}

let butlerLog = [];
let butlerStop = false;
function startButler(page) {
  (async () => {
    while (!butlerStop) {
      try {
        const act = (await butlerTick(page)) || (await termPwTick(page));
        if (act) {
          butlerLog.push({ t: Date.now(), act });
          console.log("    [butler] " + act);
        }
      } catch (e) { /* 页面正在导航/关闭 */ }
      await sleep(180);
    }
  })();
}

async function clickTerm(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.locator(".term").click({ timeout: 3000, force: true });
      await sleep(120);
      return true;
    } catch (e) {}
    await sleep(300);
  }
  return false;
}

// ---- 终端输入 ----
async function say(page, text, { enter = true, delay = 22 } = {}) {
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  await sleep(150);
  await page.keyboard.type(text, { delay });
  if (enter) await page.keyboard.press("Enter");
}

// ---- 等待条件 ----
async function waitReady(page, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    if (p.connVis === "hidden" && p.overlayVis === "hidden" && p.status) {
      return { ok: true, waited: Date.now() - t0, status: p.status.slice(0, 80) };
    }
    await sleep(400);
  }
  return { ok: false, waited: Date.now() - t0, status: (await probe(page)).status.slice(0, 80) };
}

async function waitScreen(page, re, timeout, label = "") {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const txt = await lib.snapshot(page);
    const m = txt.match(re);
    if (m) return { ok: true, waited: Date.now() - t0, hit: m[0], text: txt };
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, text: await lib.snapshot(page) };
}

// 只匹配屏幕**尾部**：snapshot 是整个视口（含此前阶段留下的旧行），全屏匹配
// 会让「第二次落到 root 提示符」命中阶段 A 的旧提示符（第 2 轮实测 D1 1ms
// 假 PASS，随后整轮时序错位）。
async function waitTail(page, re, timeout, n = 300) {
  const t0 = Date.now();
  let tail = "";
  while (Date.now() - t0 < timeout) {
    const txt = await lib.snapshot(page);
    // 卡片层会在提示符下方垫空行：先剥尾部空白再取尾窗，否则垫行把真实内容
    // 挤出窗口
    tail = txt.replace(/\s+$/, "").slice(-n);
    const m = tail.match(re);
    if (m) return { ok: true, waited: Date.now() - t0, hit: m[0], text: txt };
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, text: tail };
}

// 按出现次数等 echo 的**输出行**（见 RAN 注释）
async function waitCount(page, tok, need, timeout) {
  const t0 = Date.now();
  let text = "";
  while (Date.now() - t0 < timeout) {
    text = await lib.snapshot(page);
    const n = countOf(text, tok);
    if (n >= need) return { ok: true, waited: Date.now() - t0, n, text };
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, n: countOf(text, tok), text };
}

const countRe = (text, re) => (String(text || "").match(re) || []).length;

// 按正则出现次数等：提示符这类「同形文本会留在滚动历史里」的目标，只能看增量
async function waitCountRe(page, re, need, timeout) {
  const t0 = Date.now();
  let text = "";
  while (Date.now() - t0 < timeout) {
    text = await lib.snapshot(page);
    const n = countRe(text, re);
    if (n >= need) return { ok: true, waited: Date.now() - t0, n, text };
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, n: countRe(text, re), text };
}

async function waitTaskStart(page, timeout = 30000) {  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    if (p.think === "shown") return { ok: true, waited: Date.now() - t0, text: p.thinkText };
    await sleep(200);
  }
  return { ok: false, waited: Date.now() - t0, probe: await probe(page) };
}

async function waitTaskEnd(page, timeout = 120000) {
  const t0 = Date.now();
  let sawStart = false;
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    if (p.think === "shown") sawStart = true;
    else if (sawStart) return { ok: true, waited: Date.now() - t0 };
    await sleep(300);
  }
  return { ok: false, sawStart, waited: Date.now() - t0 };
}

// ---- 隔离 home ----
function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const toml = [
    "# repro-root-relogin 专用（隔离 OPENTERMINAL_HOME，不碰用户真实配置）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat", "id", "whoami", "hostname"]',
    "",
    "[web]",
    'host = "127.0.0.1"',
    `port = ${PORT}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(HOME, "config.toml"), toml, "utf8");
  seedSavedConnection();
}

// 侧栏「记住的连接」只来自 connections.db —— build_target_list() 不读 config 里的
// [target.*]。复现目标必须以 saved connection 落库，否则 pickTarget 匹配不到会静默
// 回退点第一个（local），整轮就跑在本地 PowerShell 上（上一轮的坑）。
function seedSavedConnection() {
  const { spawnSync } = require("node:child_process");
  const py = path.join(lib.REPO, ".venv-win", "Scripts", "python.exe");
  const script = path.join(lib.REPO, "tools", "verify-web", "fixtures",
                           "seed-saved-conn.py");
  const r = spawnSync(py, [script], {
    cwd: lib.REPO,
    env: {
      ...process.env,
      OPENTERMINAL_HOME: HOME,
      PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET,
      OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: String(SSH_PORT),
      OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "ssh xiaojian@127.0.0.1|sudo su -|cd /root",
    },
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1) {
    throw new Error("seed connections.db 失败: " + out);
  }
  console.log("已落库 saved connection:", out);
}

function dump(name, text) {
  const p = path.join(lib.OUT, name);
  fs.writeFileSync(p, text == null ? "" : String(text), "utf8");
  return p;
}

// 服务端 [otdbg] 轨迹（lib.startServer 边跑边落盘）：修复机制是否真的生效，
// 不能只看屏幕结果，要看状态机有没有走到「判定 hook 陈旧 → 转降级」那一步
function readDbg(logPath) {
  try { return fs.readFileSync(logPath, "utf8"); } catch (e) { return ""; }
}

async function main() {
  prepareHome();
  const started = await lib.startServer(PORT, {
    env: {
      OPENTERMINAL_HOME: HOME,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "repro-key",
      OT_WEB_DEBUG: "1",          // [otdbg] 状态机轨迹落服务端日志
      // 凭据库整体旁路：keyring 是全局的（Windows 凭据管理器），真机复现不该
      // 往用户真实凭据库里读写条目；null 后端下 load/store 全降级为无操作，
      // 密码一律走模态/终端现场输入（也更贴近用户首次连接的处境）
      PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
      PYTHONIOENCODING: "utf-8",
    },
  });
  const logPath = path.join(lib.OUT, `server-${PORT}.log`);
  console.log("服务端:", started.base, started.server ? "(新起，隔离 home)" : "(复用!)");
  console.log("服务端日志:", logPath);
  if (!started.server) {
    record("R0 隔离服务端", false, "端口上已有服务端，隔离 home 未生效；换端口重试");
    return finish();
  }
  record("R0 隔离服务端", true, started.base + "；容器 ssh 端口 " + SSH_PORT);

  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);
  const timeline = [];
  let tlStop = false;
  (async () => {
    let prev = "";
    const t0 = Date.now();
    while (!tlStop) {
      try {
        const [txt, p] = await Promise.all([lib.snapshot(page), probe(page)]);
        const sig = txt + "|" + p.think + "|" + p.cs + "|" + p.modal;
        if (sig !== prev) {
          timeline.push({ t: Date.now() - t0, think: p.think, cs: p.cs,
                          modal: p.modal.slice(0, 60), text: txt });
          prev = sig;
        }
      } catch (e) {}
      await sleep(150);
    }
  })();

  try {
    startButler(page);
    console.log("\n########## 阶段 A：跳板机 → 远程 xiaojian → sudo su - root ##########");
    const picked = await lib.pickTarget(page, TARGET);
    record("A0 侧栏选中复现目标 " + TARGET, picked,
      picked ? "ok" : "侧栏没有该目标；pickTarget 会静默回退到 local，本轮作废");
    if (!picked) return finish(logPath);
    const ready = await waitReady(page, 90000);
    record("A1 SSH 连接就绪", ready.ok, JSON.stringify(ready));

    // 连接后命令跑完 = 落到 root 的 /root 提示符
    // 容器是 Ubuntu：root 提示符为 root@host:~#（不是 CentOS 的 [root@host /root]#）
    const atRoot = await waitTail(page, /root@[^\r\n]*#/, 45000);
    dump("rr-at-root-1.txt", atRoot.text);
    record("A2 连接后命令落到 root@/root 提示符", atRoot.ok,
      atRoot.ok ? `${atRoot.waited}ms 命中 ${JSON.stringify(atRoot.hit)}`
                : "屏幕尾=" + JSON.stringify(atRoot.text.slice(-400)));
    const csState = (await probe(page)).cs;
    record("A3 命令集状态收束", /完成|done|3\s*\/\s*3/.test(csState) || atRoot.ok,
      "cs=" + JSON.stringify(csState));
    if (!atRoot.ok) { tlStop = true; butlerStop = true; return finish(logPath); }

    console.log("\n########## 阶段 B：root#1 里输入自然语言（对照组，应成功） ##########");
    await sleep(1200);
    const tB = Date.now();
    await say(page, NL1);
    const start1 = await waitTaskStart(page, 30000);
    const mark1 = start1.ok
      ? await waitCount(page, "MARK-AI-ONE", RAN, 90000)
      : { ok: false, n: 0, text: await lib.snapshot(page) };
    dump("rr-after-nl1.txt", mark1.text || (await lib.snapshot(page)));
    record("B1 root#1 自然语言触发任务", start1.ok,
      start1.ok ? `任务徽标 ${start1.waited}ms 出现（${start1.text}）`
                : "30s 内没出现「AI 正在思考」；probe=" + JSON.stringify(start1.probe));
    record("B2 root#1 任务真的执行了 echo", mark1.ok,
      mark1.ok ? `MARK-AI-ONE 上屏 ${mark1.n} 次（含输出行），总耗时 ${Date.now() - tB}ms`
               : "MARK-AI-ONE 只出现 " + mark1.n + " 次（仅回显）；屏幕尾=" +
                 JSON.stringify(String(mark1.text || "").slice(-400)));
    await waitTaskEnd(page, 120000);
    await sleep(1500);

    console.log("\n########## 阶段 C：root 空闲 TMOUT 自动登出，掉回 xiaojian ##########");
    const loggedOut = await waitTail(
      page, /timed out waiting for input|auto-logout/, 60000);
    dump("rr-after-tmout.txt", loggedOut.text);
    record("C1 root 空闲自动登出并掉回 xiaojian", loggedOut.ok,
      loggedOut.ok ? `${loggedOut.waited}ms 命中 ${JSON.stringify(loggedOut.hit.slice(0, 60))}`
                   : "60s 内没掉回 xiaojian；屏幕尾=" +
                     JSON.stringify(loggedOut.text.slice(-300)));
    await sleep(1500);

    console.log("\n########## 阶段 D：从 xiaojian 再 sudo su - 切回 root ##########");
    // 尾部匹配会被 root#1 的旧提示符秒命中（第 3 轮 D1 只用 1ms，命中的是阶段 A
    // 的滚动历史）：先尽力清屏，再按 root 提示符的**出现次数增量**判落地。
    const ROOTP = /root@[A-Za-z0-9_.-]*[:#]/g;
    const beforeD = await lib.snapshot(page);
    const nRootBefore = countRe(beforeD, ROOTP);
    await say(page, "clear");
    await sleep(1500);
    const cleared = await lib.snapshot(page);
    dump("rr-after-clear.txt", cleared);
    const nRootCleared = countRe(cleared, ROOTP);
    record("D0 清屏后旧 root 提示符已不在可视区", nRootCleared === 0,
      nRootCleared === 0
        ? `清屏前 ${nRootBefore} 处 → 清屏后 0 处`
        : "clear 没能把旧提示符移出可视区（D1 改判计数增量，仍有效）：" +
          `${nRootBefore} → ${nRootCleared}`);
    await say(page, "sudo su -");
    const atRoot2 = await waitCountRe(page, ROOTP, nRootCleared + 1, 60000);
    dump("rr-at-root-2.txt", atRoot2.text);
    record("D1 第二次 sudo su - 落到 root 提示符", atRoot2.ok,
      atRoot2.ok
        ? `${atRoot2.waited}ms：root 提示符 ${nRootCleared} → ${atRoot2.n} 处`
        : `60s 内 root 提示符没增加（${nRootCleared} → ${atRoot2.n}）；屏幕尾=` +
          JSON.stringify(atRoot2.text.slice(-400)));
    await sleep(2000);

    console.log("\n########## 阶段 E：root#2 里输入自然语言（被举报障） ##########");
    const beforeNL2 = await lib.snapshot(page);
    await say(page, NL2);
    const echoBack = await waitScreen(page, new RegExp(NL2.slice(0, 12)), 6000);
    const start2 = await waitTaskStart(page, 30000);
    const mark2 = start2.ok
      ? await waitCount(page, "MARK-AI-TWO", RAN, 90000)
      : { ok: false, n: countOf(await lib.snapshot(page), "MARK-AI-TWO"),
          text: await lib.snapshot(page) };
    const after = await lib.snapshot(page);
    dump("rr-after-nl2.txt", after);
    dump("rr-before-nl2.txt", beforeNL2);
    // 失效特征：整行被 shell 当命令执行（command not found / 原样落在提示符后）
    const ranAsCmd = /command not found|未找到命令|No such file/.test(after) ||
      (echoBack.ok && !start2.ok);
    record("E1 root#2 自然语言触发任务", start2.ok,
      start2.ok ? `任务徽标 ${start2.waited}ms 出现（${start2.text}）`
                : "★ 30s 内没出现「AI 正在思考」＝报障复现；probe=" +
                  JSON.stringify(start2.probe));
    record("E2 root#2 任务真的执行了 echo", mark2.ok,
      mark2.ok ? `MARK-AI-TWO 上屏 ${mark2.n} 次（含 echo 输出行）`
               : "MARK-AI-TWO 只出现 " + mark2.n + " 次（仅回显，输出行没来）；" +
                 "屏幕尾=" + JSON.stringify(after.slice(-500)));
    record("E3 自然语言没被当成 shell 命令执行", !ranAsCmd,
      ranAsCmd ? "★ 整行落进 root shell 当命令跑了（回显=" + echoBack.ok + "）"
               : "未见 command not found");
    // 机制证据：状态机必须真的判过「hook 陈旧」并转降级（探测 + 重注入），
    // 或者 root#2 本来就被 hook 上了（此时健康路径合法）。两者都不成立而屏幕
    // 又 PASS，说明这轮结果是别的原因凑出来的（假阳性验证）。
    const dbgNow = readDbg(logPath);
    const dbgLines = dbgNow.split(/\r?\n/);
    const lastIdx = pred => {          // pred: 行 -> bool
      let hit = -1;
      dbgLines.forEach((l, i) => { if (pred(l)) hit = i; });
      return hit;
    };
    const staleIdx = lastIdx(l => /hook stale/.test(l));
    const nl2Idx = lastIdx(l => /submit text=/.test(l) &&
                                l.indexOf("MARK-AI-TWO") !== -1);
    const staleBeforeNl2 = staleIdx >= 0 && (nl2Idx < 0 || staleIdx < nl2Idx);
    // 提交之后出现 hook 标记 = 承接这行的壳是集成壳（健康路径或重注入后重发）
    const hookLiveAfter = nl2Idx >= 0 && dbgLines.slice(nl2Idx + 1)
      .some(l => /\bev (report|prompt_start|exec_start)\b/.test(l));
    const dbgTail = dbgLines
      .filter(l => /hook stale|submit text=|exec_start|exec_end|ev report/
        .test(l))
      .slice(-10).join("\n");
    record("E4 修复机制真的生效（判陈旧转降级 / root#2 已 hook）",
      staleBeforeNl2 || hookLiveAfter,
      `hook stale=${staleBeforeNl2} hookLiveAfter=${hookLiveAfter}\n` + dbgTail);

    console.log("\n########## 阶段 F：终端是否还能收输入 ##########");
    // E2 失败时任务可能还在跑：任务上下文里的键入会被当命令输入吃掉，F1 就
    // 变成在测「任务中途打字」而不是「终端还活着」
    const ended2 = await waitTaskEnd(page, 120000);
    console.log("  任务收束=", JSON.stringify(ended2));
    await sleep(1000);
    await say(page, "echo ZAP-PROBE");
    const zap = await waitCount(page, "ZAP-PROBE", 2, 15000);
    record("F1 终端仍可输入执行命令", zap.ok,
      zap.ok ? `ZAP-PROBE 上屏 ${zap.n} 次（回显 + 输出）`
             : "只出现 " + zap.n + " 次；屏幕尾=" + JSON.stringify(zap.text.slice(-300)));
    // F1 挂了要能一眼分清「远端真的沉默」和「输出泵死了/卡住」：
    //   pump died 有行 = 泵抛异常死了；tick 在 raw 之后还在走 = 泵活着、
    //   _read_some 正常超时返回，字节确实没来（远端沉默）。
    const dbgF = readDbg(logPath).split(/\r?\n/);
    const diedF = dbgF.filter(l => /pump died/.test(l));
    const tickF = dbgF.filter(l => /pump tick/.test(l));
    const rawF = dbgF.filter(l => /\[otdbg\] raw /.test(l));
    // 不变量：泵没抛异常死掉，且 NL2 提交之后确实还在往上送字节。
    // 不能拿「末字节之后还有心跳」当条件——心跳只在连续 10 次读超时（≈2s
    // 空闲）后才打一行，harness 读到日志那一刻往往还没有 2s 空闲（第 5 轮
    // 假阴性：pump died=0、末条 raw 正是 ZAP-PROBE 的回显+输出，仍判 FAIL）。
    const nl2I = (() => { let h = -1;
      dbgF.forEach((l, i) => { if (/submit text=/.test(l) &&
        l.indexOf("MARK-AI-TWO") !== -1) h = i; }); return h; })();
    const rawAfterNl2 = nl2I >= 0 &&
      dbgF.slice(nl2I + 1).filter(l => /\[otdbg\] raw /.test(l)).length;
    record("F2 输出泵仍活着（无异常死亡；提交后仍在送字节）",
      diedF.length === 0 && rawAfterNl2 > 0,
      `pump died=${diedF.length} tick=${tickF.length} raw=${rawF.length} ` +
      `rawAfterNl2Submit=${rawAfterNl2}\n` +
      [...rawF.slice(-2), ...tickF.slice(-1), ...diedF.slice(-4)].join("\n"));

    tlStop = true;
    butlerStop = true;
    await sleep(300);
    dump("rr-timeline.json", JSON.stringify(timeline, null, 1));
    dump("rr-butler.json", JSON.stringify(butlerLog, null, 1));
    record("G1 无页面/控制台错误", errors.length === 0,
      errors.length ? errors.slice(0, 6).join(" | ") : "干净");
  } finally {
    tlStop = true;
    butlerStop = true;
    try { await page.screenshot({ path: path.join(lib.OUT, "rr-final.png"),
                                  fullPage: false }); } catch (e) {}
    await browser.close().catch(() => {});
    if (started.server) { try { started.server.kill(); } catch (e) {} }
  }
  return finish(logPath);
}

function finish(logPath) {
  const pass = results.filter(r => r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`\n合计 ${pass}/${results.length} 通过`);
  if (logPath && fs.existsSync(logPath)) {
    const log = fs.readFileSync(logPath, "utf8");
    dump("rr-server.log", log);
    const dbg = log.split(/\r?\n/).filter(l => l.indexOf("[otdbg]") !== -1);
    dump("rr-otdbg.log", dbg.join("\n"));
    console.log("服务端 [otdbg] 轨迹行数:", dbg.length, "→ .tmp/live/rr-otdbg.log");
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
