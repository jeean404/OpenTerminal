"use strict";


function _t(key, ...args) {
  // node 测试单独 require 本文件时全局 t 不存在：回落原文，但占位符仍要替换，
  // 否则断言会拿到带 {0} 的键
  const text = (typeof t === "function") ? t(key) : key;
  if (!args.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (whole, n) =>
    args[Number(n)] === undefined ? whole : String(args[Number(n)]));
}

const UI_THEMES = new Set(["dark", "light", "midnight"]);
const WALLPAPER_DB = "openterminal-preferences";
const WALLPAPER_DB_STORE = "wallpapers";
const WALLPAPER_IMAGE_KEY = "custom-background";
const WALLPAPER_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const WALLPAPER_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
const WALLPAPER_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const WALLPAPER_VIDEO_TYPES = ["video/mp4", "video/webm"];
const WALLPAPER_MAX_PIXELS = 40_000_000;
const WALLPAPER_VIDEO_MAX_SECONDS = 300;
const WALLPAPER_VIDEO_PAUSED_KEY = "ot-wallpaper-video-paused";
const WALLPAPERS = [
  ["aurora", _t("极光"), _t("冰蓝与薄荷绿")],
  ["twilight", _t("暮色"), _t("靛蓝与紫罗兰")],
  ["ocean", _t("深海"), _t("海湾蓝与青绿")],
  ["sunset", _t("落日"), _t("珊瑚橙与玫瑰")],
  ["forest", _t("雨林"), _t("松针绿与翡翠")],
  ["desert", _t("沙丘"), _t("琥珀金与暖棕")],
  ["glacier", _t("冰川"), _t("极地蓝与银白")],
  ["blossom", _t("花影"), _t("樱粉与梅子紫")],
  ["nebula", _t("星云"), _t("太空紫与电光蓝")],
  ["graphite", _t("石墨"), _t("冷灰与柔和青蓝")],
];
const WALLPAPER_FLOW = [
  ["flow-aurora", _t("极光流动"), _t("冰蓝与翠绿缓缓游走")],
  ["flow-sunset", _t("落日流光"), _t("橙红与紫罗兰渐变")],
  ["flow-nebula", _t("星云漂移"), _t("深空紫与电光蓝")],
];
const WALLPAPER_PHOTOS = [
  ["photo:trommekilen", _t("暮色湖湾"), "trommekilen"],
  ["photo:wilderness", _t("云海山巅"), "wilderness"],
  ["photo:ida", _t("伊达山麓"), "ida"],
  ["photo:san-juan", _t("圣胡安河谷"), "san-juan"],
  ["photo:scuol", _t("阿尔卑斯"), "scuol"],
  ["photo:bayanzag-3", _t("火焰崖"), "bayanzag-3"],
].map(([id, name, file]) => ({
  id, name, builtin: true,
  url: `/static/wallpapers/${file}.jpg`,
  thumbUrl: `/static/wallpapers/${file}-thumb.jpg`,
}));
const WALLPAPER_ALL = [...WALLPAPERS, ...WALLPAPER_FLOW];
let wallpaperImages = [];
let wallpaperImageRevision = 0;
const WALLPAPER_MAX_IMAGES = 12;
const WALLPAPER_LEGACY_ID = WALLPAPER_IMAGE_KEY;

function applyUiTheme(theme) {
  const selected = UI_THEMES.has(theme) ? theme : "dark";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem("ot-theme", selected);
  document.querySelectorAll("[data-theme-choice]").forEach(button => {
    const active = button.dataset.themeChoice === selected;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-checked", String(active));
  });
  window.dispatchEvent(new Event("ot-theme-change"));
}

function activeWallpaperImageId() {
  if (localStorage.getItem("ot-wallpaper-custom") !== "true") return null;
  return localStorage.getItem("ot-wallpaper-image") || WALLPAPER_LEGACY_ID;
}

