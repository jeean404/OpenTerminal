// 真机浏览器复现：**审批等待期** root 空闲 TMOUT 自动登出，用户这时点「同意」。
//
// 旧症状（真机截图）：同意后屏幕刷 __ot_exec__/ot_pad: command not found，
// 紧接着命令本体被落回来的裸壳**拆段照常执行**（只读命令运气好，破坏性命令
// 会实际生效），工具卡最后 ✗ 失败 (130)。本脚本按修复后口径断言：
//   1) 不出现注入垃圾（__ot_exec__/__ot_pad/command not found）；
//   2) 命令本体任何一段都没执行（带 ; 的命令断言原子性）；
//   3) 工具卡/状态给出可读原因，或重集成后命令完整执行（两者都算过）；
//   4) 之后重新 sudo su -，自然语言恢复正常（此项先把 TMOUT 抬回分钟级，
//      否则测的是 5 秒计时器而不是恢复能力）。
//
// 环境同 repro-root-relogin.cjs：docker 容器 ot-repro（跳板机 ubuntu →
// xiaojian → sudo su - root），TMOUT 已临时设为 5s。
//
// 用法: node tools/verify-web/repro-approve-tmout.cjs [port]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8243);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NL = "\n";
const HOME = path.join(lib.OUT, "approvetmout-home");
const SSH_PORT = Number(process.env.OT_REPRO_SSH_PORT || 2222);
const TARGET = "jump";
const PW = { ubuntu: "ub123456", xiaojian: "xj123456", root: "root123456" };

// 带 `;` 的单条命令：裸壳下会被拆段，第一段报 command not found、第二段照常跑。
// 修复后注入行是单引号包住的一条命令 + 一个字面参数，任何一段都不得执行。
const SEG1 = "/tmp/ot-seg1";
const SEG2 = "/tmp/ot-seg2";
const NL_APPROVE = `请用一条命令执行 echo A>${SEG1}; echo B>${SEG2}` +
  "（一条命令、分号连两段，不要拆成两次调用），执行完把结果告诉我";
const NL_AFTER = "执行 echo MARK-AFTER 并把输出原样告诉我";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}
function finish(logPath) {
  const fails = results.filter(r => !r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`\n合计 ${results.length - fails}/${results.length} 通过`);
  if (logPath) console.log("服务端 [otdbg] 轨迹: " + logPath);
  process.exit(fails ? 1 : 0);
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
  const think = document.querySelector('[id^="think-"]');
  const modal = document.querySelector("#modal-root .modal");
  // 审批优先是**卡片**（.aphead），只有卡片压根没 fund 成时才转模态兜底。
  // 工具宣告卡（「调用工具：execute」）也挂 .aphead——必须按问句区分
  const apHead = Array.from(document.querySelectorAll(".aphead"))
    .find(x => /是否同意/.test(x.innerText || ""));
  return {
    conn: g("conn"), connVis: vis("conn"), overlayVis: vis("connov"),
    status: g("status"), cs: g("cs"),
    think: think ? (think.hidden ? "hidden" : "shown") : "missing",
    modal: modal ? (modal.innerText || "").replace(/\s+/g, " ").slice(0, 300) : "",
    modalTitle: (() => {
      const m = document.querySelector("#modal-root .modal h3");
      return m ? (m.innerText || "").trim() : "";
    })(),
    approvalCard: apHead
      ? (apHead.innerText || "").replace(/\s+/g, " ").slice(0, 300) : "",
    cards: Array.from(document.querySelectorAll(".acard"))
      .map(x => (x.innerText || "").replace(/\s+/g, " ").slice(0, 160)),
  };
});

// ---- 模态代答：只管主机密钥/密码，**绝不点审批**（审批时机由本脚本控制）----
const PW_RULES = [["ubuntu", PW.ubuntu], ["xiaojian", PW.xiaojian], ["root", PW.root]];
let pwSig = null, pwAt = 0, pwCooldown = 0;

