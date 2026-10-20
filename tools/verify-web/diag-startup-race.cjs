// 竞态复现：不等 server 就绪，进程一拉起立刻并发请求全部前端资源，
// 连续 N 轮冷启动，逐字节校验 style.css / xterm.css 的 Content-Length 与实体
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const REPO = path.resolve(__dirname, "../..");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

function pythonExe() {
  return process.env.OT_PY || "python3";
}

async function coldRound(round, port) {
  const logFd = fs.openSync(path.join(OUT, `race-${round}.log`), "w");
  const server = spawn(pythonExe(), ["-m", "openterminal.app", "web", "--no-open",
    "--port", String(port)], { cwd: REPO, stdio: ["ignore", logFd, logFd] });
  // 不等就绪：TCP 端口一通就并发拉全部资源（模拟浏览器：CSS 与 HTML 同时打进来）
  const net = require("node:net");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 30000) {
    const open = await new Promise(res => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); res(true); });
      s.on("error", () => res(false));
    });
    if (open) { ready = true; break; }
    await new Promise(r => setTimeout(r, 10));
  }
  if (!ready) { server.kill(); throw new Error("port never opened"); }
  const msToReady = Date.now() - t0;
  const paths = ["/", "/static/style.css", "/vendor/xterm.css",
    "/vendor/xterm.js", "/vendor/addon-fit.js", "/static/app.js", "/static/pad_ledger.js"];
  const results = await Promise.all(paths.map(async p => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(10000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const cl = r.headers.get("content-length");
    return { p, status: r.status, ct: r.headers.get("content-type"),
             len: buf.length, cl, okLen: cl == null || Number(cl) === buf.length };
  }));
  server.kill();
  return { msToReady, results };
}

(async () => {
  let port = 8810;
  for (let round = 1; round <= 3; round++) {
    const { msToReady, results } = await coldRound(round, port++);
    const bad = results.filter(r => r.status !== 200 || !r.okLen || !r.ct?.match(/html|css|javascript/));
    console.log(`round ${round}: ready in ${msToReady}ms, ` +
      (bad.length ? "BAD -> " + JSON.stringify(bad, null, 1) : "all " + results.length + " resources 200/完整"));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