function applyUiWallpaper(wallpaper, preserveCustom = false) {
  const selected = WALLPAPER_ALL.some(([id]) => id === wallpaper) ? wallpaper : "aurora";
  document.documentElement.dataset.wallpaper = selected;
  localStorage.setItem("ot-wallpaper", selected);
  if (!preserveCustom) localStorage.setItem("ot-wallpaper-custom", "false");
  refreshWallpaperSelection();
}

function refreshWallpaperSelection() {
  const activeId = activeWallpaperImageId();
  const active = [...wallpaperImages, ...WALLPAPER_PHOTOS].find(image => image.id === activeId);
  const root = document.documentElement;
  // 视频不能进 background-image，改由 #wallpaper-video 图层播放
  const video = active && active.kind === "video" ? active : null;
  if (active && !video) root.style.setProperty("--wallpaper-image", `url("${active.url}")`);
  else root.style.removeProperty("--wallpaper-image");
  if (active) root.dataset.wallpaperActive = video ? "video" : "image";
  else delete root.dataset.wallpaperActive;
  syncWallpaperVideo(video);
  document.querySelectorAll("[data-wallpaper-choice]").forEach(button => {
    const on = !activeId && button.dataset.wallpaperChoice === root.dataset.wallpaper;
    button.classList.toggle("selected", on);
    button.setAttribute("aria-checked", String(on));
  });
  document.querySelectorAll("[data-wallpaper-image]").forEach(tile => {
    const on = tile.dataset.wallpaperImage === activeId;
    tile.classList.toggle("selected", on);
    tile.setAttribute("aria-checked", String(on));
  });
}

let wallpaperVideoElement = null;

function wallpaperVideoShouldPlay() {
  if (document.hidden) return false;
  if (localStorage.getItem(WALLPAPER_VIDEO_PAUSED_KEY) === "true") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function syncWallpaperVideo(video) {
  const element = wallpaperVideoElement
    || (wallpaperVideoElement = document.getElementById("wallpaper-video"));
  if (!element) return;
  if (!video) {
    element.pause();
    if (element.dataset.wallpaperVideo) {
      delete element.dataset.wallpaperVideo;
      element.removeAttribute("src");
      element.load();
    }
    element.hidden = true;
    return;
  }
  element.hidden = false;
  // 自动播放策略：必须在设置 src / play() 之前置为静音
  element.muted = true;
  element.loop = true;
  element.playsInline = true;
  if (element.dataset.wallpaperVideo !== video.id) {
    element.dataset.wallpaperVideo = video.id;
    element.src = video.url;
    element.load();
  }
  if (wallpaperVideoShouldPlay()) element.play().catch(() => {});
  else element.pause();
}

function indexedWallpaperRequest(mode, action) {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error(_t("此浏览器不支持本地图片存储。")));
      return;
    }
    const request = indexedDB.open(WALLPAPER_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WALLPAPER_DB_STORE))
        request.result.createObjectStore(WALLPAPER_DB_STORE);
    };
    request.onerror = () => reject(request.error || new Error(_t("无法打开本地图片存储。")));
    request.onblocked = () => reject(new Error(_t("本地图片存储正被其他页面占用，请关闭其他 OpenTerminal 页面后重试。")));
    request.onsuccess = () => {
      const db = request.result;
      let transaction;
      let operation;
      try {
        transaction = db.transaction(WALLPAPER_DB_STORE, mode);
        operation = action(transaction.objectStore(WALLPAPER_DB_STORE));
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        db.close();
        resolve(operation.result);
      };
      transaction.onerror = () => {
        const error = transaction.error || new Error(_t("本地图片存储失败。"));
        db.close();
        reject(error);
      };
      transaction.onabort = () => {
        const error = transaction.error || new Error(_t("本地图片存储已取消。"));
        db.close();
        reject(error);
      };
    };
  });
}

function readWallpaperImages() {
  return indexedWallpaperRequest("readonly", store => store.getAll());
}

function saveWallpaperImage(record) {
  return indexedWallpaperRequest("readwrite", store => store.put(record, record.id));
}

function deleteWallpaperImage(id) {
  return indexedWallpaperRequest("readwrite", store => store.delete(id));
}