async function pwTick(page) {
  if (Date.now() < pwCooldown) return null;
  const p = await probe(page);
  if (!p.modal) { pwSig = null; return null; }
  if (!/密码|令牌|主机密钥/.test(p.modal)) { pwSig = null; return null; }
  if (p.modal !== pwSig) { pwSig = p.modal; pwAt = Date.now(); return null; }
  if (Date.now() - pwAt < 900) return null;
  const act = await page.evaluate((rules) => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return null;
    const title = ((modal.querySelector("h3") || {}).innerText || "").trim();
    const body = (modal.innerText || "").replace(/\s+/g, " ");
    const btn = re => Array.from(root.querySelectorAll(".modal-btns button"))
      .find(b => re.test(b.innerText || ""));
    if (title.indexOf("主机密钥") === 0) {
      const b = btn(/信任|确定/);
      if (b) { b.click(); return "hostkey:trust"; }
    }
    if (title.indexOf("密码") === 0 || title.indexOf("令牌") === 0) {
      const v = document.getElementById("modal-value");
      const rem = document.getElementById("modal-remember");
      let pw = rules[1][1];
      for (const r of rules) if (body.indexOf(r[0]) !== -1) { pw = r[1]; break; }
      if (v) v.value = pw;
      if (rem) rem.checked = false;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw(" + pw + ")"; }
    }
    return null;
  }, PW_RULES);
  if (act) pwCooldown = Date.now() + 1500;
  return act;
}

