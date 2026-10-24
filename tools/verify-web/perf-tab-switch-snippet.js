/* 切 tab 卡顿定位探针 —— 贴进 DevTools Console，复现几次来回切换后执行 otPerf.report()
 *
 * 量的是切换链路上每一环的次数与耗时，用来区分三种嫌疑：
 *   fitMs   高 → xterm resize/重排
 *   vis/visMs 高 → onRender 逐卡 _fixHostVisibility 的强制回流
 *   drift/holdMs 高 → 逐卡 _scheduleDrift 的扣流（扣住期间终端输出停摆＝「卡住」）
 */
(() => {
  const P = {
    act: [], drift: 0, reanchor: 0, ensurePad: 0, padMs: 0,
    vis: 0, visMs: 0, fit: 0, fitMs: 0,
    hold: 0, holdMs: 0, holdMax: 0, _depth: 0, _since: 0,
  };
  window.otPerf = P;

  const wrap = (obj, name, bucket) => {
    const orig = obj[name];
    if (typeof orig !== "function" || orig.__perf) return;
    const fn = function (...args) {
      const t0 = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        const dt = performance.now() - t0;
        P[bucket] = (P[bucket] || 0) + 1;
        P[bucket + "Ms"] = (P[bucket + "Ms"] || 0) + dt;
      }
    };
    fn.__perf = true;
    obj[name] = fn;
  };

  const hookHold = (s) => {
    if (s.__holdPerf) return;
    s.__holdPerf = true;
    const oh = s._holdBytes.bind(s);
    const or = s._releaseBytes.bind(s);
    s._holdBytes = (tag) => {
      P.hold++;
      P._depth++;
      P.holdMax = Math.max(P.holdMax, P._depth);
      if (P._depth === 1) P._since = performance.now();
      return oh(tag);
    };
    s._releaseBytes = () => {
      P._depth = Math.max(0, P._depth - 1);
      if (P._depth === 0 && P._since) {
        P.holdMs += performance.now() - P._since;
        P._since = 0;
      }
      return or();
    };
  };

  P.wrap = () => {
    for (const s of Object.values(window.sessions || {})) {
      wrap(s, "fit", "fit");
      wrap(s, "_scheduleDrift", "drift");
      wrap(s, "_reanchor", "reanchor");
      wrap(s, "_ensurePad", "ensurePad");
      wrap(s, "_fixHostVisibility", "vis");
      hookHold(s);
    }
  };

  const origActivate = window.activateTab;
  if (typeof origActivate === "function" && !origActivate.__perf) {
    const fn = (id) => {
      const t0 = performance.now();
      try { return origActivate(id); }
      finally { P.act.push(performance.now() - t0); }
    };
    fn.__perf = true;
    window.activateTab = fn;
  }

  P.reset = () => {
    P.act.length = 0;
    for (const k of ["drift", "reanchor", "ensurePad", "padMs", "vis", "visMs",
                     "fit", "fitMs", "hold", "holdMs", "holdMax"]) P[k] = 0;
    P._depth = 0; P._since = 0;
  };

  P.report = () => {
    const a = [...P.act].sort((x, y) => x - y);
    const q = (f) => a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(1) : 0;
    console.log("=== 切 tab 卡顿定位 ===");
    console.log(`activateTab 同步耗时  n=${a.length}  p50=${q(.5)}ms  p95=${q(.95)}ms  max=${a.length ? a[a.length - 1].toFixed(1) : 0}ms`);
    console.log(`fit 次数=${P.fit}  累计=${P.fitMs.toFixed(1)}ms`);
    console.log(`_fixHostVisibility 次数=${P.vis}  累计=${P.visMs.toFixed(1)}ms  (强制回流嫌疑)`);
    console.log(`_scheduleDrift 次数=${P.drift}  _ensurePad 次数=${P.ensurePad} 累计=${P.padMs.toFixed(1)}ms`);
    console.log(`_reanchor 次数=${P.reanchor}`);
    console.log(`扣流 _holdBytes 次数=${P.hold}  峰值深度=${P.holdMax}  合计扣住=${P.holdMs.toFixed(1)}ms  (扣住期间终端停摆)`);
    console.log("说明：合计扣住 > 1000ms 基本就是「卡几秒」的来源；");
    console.log("      drift 次数≈卡片数×切换次数 说明是逐卡触发，需要批处理。");
    return P;
  };

  P.wrap();
  console.log("探针已装。复现几次来回切换，然后执行 otPerf.report()");
})();