function newWallpaperImageId() {
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setWallpaperImages(records) {
  wallpaperImages.forEach(image => {
    URL.revokeObjectURL(image.url);
    if (image.thumbUrl !== image.url) URL.revokeObjectURL(image.thumbUrl);
  });
  wallpaperImageRevision += 1;
  wallpaperImages = records
    .filter(record => record && record.blob instanceof Blob)
    .map(record => {
      const url = URL.createObjectURL(record.blob);
      const thumbUrl = record.thumb instanceof Blob ? URL.createObjectURL(record.thumb) : url;
      const kind = record.kind === "video" ? "video" : "image";
      // 旧版本只存了一张图，且没有 id，沿用原来的存储键
      return {id: record.id || WALLPAPER_LEGACY_ID,
              name: record.name || (kind === "video" ? _t("未命名视频") : _t("未命名图片")),
              kind, duration: Number(record.duration) || 0,
              addedAt: record.addedAt || 0, url, thumbUrl};
    })
    .sort((a, b) => b.addedAt - a.addedAt);
  renderWallpaperGallery();
}

function renderWallpaperGallery() {
  const upload = document.getElementById("wallpaper-upload");
  renderWallpaperTiles(document.getElementById("wallpaper-gallery"), wallpaperImages);
  upload.classList.toggle("disabled", wallpaperImages.length >= WALLPAPER_MAX_IMAGES);
  refreshWallpaperSelection();
}

function formatWallpaperDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function renderWallpaperTiles(gallery, images) {
  gallery.querySelectorAll("[data-wallpaper-image]").forEach(tile => tile.remove());
  images.forEach(image => {
    const isVideo = image.kind === "video";
    const tile = document.createElement("div");
    tile.className = "wallpaper-image";
    tile.tabIndex = 0;
    tile.setAttribute("role", "radio");
    tile.setAttribute("aria-label", _t("使用{0}：{1}", isVideo ? _t("视频") : _t("图片"), image.name));
    tile.dataset.wallpaperImage = image.id;
    const img = document.createElement("img");
    img.src = image.thumbUrl;
    img.alt = "";
    img.draggable = false;
    const name = document.createElement("span");
    name.className = "wallpaper-image-name";
    name.textContent = image.name;
    tile.append(img, name);
    if (isVideo) {
      const badge = document.createElement("span");
      badge.className = "wallpaper-image-kind";
      badge.textContent = image.duration ? `▶ ${formatWallpaperDuration(image.duration)}` : _t("▶ 视频");
      tile.append(badge);
    }
    if (!image.builtin) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "wallpaper-image-remove";
      remove.title = _t("删除背景");
      remove.setAttribute("aria-label", _t("删除背景：{0}", image.name));
      remove.textContent = "×";
      remove.onclick = event => {
        event.stopPropagation();
        confirmRemoveWallpaperImage(image);
      };
      tile.append(remove);
    }
    tile.onclick = () => activateWallpaperImage(image.id);
    tile.onkeydown = event => {
      if (event.target !== tile) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateWallpaperImage(image.id);
      } else if (!image.builtin && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        confirmRemoveWallpaperImage(image);
      }
    };
    gallery.appendChild(tile);
  });
}

function activateWallpaperImage(id) {
  if (![...wallpaperImages, ...WALLPAPER_PHOTOS].some(image => image.id === id)) return;
  localStorage.setItem("ot-wallpaper-custom", "true");
  localStorage.setItem("ot-wallpaper-image", id);
  refreshWallpaperSelection();
}

function confirmRemoveWallpaperImage(image) {
  const message = _t("确定删除「{0}」吗？删除后无法恢复。", image.name);
  if (typeof modalConfirm !== "function") {
    if (confirm(message)) removeWallpaperImage(image.id);
    return;
  }
  modalConfirm(_t("删除背景"), message, ok => {
    if (ok) return removeWallpaperImage(image.id);
  }, _t("删除"), _t("取消"));
}