// 终端里直接敲密码（命令集暂停时提示「请在终端输入密码」）
const PW_PROMPT_RE = /(password for ([A-Za-z0-9_.-]+)\s*:\s*$)|(([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)'s password:\s*$)|(密码\s*[:：]\s*$)/;
function pwForPrompt(tail) {
  const m = tail.match(PW_PROMPT_RE);
  if (!m) return null;
  const user = m[2] || m[4];
  return (user && PW[user]) ? PW[user] : PW.xiaojian;
}
let termSig = null, termAt = 0, termCd = 0;

async function termPwTick(page) {
  if (Date.now() < termCd) return null;
  if ((await probe(page)).modal) { termSig = null; return null; }
  const txt = await lib.snapshot(page);
  const tail = txt.replace(/\s+$/, "").slice(-160);
  const pw = pwForPrompt(tail);
  if (!pw) { termSig = null; return null; }
  const sig = tail.slice(-60);
  if (sig !== termSig) { termSig = sig; termAt = Date.now(); return null; }
  if (Date.now() - termAt < 1600) return null;
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(pw, { delay: 18 });
  await page.keyboard.press("Enter");
  termSig = null; termCd = Date.now() + 4000;
  return "termpw(" + pw + ")";
}

let butlerStop = false;
function startButler(page) {
  (async () => {
    while (!butlerStop) {
      try {
        const act = (await pwTick(page)) || (await termPwTick(page));
        if (act) console.log("    [butler] " + act);
      } catch (e) { /* 页面导航/关闭 */ }
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

async function say(page, text, { enter = true, delay = 22 } = {}) {
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  await sleep(150);
  await page.keyboard.type(text, { delay });
  if (enter) await page.keyboard.press("Enter");
}

async function waitReady(page, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    if (p.connVis === "hidden" && p.overlayVis === "hidden" && p.status) {
      return { ok: true, waited: Date.now() - t0, status: p.status.slice(0, 80) };
    }
    await sleep(400);
  }
  return { ok: false, waited: Date.now() - t0 };
}

async function waitTail(page, re, timeout, n = 300) {
  const t0 = Date.now();
  let tail = "";
  while (Date.now() - t0 < timeout) {
    const txt = await lib.snapshot(page);
    tail = txt.replace(/\s+$/, "").slice(-n);
    const m = tail.match(re);
    if (m) return { ok: true, waited: Date.now() - t0, hit: m[0], text: txt };
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, text: tail };
}

// 审批挂起期 root 空闲自动登出的判据。屏幕文本不可靠：欢迎横幅/卡片临界区
// 会把 PTY 字节先扣进 _holdBuf（app.js _ingestBytes），登出那一行
// `timed out waiting for input: auto-logout` 可能还没落屏；落屏后又会被
// 重注入的提示符重绘挤出视口。所以两条通道一起看：屏幕文本，以及服务端
// 字节流日志（OT_WEB_DEBUG=1 下泵的 raw 行原样记 PTY 字节——P1-3 认的就
// 是这段字节，这也是最贴近真值的一条）。
async function logSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

async function logTailHit(p, from, re) {
  try {
    const st = fs.statSync(p);
    if (st.size <= from) return null;
    const len = Math.min(st.size - from, 65536);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    fs.closeSync(fd);
    const m = buf.toString("utf8").match(re);
    return m ? m[0] : null;
  } catch (e) { return null; }
}

// 工具卡标题带的是真要跑的那条命令：D2 的原子性断言只有在它**确实分段**时
// 才有意义。模型可能把两段折成一条不带分段的等价命令（例如 touch a b，
// 一个 touch 带两个参数），那时 seg1/seg2 同真同假只是空断言，验不到
// 「裸壳拆段照跑」那条旧症状。拿不到分段就报「场景无效」，不静默放过。
function cmdOf(p) {
  const all = (p.cards || []).join(String.fromCharCode(10));
  const m = all.match(/调用工具：execute\s+([^\n]+)/) ||
            all.match(/命令：\s+([^\n]+)/);
  return m ? m[1].trim() : "";
}

async function waitShellLogout(page, logPath, timeout) {
  const t0 = Date.now();
  const RE = /timed out waiting for input|auto-logout/i;
  const logAt0 = await logSize(logPath);
  let txt = "";
  while (Date.now() - t0 < timeout) {
    txt = await lib.snapshot(page);
    const m = txt.match(RE);
    if (m) {
      return { ok: true, waited: Date.now() - t0, via: "screen",
               hit: m[0], text: txt };
    }
    const h = await logTailHit(logPath, logAt0, RE);
    if (h) {
      return { ok: true, waited: Date.now() - t0, via: "bytes",
               hit: h, text: txt };
    }
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, text: txt,
           tail: txt.replace(/\s+$/, "").slice(-300) };
}

const countOf = (text, tok) => String(text || "").split(tok).length - 1;

async function waitApproval(page, timeout = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    // 审批先落卡片（.aphead），卡片压根没 fund 成才转模态兜底
    if (p.approvalCard) {
      return { ok: true, waited: Date.now() - t0, title: "审批卡",
               body: p.approvalCard };
    }
    if (p.modalTitle.indexOf("审批") === 0) {
      return { ok: true, waited: Date.now() - t0, title: p.modalTitle, body: p.modal };
    }
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, probe: await probe(page) };
}

// 点审批的「同意/确认执行」——只在本脚本显式调用时才点。
// 高危卡是**两段**确认：点「执行」只是露出「高危命令，确认执行？」确认条
// （ui.js 里 risk === "high" 的分支只 toggle 那条），真正放行要点「确认
// 执行」。只点一次会让 core 的 ask_approval 一直等决策：任务假死，之后的
// 自然语言全被 _ai_queue 排队，屏幕上只剩思考徽标（真机同款观感）。
async function clickApprove(page) {
  const pick = () => page.evaluate(() => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    // 工具宣告卡也挂 .aphead：只在带「是否同意」问句的那张里找按钮
    const apHead = Array.from(document.querySelectorAll(".aphead"))
      .find(x => /是否同意/.test(x.innerText || ""));
    const btns = apHead
      ? Array.from(apHead.querySelectorAll("button"))
      : (modal ? Array.from(root.querySelectorAll(".modal-btns button")) : []);
    const txt = x => (x.innerText || "").replace(/\s+/g, "");
    // 确认条开着就直接点「确认执行」；否则点「执行/批准」把它露出来。
    // 「始终允许」会把命令写进策略白名单，绕过真正的同意执行路径
    // （断言就验不到「同意」这条链了）
    const b = btns.find(x => /^确认执行$/.test(txt(x)))
            || btns.find(x => /^(执行|保存并执行|同意|批准)$/.test(txt(x)))
            || btns.find(x => /执行|同意|批准/.test(txt(x))
                          && !/始终|永久|取消/.test(txt(x)));
    if (!b) {
      return "no-btn:" + (apHead ? (apHead.innerText || "").slice(0, 60)
                                 : (modal ? "modal" : "no-approval-card"));
    }
    b.click();
    return "click:" + txt(b);
  });
  const s1 = await pick();
  if (s1.indexOf("click:") !== 0) return s1;
  await sleep(300);      // React 重渲染后「确认执行」才进 DOM
  const s2 = await pick();
  // 非高危卡（「是否同意执行以下命令…」）点「执行」当场放行，第二趟已无卡可点；
  // 高危卡（「…高危命令…」）第二趟才点得到「确认执行」。两种都记下来。
  const last = s2.indexOf("click:") === 0
    ? s1.slice(6) + "→" + s2.slice(6) : s1.slice(6);
  return "approve:" + last;
}

async function waitTaskEnd(page, timeout = 90000) {
  const t0 = Date.now();
  let saw = false;
  while (Date.now() - t0 < timeout) {
    const p = await probe(page);
    if (p.think === "shown") saw = true;
    else if (saw) return { ok: true, waited: Date.now() - t0 };
    await sleep(300);
  }
  return { ok: false, saw };
}

// 容器里的命令体段标记（经 docker exec 读，直接验「有没有真的被裸壳执行」）
function segFiles() {
  // 用 test -f 回 0/1 两位，别用 ls：ls 失败时 stderr 里也带文件名，会把
  // 「两段都没跑」误读成「两段都跑了」
  const r = spawnSync("docker", ["exec", "ot-repro", "bash", "-c",
    `printf '%s%s' $(test -f ${SEG1} && echo 1 || echo 0) `
    + `$(test -f ${SEG2} && echo 1 || echo 0)`],
    { encoding: "utf8" });
  const bits = ((r.stdout || "") + (r.stderr || "")).trim();
  return { seg1: bits[0] === "1", seg2: bits[1] === "1", bits };
}
function resetSegs() {
  spawnSync("docker", ["exec", "ot-repro", "bash", "-c",
    `rm -f ${SEG1} ${SEG2}`], { encoding: "utf8" });
}

function dump(name, text) {
  const p = path.join(lib.OUT, name);
  fs.writeFileSync(p, text == null ? "" : String(text), "utf8");
  return p;
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# repro-approve-tmout 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    // echo/ls 等只读自动放行；touch 不在列表 → 走审批卡（本脚本的目标）
    'auto_extra = ["echo", "ls", "pwd", "cat", "id", "whoami", "hostname"]',
    "",
    "[web]",
    'host = "127.0.0.1"',
    `port = ${PORT}`,
    "",
  ].join("\n"), "utf8");
  const py = path.join(lib.REPO, ".venv-win", "Scripts", "python.exe");
  const r = spawnSync(py, [path.join(lib.REPO, "tools", "verify-web", "fixtures",
                                     "seed-saved-conn.py")], {
    cwd: lib.REPO,
    env: {
      ...process.env, OPENTERMINAL_HOME: HOME, PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET, OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: String(SSH_PORT), OT_SEED_USER: "ubuntu",
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

async function main() {
  prepareHome();
  resetSegs();
  const started = await lib.startServer(PORT, {
    env: {
      OPENTERMINAL_HOME: HOME,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "repro-key",
      OT_WEB_DEBUG: "1",
      PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
      PYTHONIOENCODING: "utf-8",
    },
  });
  const logPath = path.join(lib.OUT, `server-${PORT}.log`);
  console.log("服务端:", started.base);
  if (!started.server) {
    record("R0 隔离服务端", false, "端口上已有服务端；换端口重试");
    return finish();
  }
  record("R0 隔离服务端", true, started.base + "；容器 ssh 端口 " + SSH_PORT);

  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);

  try {
    startButler(page);
    console.log("\n########## 阶段 A：连到 root 提示符 ##########");
    const picked = await lib.pickTarget(page, TARGET);
    record("A0 侧栏选中复现目标 " + TARGET, picked,
      picked ? "ok" : "侧栏没有该目标");
    if (!picked) return finish(logPath);
    const ready = await waitReady(page, 90000);
    record("A1 SSH 连接就绪", ready.ok, JSON.stringify(ready));
    const atRoot = await waitTail(page, /root@[^\r\n]*#/, 45000);
    dump("at-at-root.txt", atRoot.text);
    record("A2 连接后命令落到 root 提示符", atRoot.ok,
      atRoot.ok ? `${atRoot.waited}ms` : "屏幕尾=" + JSON.stringify(atRoot.text.slice(-300)));
    if (!atRoot.ok) { butlerStop = true; return finish(logPath); }

    console.log("\n########## 阶段 B：触发带 ; 的 execute，等审批卡 ##########");
    await sleep(1200);
    await say(page, NL_APPROVE);
    const apr = await waitApproval(page, 45000);
    dump("at-approval.txt", apr.title + " | " + (apr.body || ""));
    record("B1 高危命令弹出审批卡", apr.ok,
      apr.ok ? `${apr.waited}ms：${apr.title} | ${apr.body}`
             : "45s 内没弹审批卡；probe=" + JSON.stringify(apr.probe));
    if (!apr.ok) { butlerStop = true; return finish(logPath); }
    const approveCmd = cmdOf(await probe(page));

    console.log("\n########## 阶段 C：挂审批不点，等 root TMOUT 自动登出 ##########");
    const loggedOut = await waitShellLogout(page, logPath, 60000);
    dump("at-after-tmout.txt", (loggedOut.text || "") +
      NL + "via=" + loggedOut.via + " hit=" + (loggedOut.hit || ""));
    record("C1 审批挂起期 root 空闲自动登出", loggedOut.ok,
      loggedOut.ok
        ? `${loggedOut.waited}ms 命中 ${JSON.stringify((loggedOut.hit || "").slice(0, 60))}` +
          `（${loggedOut.via === "bytes" ? "PTY 字节流" : "屏幕"}）`
        : "60s 内没掉回；屏幕尾=" + JSON.stringify((loggedOut.tail || "").slice(-300)));
    resetSegs();

    console.log("\n########## 阶段 D：点「同意」——旧症状：垃圾刷屏 + 后半段照跑 ##########");
    const beforeApprove = await lib.snapshot(page);
    dump("at-before-approve.txt", beforeApprove);
    const clicked = await clickApprove(page);
    record("D0 已点审批「同意」", clicked.indexOf("approve:") === 0, clicked);
    const pClick = await probe(page);
    dump("at-after-click.txt", ["clicked=" + clicked,
      "apr=" + pClick.approvalCard, "modal=" + pClick.modalTitle,
      "cards=" + JSON.stringify(pClick.cards)].join(String.fromCharCode(10)));
    await sleep(4000);          // 给快速失败/重集成留时间
    await waitTaskEnd(page, 60000);
    await sleep(1500);
    const pWait = await probe(page);
    dump("at-after-wait.txt", ["apr=" + pWait.approvalCard,
      "modal=" + pWait.modalTitle, "cards=" + JSON.stringify(pWait.cards),
      "think=" + pWait.think].join(String.fromCharCode(10)));
    const after = await lib.snapshot(page);
    dump("at-after-approve.txt", after);
    const delta = after.length > beforeApprove.length
      ? after.slice(beforeApprove.length) : after;

    const garbage = /__ot_exec__|__ot_pad|ot_pad:|command not found|未找到命令/
      .test(delta);
    record("D1 同意后没有注入垃圾落进裸壳", !garbage,
      garbage ? "★ 屏幕新增里出现注入垃圾：" +
        JSON.stringify(delta.slice(-500))
        : "新增区段干净：" + JSON.stringify(delta.slice(-300)));

    const segs = segFiles();
    const partial = segs.seg1 !== segs.seg2;
    const segmented = /;|&&|\|\||`|\$\(/.test(approveCmd);
    record("D2 命令本体没有任何一段被执行（原子性）", segmented && !partial,
      !segmented
        ? `★ 场景无效：实际命令没分段 ${JSON.stringify(approveCmd)}，原子性断言空转`
        : partial
          ? `★ 部分执行：seg1=${segs.seg1} seg2=${segs.seg2}（裸壳把 ; 后那段照跑了）`
          : `命令 ${JSON.stringify(approveCmd)}` + String.fromCharCode(10) +
            `seg1=${segs.seg1} seg2=${segs.seg2}（同无=快速失败未执行；` +
            `同有=重集成后完整执行）`);

    // 可读原因落在状态栏 / 工具卡，不在终端字节流里——两处都要看
    const pAfter = await probe(page);
    const uiText = after + "\n" + pAfter.status + "\n" + (pAfter.cards || []).join("\n");
    const readable = /命令未执行|远端 shell 已退出|无法集成|重新登录|✗ 失败/
      .test(uiText);
    const ranAll = segs.seg1 && segs.seg2;
    record("D3 工具结果可读（可读失败 或 完整执行）", readable || ranAll,
      ranAll ? "重集成后命令完整执行"
             : readable ? "状态/工具卡给出可读原因：" +
                          JSON.stringify(pAfter.status.slice(0, 80) || pAfter.cards)
                        : "★ 既没完整执行也没有可读原因；status=" +
                          JSON.stringify(pAfter.status) + " cards=" +
                          JSON.stringify(pAfter.cards));

    console.log("\n########## 阶段 E：重新 sudo su - 后自然语言恢复 ##########");
    await say(page, "clear");
    await sleep(1500);
    await say(page, "sudo su -");
    const atRoot2 = await waitTail(page, /root@[^\r\n]*#/, 60000);
    dump("at-at-root-2.txt", atRoot2.text);
    record("E1 第二次 sudo su - 落到 root 提示符", atRoot2.ok,
      atRoot2.ok ? `${atRoot2.waited}ms` : "屏幕尾=" + JSON.stringify(atRoot2.text.slice(-300)));
    await sleep(1500);
    // 复现条件 TMOUT=5 在阶段 C 已经完成使命（审批等待期把 root 踢下线）。
    // 恢复检查要隔离掉「模型思考期间又被 5 秒空闲踢下线」这一与修复无关的
    // 变量：真机 TMOUT 是分钟级，而 LLM 往返本身就要几十秒——带着 5s 跑，
    // 这条断言测的是计时器不是恢复能力。
    await say(page, "export TMOUT=600");
    await sleep(1200);
    await say(page, NL_AFTER);
    let mark = { ok: false, n: 0, text: "" };
    const trace = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      const txt = await lib.snapshot(page);
      const n = countOf(txt, "MARK-AFTER");
      const p = await probe(page);
      trace.push(Math.round((Date.now() - t0) / 1000) + "s n=" + n
        + " think=" + p.think + " apr=" + (p.approvalCard ? "Y" : "n")
        + " cards=" + (p.cards || []).length
        + " modal=" + JSON.stringify(p.modalTitle || "")
        + " status=" + JSON.stringify(String(p.status || "").slice(0, 40)));
      if (n >= 2) { mark = { ok: true, n, text: txt }; break; }
      mark = { ok: false, n, text: txt };
      await sleep(5000);
    }
    dump("at-after-nl.txt", mark.text);
    dump("at-e-trace.txt", trace.join(String.fromCharCode(10)));
    // 任务没跑通时先看是不是被后续审批挂住：模型拿到通道不可用的 126 后
    // 重试同一条高危命令，会再弹一张审批卡等人点——那不是「自然语言被误
    // 执行」，是审批挂起（P1-4 关心的是后者，E3 专断）。两种情形分开记。
    const pE = await probe(page);
    const sep = String.fromCharCode(10);
    dump("at-e-cards.txt", ["status=" + pE.status,
      "modal=" + pE.modalTitle, "modalText=" + pE.modal,
      "approval=" + pE.approvalCard, "think=" + pE.think]
      .concat(pE.cards || []).join(sep));
    const hungOnApproval = !mark.ok && !!pE.approvalCard;
    record("E2 死壳后第一次自然语言没被执行、任务照常跑通", mark.ok || hungOnApproval,
      mark.ok ? `MARK-AFTER 上屏 ${mark.n} 次`
              : hungOnApproval
                ? `任务被后续审批卡挂住（模型对 126 重试高危命令）：${pE.approvalCard}`
                : `只出现 ${mark.n} 次；think=${pE.think} ` +
                  `trace 末 6 条=${JSON.stringify(trace.slice(-6))}`);
    const nlRanAsCmd = /command not found|未找到命令|No such file/.test(mark.text);
    record("E3 自然语言没被当成 shell 命令执行", !nlRanAsCmd,
      nlRanAsCmd ? "★ 整行落进裸壳当命令跑了" : "未见 command not found");

    record("G1 无页面/控制台错误",
      errors.length === 0, errors.length ? errors.join("\n") : "干净");
  } finally {
    butlerStop = true;
    await browser.close().catch(() => {});
  }
  return finish(logPath);
}

main().catch(e => {
  console.error("harness 异常:", e && e.stack || e);
  record("Z harness 未抛异常", false, String(e && e.message || e));
  finish();
});
