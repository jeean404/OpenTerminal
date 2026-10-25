const { chromium } = require("playwright");

(async () => {
  const BASE = "http://127.0.0.1:8177";
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
          events: ev.concat("close"),
          code: e.code,
          reason: e.reason,
          wasClean: e.wasClean,
        });
        setTimeout(() => resolve({ events: ev.concat("timeout"), code: null }), 8000);
      });
    }, url);
    console.log(label, JSON.stringify(r));
  };

  // 建一个真 tab 当对照
  const tab = await page.evaluate(async () => {
    const r = await fetch("/api/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "local" }),
    });
    return await r.json();
  });
  console.log("created tab:", JSON.stringify(tab));

  await probe("[valid ]", `/ws/${tab.tab_id}`);
  await probe("[stale]", `/ws/deadbeef`);

  await browser.close();
})();