async function removeWallpaperImage(id) {
  showWallpaperError("");
  try {
    await deleteWallpaperImage(id);
  } catch (error) {
    showWallpaperError(_t("删除图片失败：{0}", error.message));
    return;
  }
  if (activeWallpaperImageId() === id) {
    localStorage.setItem("ot-wallpaper-custom", "false");
    localStorage.removeItem("ot-wallpaper-image");
  }
  const removed = wallpaperImages.find(image => image.id === id);
  wallpaperImages = wallpaperImages.filter(image => image.id !== id);
  if (removed) {
    URL.revokeObjectURL(removed.url);
    if (removed.thumbUrl !== removed.url) URL.revokeObjectURL(removed.thumbUrl);
  }
  wallpaperImageRevision += 1;
  renderWallpaperGallery();
}

function applyWallpaperOptions() {
  const fit = document.getElementById("wallpaper-fit").value;
  const position = document.getElementById("wallpaper-position").value;
  const opacity = Number(document.getElementById("wallpaper-opacity").value);
  const brightness = Number(document.getElementById("wallpaper-brightness").value);
  const root = document.documentElement;
  root.style.setProperty("--wallpaper-repeat", fit === "repeat" ? "repeat" : "no-repeat");
  root.style.setProperty("--wallpaper-size", ({
    cover: "cover",
    contain: "contain",
    repeat: "auto",
    stretch: "100% 100%",
  })[fit]);
  // 视频图层走 object-fit：没有平铺语义，repeat 归到铺满
  root.style.setProperty("--wallpaper-object-fit", ({
    cover: "cover",
    contain: "contain",
    repeat: "cover",
    stretch: "fill",
  })[fit]);
  root.style.setProperty("--wallpaper-position", position);
  root.style.setProperty("--wallpaper-opacity", String(opacity / 100));
  root.style.setProperty("--wallpaper-brightness", `${brightness}%`);
  document.getElementById("wallpaper-opacity-value").value = `${opacity}%`;
  document.getElementById("wallpaper-opacity-value").textContent = `${opacity}%`;
  document.getElementById("wallpaper-brightness-value").value = `${brightness}%`;
  document.getElementById("wallpaper-brightness-value").textContent = `${brightness}%`;
  localStorage.setItem("ot-wallpaper-options", JSON.stringify({
    fit, position, opacity, brightness,
  }));
}

function loadWallpaperOptions() {
  let options;
  try {
    options = JSON.parse(localStorage.getItem("ot-wallpaper-options") || "{}");
  } catch (error) {
    options = {};
    showWallpaperError(_t("背景参数无法读取，已恢复默认显示方式。"));
  }
  const validFits = new Set(["cover", "contain", "repeat", "stretch"]);
  const validPositions = new Set(["center", "top", "bottom", "left", "right"]);
  document.getElementById("wallpaper-fit").value =
    validFits.has(options.fit) ? options.fit : "cover";
  document.getElementById("wallpaper-position").value =
    validPositions.has(options.position) ? options.position : "center";
  document.getElementById("wallpaper-opacity").value =
    Number.isInteger(options.opacity) ? Math.min(100, Math.max(0, options.opacity)) : 70;
  document.getElementById("wallpaper-brightness").value =
    Number.isInteger(options.brightness)
      ? Math.min(160, Math.max(40, options.brightness)) : 100;
  applyWallpaperOptions();
}

function showWallpaperError(message) {
  const error = document.getElementById("wallpaper-error");
  error.textContent = message;
  error.hidden = !message;
}

function makeWallpaperThumbCanvas(width, height) {
  const scale = Math.min(1, 360 / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

function canvasToWallpaperThumb(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.85));
}

async function makeWallpaperThumb(bitmap) {
  const canvas = makeWallpaperThumbCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvasToWallpaperThumb(canvas);
}

// HTMLVideoElement 读 videoWidth/videoHeight，不是 width/height
async function makeWallpaperVideoThumb(video) {
  const canvas = makeWallpaperThumbCanvas(video.videoWidth, video.videoHeight);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvasToWallpaperThumb(canvas);
}

