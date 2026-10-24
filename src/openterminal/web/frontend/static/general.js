"use strict";


function _t(key, ...args) {
  // node 测试单独 require 本文件时全局 t 不存在：回落原文，但占位符仍要替换，
  // 否则断言会拿到带 {0} 的键
  const text = (typeof t === "function") ? t(key) : key;
  if (!args.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (whole, n) =>
    args[Number(n)] === undefined ? whole : String(args[Number(n)]));
}

// 通用设置：界面与终端的常用偏好。
// 与主题/背景一样存浏览器 localStorage（ot-* 前缀），改完立即对已打开的
// 终端生效——终端选项经 ot-term-options-change 事件下发给 app.js，沿用
// ot-theme-change 的既有分发约定。

const GENERAL_DEFAULTS = {
  "ot-ui-scale": "1",
  "ot-term-font-size": "13",
  "ot-term-scrollback": "5000",
  "ot-term-cursor": "block",
  "ot-term-cursor-blink": "true",
  "ot-term-copy-on-select": "false",
  "otdbg": "",
};

const GENERAL_KEYS = Object.keys(GENERAL_DEFAULTS);

// 界面字号的可用区间（倍率）
const UI_SCALE_MIN = 0.7;
const UI_SCALE_MAX = 1.5;

// ot-ui-scale 存的是倍率（0.9 / 1 / 1.15），设置页数字框显示的是百分比（90/100/115）。
// 存倍率是为了兼容旧值——老版本按倍率存过，改存百分比会让老用户字号突然跳走
function uiScale() {
  const n = Number(generalGet("ot-ui-scale"));
  if (!Number.isFinite(n)) return 1;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n));
}

function uiScalePct() {
  return Math.round(uiScale() * 100);
}

function generalGet(key) {
  const value = localStorage.getItem(key);
  return value === null || value === undefined ? GENERAL_DEFAULTS[key] : value;
}

function generalSet(key, value) {
  localStorage.setItem(key, value);
  applyGeneralSettings();
  // 落库后把控件回读一遍：选中态 / 数字框都要跟着值走，否则改完界面生效了、
  // 控件还停在旧值，看着像没生效
  syncGeneralControls();
}

function applyGeneralSettings() {
  const root = document.documentElement;
  // 界面字号交给 style.css 的 zoom（#sidebar / #settings-view）。
  // 早先写 root.style.fontSize 是空转：全站字号都是 px，实测元素字号纹丝不动
  root.style.setProperty("--ui-scale", String(uiScale()));
  const detail = {
    fontSize: Number(generalGet("ot-term-font-size")),
    scrollback: Number(generalGet("ot-term-scrollback")),
    cursorStyle: generalGet("ot-term-cursor"),
    cursorBlink: generalGet("ot-term-cursor-blink") === "true",
    copyOnSelect: generalGet("ot-term-copy-on-select") === "true",
  };
  // 挂到 window 上给 _buildTerm 用：新建终端要拿到当前偏好，光靠事件不够——
  // 页面刚加载时 app.js 还没装监听，那次 dispatch 会直接丢掉
  window.__otTermOptions = detail;
  // 终端选项交给 app.js 统一落到各 xterm 实例（与主题刷新同一条路）
  window.dispatchEvent(new CustomEvent("ot-term-options-change", { detail }));
}

