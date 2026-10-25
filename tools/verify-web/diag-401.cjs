const { chromium } = require("playwright");

(async () => {
  const BASE = process.argv[2] || "http://127.0.0.1:8178";
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });

  const probe = async (label, url) => {
    const r = await page.evaluate(async (u) => {
      return await new Promise((resolve) => {
        const ws = new WebSocket(u);
        const ev = [];
        ws.onopen = () => ev.push("open");
        ws.onerror = () => ev.push("error");
        ws.onclose = (e) => resolve({
          events: ev.concat("close"), code: e.code, wasClean: e.wasClean,
        });
        setTimeout(() => resolve({ events: ev.concat("timeout"), code: null }), 8000);
      });
    }, url);
    console.log(label, JSON.stringify(r));
  };

  await probe("[no token  ]", `/ws/deadbeef`);
  await probe("[wrong tok ]", `/ws/deadbeef?token=nope`);
  await probe("[right tok ]", `/ws/deadbeef?token=secret`);
  await browser.close();
})();