function seekWallpaperVideoFrame(video, time) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", finish);
      resolve();
    };
    const timer = setTimeout(finish, 5000);
    video.addEventListener("seeked", finish);
    try {
      video.currentTime = time;
    } catch (error) {
      finish();
    }
  });
}

async function probeWallpaperImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > WALLPAPER_MAX_PIXELS)
      throw new Error(_t("图片分辨率过大，请选择低于 4000 万像素的图片。"));
    let thumb = null;
    try {
      thumb = await makeWallpaperThumb(bitmap);
    } catch (error) {
      thumb = null;
    }
    return {thumb};
  } finally {
    bitmap.close();
  }
}

function probeWallpaperVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(value);
    }
    const timer = setTimeout(() => finish(new Error(_t("视频解析超时，文件可能已损坏。"))), 20000);
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.onerror = () => finish(new Error(_t("视频无法读取，请确认是 MP4(H.264) 或 WebM 文件。")));
    video.onloadedmetadata = async () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (!width || !height) return finish(new Error(_t("视频缺少画面信息。")));
      if (width * height > WALLPAPER_MAX_PIXELS)
        return finish(new Error(_t("视频分辨率过大，请选择低于 4000 万像素的视频。")));
      if (duration > WALLPAPER_VIDEO_MAX_SECONDS)
        return finish(new Error(
          _t("视频时长 {0} 秒过长，请用 5 分钟以内、建议 30 秒左右的无缝循环片段。", Math.round(duration))));
      // 缩略图失败不阻断上传，落到「▶ 视频」文字角标
      let thumb = null;
      try {
        await seekWallpaperVideoFrame(video, Math.min(0.5, (duration || 1) / 10));
        thumb = await makeWallpaperVideoThumb(video);
      } catch (error) {
        thumb = null;
      }
      finish(null, {thumb, duration});
    };
    video.src = url;
  });
}

async function handleWallpaperUpload(files) {
  showWallpaperError("");
  const errors = [];
  let lastId = null;
  for (const file of files) {
    if (wallpaperImages.length >= WALLPAPER_MAX_IMAGES) {
      errors.push(_t("最多保存 {0} 个背景，请先删除不需要的。", WALLPAPER_MAX_IMAGES));
      break;
    }
    const kind = WALLPAPER_VIDEO_TYPES.includes(file.type) ? "video"
      : WALLPAPER_IMAGE_TYPES.includes(file.type) ? "image" : null;
    if (!kind) {
      errors.push(_t("{0}：请选择 PNG、JPEG、WebP 图片，或 MP4、WebM 视频。", file.name));
      continue;
    }
    const isVideo = kind === "video";
    const kindLabel = isVideo ? _t("视频") : _t("图片");
    const maxBytes = isVideo ? WALLPAPER_VIDEO_MAX_BYTES : WALLPAPER_IMAGE_MAX_BYTES;
    if (file.size > maxBytes) {
      errors.push(_t("{0}：{1}不能超过 {2} MB。", file.name, kindLabel, Math.round(maxBytes / 1024 / 1024)));
      continue;
    }
    let probe;
    try {
      probe = isVideo ? await probeWallpaperVideo(file) : await probeWallpaperImage(file);
    } catch (error) {
      errors.push(`${file.name}：${error.message}`);
      continue;
    }
    try {
      const record = {id: newWallpaperImageId(), blob: file, thumb: probe.thumb, name: file.name,
                      kind, duration: probe.duration || 0, addedAt: Date.now()};
      await saveWallpaperImage(record);
      setWallpaperImages([...await readWallpaperImages()]);
      lastId = record.id;
    } catch (error) {
      errors.push(_t("{0}：{1}保存失败：{2}", file.name, kindLabel, error.message));
    }
  }
  if (lastId) activateWallpaperImage(lastId);
  if (errors.length) showWallpaperError(errors.join("\n"));
  document.getElementById("wallpaper-image-input").value = "";
}