function syncGeneralControls() {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };
  const check = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.checked = value;
  };
  const scaleRange = document.getElementById("general-ui-scale");
  const scaleOut = document.getElementById("general-ui-scale-value");
  if (scaleRange) {
    // 拖动中不回写滑块，免得和手指抢值；数字跟着滑块走
    if (document.activeElement !== scaleRange) scaleRange.value = String(uiScalePct());
    if (scaleOut) scaleOut.textContent = scaleRange.value + "%";
  }
  set("general-font-size", generalGet("ot-term-font-size"));
  set("general-scrollback", generalGet("ot-term-scrollback"));
  set("general-cursor", generalGet("ot-term-cursor"));
  set("general-lang", currentLang());
  check("general-cursor-blink", generalGet("ot-term-cursor-blink") === "true");
  check("general-copy-on-select", generalGet("ot-term-copy-on-select") === "true");
  check("general-debug", Boolean(generalGet("otdbg")));
  const output = document.getElementById("general-font-size-value");
  if (output) output.textContent = generalGet("ot-term-font-size");
  // seg 的选中样式只认 .on（见 style.css 的 .seg button.on），别再写 selected——
  // 那个类没有任何样式，选中项会跟未选中一模一样
  document.querySelectorAll("[data-general-lang]").forEach(button => {
    const on = button.dataset.generalLang === currentLang();
    button.classList.toggle("on", on);
    button.setAttribute("aria-checked", String(on));
  });
}

function clearGeneralPrefs() {
  GENERAL_KEYS.forEach(key => localStorage.removeItem(key));
  // 主题与背景同属「本浏览器的偏好」，一并还原，别留半个状态
  ["ot-theme", "ot-wallpaper", "ot-wallpaper-custom", "ot-wallpaper-image",
   "ot-wallpaper-options", "ot-wallpaper-video-paused"].forEach(
    key => localStorage.removeItem(key));
  applyUiTheme("dark");
  applyUiWallpaper("aurora", true);
  loadWallpaperOptions();
  applyGeneralSettings();
  syncGeneralControls();
}

function initGeneralPanel() {
  const bindSwitch = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.onchange = () => generalSet(key, String(el.checked));
  };
  const bindSelect = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.onchange = () => generalSet(key, el.value);
  };

  bindSwitch("general-cursor-blink", "ot-term-cursor-blink");
  bindSwitch("general-copy-on-select", "ot-term-copy-on-select");
  bindSwitch("general-debug", "otdbg");
  bindSelect("general-scrollback", "ot-term-scrollback");
  bindSelect("general-cursor", "ot-term-cursor");

  const font = document.getElementById("general-font-size");
  if (font) {
    const commit = () => {
      const output = document.getElementById("general-font-size-value");
      if (output) output.textContent = font.value;
      generalSet("ot-term-font-size", font.value);
    };
    font.addEventListener("input", commit);
    font.addEventListener("change", commit);
  }

  // 界面字号：拖到哪缩到哪（input 事件实时生效，不用等松手），右侧数字跟着走。
  // range 自带 min/max，不用再夹
  const scaleRange = document.getElementById("general-ui-scale");
  if (scaleRange) {
    const scaleOut = document.getElementById("general-ui-scale-value");
    const commit = () => {
      const pct = Number(scaleRange.value);
      if (scaleOut) scaleOut.textContent = String(pct) + "%";
      generalSet("ot-ui-scale", String(pct / 100));
    };
    scaleRange.addEventListener("input", commit);
    scaleRange.addEventListener("change", commit);
  }
  // 语言切换走「落盘 + 刷新」（见 i18n.js）：文案散在十几个渲染函数里，
  // 逐个挂重绘必然漏，刷新一次才真的全站换语言
  document.querySelectorAll("[data-general-lang]").forEach(button => {
    button.onclick = () => setLang(button.dataset.generalLang);
  });

  const reset = document.getElementById("btn-general-reset");
  if (reset) {
    reset.onclick = () => {
      modalConfirm(_t("清除本地偏好"), _t("将还原主题、背景与本页所有设置，且无法撤销。继续吗？"), ok => {
        if (ok) clearGeneralPrefs();
      }, _t("清除"), _t("取消"));
    };
  }

  // 页面一加载就得把存好的偏好落到位：否则 window.__otTermOptions 还是空的，
  // 新建终端拿不到字号/缓冲/光标设置（事件在 app.js 装监听之前就发完了）
  applyGeneralSettings();
  syncGeneralControls();
}

initGeneralPanel();

// 语言切换：控件文案主要靠整页文本替换，这里把选中态等再同步一遍
if (typeof onLangChange === "function") onLangChange(syncGeneralControls);
