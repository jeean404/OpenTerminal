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

function generalGet(key) {
  const value = localStorage.getItem(key);
  return value === null || value === undefined ? GENERAL_DEFAULTS[key] : value;
}

function generalSet(key, value) {
  localStorage.setItem(key, value);
  applyGeneralSettings();
}

function applyGeneralSettings() {
  const root = document.documentElement;
  root.style.fontSize = `${Number(generalGet("ot-ui-scale")) * 100}%`;
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
  set("general-scale", generalGet("ot-ui-scale"));
  set("general-font-size", generalGet("ot-term-font-size"));
  set("general-scrollback", generalGet("ot-term-scrollback"));
  set("general-cursor", generalGet("ot-term-cursor"));
  set("general-lang", currentLang());
  check("general-cursor-blink", generalGet("ot-term-cursor-blink") === "true");
  check("general-copy-on-select", generalGet("ot-term-copy-on-select") === "true");
  check("general-debug", Boolean(generalGet("otdbg")));
  const output = document.getElementById("general-font-size-value");
  if (output) output.textContent = generalGet("ot-term-font-size");
  document.querySelectorAll("[data-general-scale]").forEach(button => {
    button.classList.toggle("selected", button.dataset.generalScale === generalGet("ot-ui-scale"));
    button.setAttribute(
      "aria-checked", String(button.dataset.generalScale === generalGet("ot-ui-scale")));
  });
  document.querySelectorAll("[data-general-lang]").forEach(button => {
    const on = button.dataset.generalLang === currentLang();
    button.classList.toggle("selected", on);
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
  bindSelect("general-scale", "ot-ui-scale");
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

  document.querySelectorAll("[data-general-scale]").forEach(button => {
    button.onclick = () => generalSet("ot-ui-scale", button.dataset.generalScale);
  });
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