function renderWallpaperOptions() {
  [["wallpaper-options", WALLPAPERS], ["wallpaper-flow", WALLPAPER_FLOW]].forEach(([target, list]) => {
    const options = document.getElementById(target);
    options.innerHTML = list.map(([id, name, description]) => `
      <button type="button" class="wallpaper-option" data-wallpaper-choice="${id}"
        role="radio" aria-checked="false" aria-label="${name}：${description}">
        <span class="wallpaper-preview" data-wallpaper-preview="${id}"></span>
        <span class="wallpaper-name">${name}</span>
        <span class="wallpaper-description">${description}</span>
      </button>`).join("");
    options.querySelectorAll("[data-wallpaper-choice]").forEach(button => {
      button.onclick = () => applyUiWallpaper(button.dataset.wallpaperChoice);
    });
  });
  renderWallpaperTiles(document.getElementById("wallpaper-photos"), WALLPAPER_PHOTOS);
}

function showSettings(section = "general") {
  document.body.classList.add("settings-open");
  document.getElementById("settings-view").hidden = false;
  setSettingsSection(section);
}

function closeSettings() {
  document.body.classList.remove("settings-open");
  document.getElementById("settings-view").hidden = true;
}

function setSettingsSection(section) {
  document.querySelectorAll("[data-settings-section]").forEach(button => {
    const active = button.dataset.settingsSection === section;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("[data-settings-panel]").forEach(panel => {
    panel.hidden = panel.dataset.settingsPanel !== section;
  });
  // 惰性拉取：切到该分类才请求，避免一进设置就把三份列表都打一遍
  if (section === "models") showModelProfiles();
  if (section === "skills") {
    showSkillsView("list");
    loadSkills();
  }
  if (section === "tools") loadTools();
  if (section === "general") syncGeneralControls();
}

applyUiTheme(localStorage.getItem("ot-theme") || "dark");
renderWallpaperOptions();
applyUiWallpaper(localStorage.getItem("ot-wallpaper") || "aurora", true);
loadWallpaperOptions();
const initialWallpaperImageRevision = wallpaperImageRevision;
readWallpaperImages().then(records => {
  if (wallpaperImageRevision === initialWallpaperImageRevision) setWallpaperImages(records);
}).catch(error => {
  showWallpaperError(_t("读取本地背景图片失败：{0}", error.message));
});
document.getElementById("btn-settings").onclick = () => showSettings();
document.getElementById("btn-close-settings").onclick = closeSettings;
document.querySelectorAll("[data-settings-section]").forEach(button => {
  button.onclick = () => setSettingsSection(button.dataset.settingsSection);
});
document.querySelectorAll("[data-theme-choice]").forEach(button => {
  button.onclick = () => applyUiTheme(button.dataset.themeChoice);
});
document.getElementById("wallpaper-image-input").addEventListener("change", event => {
  handleWallpaperUpload([...event.target.files]);
});
{
  const upload = document.getElementById("wallpaper-upload");
  upload.addEventListener("dragover", event => {
    event.preventDefault();
    upload.classList.add("dragover");
  });
  upload.addEventListener("dragleave", () => upload.classList.remove("dragover"));
  upload.addEventListener("drop", event => {
    event.preventDefault();
    upload.classList.remove("dragover");
    handleWallpaperUpload([...event.dataTransfer.files]);
  });
}
["wallpaper-fit", "wallpaper-position", "wallpaper-opacity", "wallpaper-brightness"]
  .forEach(id => {
    document.getElementById(id).addEventListener("input", applyWallpaperOptions);
    document.getElementById(id).addEventListener("change", applyWallpaperOptions);
  });
{
  const play = document.getElementById("wallpaper-video-play");
  play.checked = localStorage.getItem(WALLPAPER_VIDEO_PAUSED_KEY) !== "true";
  play.addEventListener("change", () => {
    localStorage.setItem(WALLPAPER_VIDEO_PAUSED_KEY, String(!play.checked));
    refreshWallpaperSelection();
  });
}
// 切到后台或用户要求减少动态时停掉解码，回来再续播
document.addEventListener("visibilitychange", refreshWallpaperSelection);
if (window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener)
  window.matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", refreshWallpaperSelection);
