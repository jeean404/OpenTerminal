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
const WALLPAPER_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const WALLPAPER_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const WALLPAPER_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const WALLPAPER_VIDEO_TYPES = ["video/mp4", "video/webm"];
const WALLPAPER_MAX_PIXELS = 40_000_000;
const WALLPAPER_VIDEO_MAX_SECONDS = 300;
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

// 日夜一键切换：只走 applyUiTheme，壁纸是另一套状态（ot-wallpaper*），
// 这里一个字都不碰——换主题不该把用户挑好的背景图/视频顶掉。
function toggleUiTheme() {
  const current = document.documentElement.dataset.theme || "dark";
  applyUiTheme(current === "light" ? "dark" : "light");
}

function activeWallpaperImageId() {
  return wallpaperState.custom ? (wallpaperState.image || null) : null;
}

function applyUiWallpaper(wallpaper, preserveCustom = false) {
  const selected = WALLPAPER_ALL.some(([id]) => id === wallpaper) ? wallpaper : "aurora";
  document.documentElement.dataset.wallpaper = selected;
  saveWallpaperState(preserveCustom
    ? {wallpaper: selected}
    : {wallpaper: selected, custom: false});
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
  if (wallpaperState.video_paused) return false;
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

// 壁纸媒体落服务端 ~/.openterminal/wallpapers，元数据落 SQLite。浏览器**不持久化
// 任何壁纸数据**——IndexedDB / localStorage 都是浏览器私有的，换个浏览器、换个
// 配置、清一次站点数据就全没了（真机踩过：上传的 MP4 换浏览器即消失）。
async function wallpaperRequest(url, options = {}) {
  const response = await authFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || _t("请求失败 ({0})", response.status));
  return body;
}

// 哪张在用 + 铺放参数：服务端 SQLite 保管，这里只在内存留一份供热更新
let wallpaperState = {
  wallpaper: "aurora", custom: false, image: "",
  options: {fit: "cover", position: "center", opacity: 70, brightness: 100},
  video_paused: false,
};

function saveWallpaperState(patch) {
  Object.assign(wallpaperState, patch);
  return wallpaperRequest("/api/wallpapers/state", {
    method: "PUT", body: JSON.stringify(patch),
  }).catch(error => showWallpaperError(_t("保存失败：{0}", error.message)));
}

// 保存位置：默认 ~/.openterminal/wallpapers，用户可在设置里改。路径跟着服务端走
// （落 SQLite），放浏览器里没用——换个浏览器就指不到文件了。
let wallpaperDirLoaded = false;

function syncWallpaperDirInput(info, force = false) {
  const input = document.getElementById("wallpaper-dir-input");
  // 只在首次加载与保存后回填：上传过程中 loadWallpapers 会重跑，别把用户
  // 正在改的路径冲掉
  if (!input || (!force && wallpaperDirLoaded)) return;
  wallpaperDirLoaded = true;
  // 回显**真实绝对路径**：没自定义就直接把默认目录写进值里，别让输入框只剩
  // 一个 `~/.openterminal/wallpapers` 的占位符——那是写法不是路径
  const dir = (info && info.dir) || (info && info.dir_default) || "";
  input.value = dir;
  // 占位符给**平台对的**示例（服务端算好）：Windows 是 D:/…，macOS 是 /Users/…
  input.placeholder = (info && info.dir_example) || (info && info.dir_default) || "";
}

// 保存**静默**：选完就地落库，不弹确认框也不弹文字。存不下去才报错——无声
// 失败比多一行字糟得多。
async function saveWallpapersDir(path) {
  showWallpaperError("");
  try {
    const info = await wallpaperRequest("/api/wallpapers/dir", {
      method: "PUT", body: JSON.stringify({path: path || ""}),
    });
    syncWallpaperDirInput(info, true);
    await loadWallpapers();
  } catch (error) {
    showWallpaperError(_t("保存位置更改失败：{0}", error.message));
  }
}

// 「浏览…」直接弹**系统**的文件夹对话框：路径只有服务端拿得到（浏览器对网页
// 一律不给磁盘路径），由跑在本机的服务端代开。选完就地保存，不弹确认框、不弹
// 文字；用户取消就什么都不做。弹不出来（SSH、容器、会话隔离）只把光标交给输入
// 框让他手填——不再叠任何弹框。
async function chooseWallpaperDir() {
  showWallpaperError("");
  let res = null;
  try {
    res = await wallpaperRequest(`/api/wallpapers/dir/pick?lang=${currentLang()}`, {
      method: "POST",
    });
  } catch (error) {
    res = null;                       // 接口都不通：当弹不出来处理
  }
  if (res && res.result === "picked" && res.path) {
    await saveWallpapersDir(res.path);
    return;
  }
  if (res && res.result === "cancelled") return;   // 用户自己取消的，别再折腾
  const input = document.getElementById("wallpaper-dir-input");
  if (input) input.focus();
}

function setWallpaperImages(list) {
  wallpaperImageRevision += 1;
  // url/thumbUrl 是服务端静态路由，天然支持 Range：视频拖进度条才流畅
  wallpaperImages = (list || []).map(item => ({
    id: item.id,
    name: item.name,
    kind: item.kind === "video" ? "video" : "image",
    duration: Number(item.duration) || 0,
    addedAt: item.added_at || 0,
    url: item.url,
    thumbUrl: item.thumb_url || item.url,
  }));
  renderWallpaperGallery();
}

async function loadWallpapers() {
  try {
    const data = await wallpaperRequest("/api/wallpapers");
    if (data.state) {
      wallpaperState = {
        wallpaper: data.state.wallpaper || "aurora",
        custom: Boolean(data.state.custom),
        image: data.state.image || "",
        options: data.state.options || wallpaperState.options,
        video_paused: Boolean(data.state.video_paused),
      };
    }
    // 先回填保存位置再画图库：图库渲染抛异常不该把路径一起带没
    syncWallpaperDirInput(data);
    setWallpaperImages(data.wallpapers);
  } catch (error) {
    showWallpaperError(_t("读取本地背景图片失败：{0}", error.message));
  }
}

function syncWallpaperVideoToggle() {
  const play = document.getElementById("wallpaper-video-play");
  if (play) play.checked = !wallpaperState.video_paused;
}

// --- 一次性迁移：旧版把媒体放 IndexedDB、状态放 localStorage（都是浏览器
// 私有的，换个浏览器就没了）。搬到服务端后清掉，免得两份数据打架。 ---
const LEGACY_STATE_KEYS = ["ot-wallpaper", "ot-wallpaper-custom", "ot-wallpaper-image",
                           "ot-wallpaper-options", "ot-wallpaper-video-paused"];

function legacyWallpaperRequest(mode, action) {
  return new Promise(resolve => {
    if (!("indexedDB" in window)) return resolve([]);
    const request = indexedDB.open("openterminal-preferences", 1);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      let tx;
      try {
        tx = db.transaction("wallpapers", mode);
      } catch (error) {
        db.close();
        return resolve([]);
      }
      const op = action(tx.objectStore("wallpapers"));
      tx.oncomplete = () => { db.close(); resolve(op.result); };
      tx.onerror = () => { db.close(); resolve([]); };
    };
  });
}

async function migrateLegacyWallpapers() {
  const records = await legacyWallpaperRequest("readonly", store => store.getAll());
  const hasState = LEGACY_STATE_KEYS.some(key => localStorage.getItem(key) !== null);
  if (!(records || []).length && !hasState) return;   // 没旧数据就不动服务端状态

  const moved = new Map();
  for (const rec of records || []) {
    if (!rec || !(rec.blob instanceof Blob)) continue;
    try {
      const form = new FormData();
      const name = rec.name || "migrated";
      form.append("name", name);
      form.append("file", rec.blob, name);
      if (rec.thumb instanceof Blob) {
        const ext = (rec.thumb.type || "").includes("webp") ? "webp" : "jpg";
        form.append("thumb", rec.thumb, `thumb.${ext}`);
      }
      const saved = await wallpaperRequest("/api/wallpapers", {method: "POST", body: form});
      moved.set(rec.id || "custom-background", saved.id);
    } catch (error) {
      // 单条搬不动就跳过：旧数据还在，别让整次迁移卡死
    }
  }

  let options = {};
  try {
    options = JSON.parse(localStorage.getItem("ot-wallpaper-options") || "{}");
  } catch (error) { options = {}; }
  const custom = localStorage.getItem("ot-wallpaper-custom") === "true";
  const oldImage = localStorage.getItem("ot-wallpaper-image") || "custom-background";
  const patch = {
    wallpaper: localStorage.getItem("ot-wallpaper") || "aurora",
    custom,
    image: custom ? (moved.get(oldImage) || "") : "",
    options: options && typeof options === "object" ? options : {},
    video_paused: localStorage.getItem("ot-wallpaper-video-paused") === "true",
  };
  await saveWallpaperState(patch);

  await legacyWallpaperRequest("readwrite", store => store.clear());
  LEGACY_STATE_KEYS.forEach(key => localStorage.removeItem(key));
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
  saveWallpaperState({custom: true, image: id});
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
    await wallpaperRequest(`/api/wallpapers/${encodeURIComponent(id)}`, {method: "DELETE"});
  } catch (error) {
    showWallpaperError(_t("删除图片失败：{0}", error.message));
    return;
  }
  if (activeWallpaperImageId() === id) {
    saveWallpaperState({custom: false, image: ""});
    refreshWallpaperSelection();
  }
  wallpaperImages = wallpaperImages.filter(image => image.id !== id);
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
  saveWallpaperState({options: {fit, position, opacity, brightness}});
}

function loadWallpaperOptions() {
  // 参数由服务端保管（loadWallpapers 时读进内存），这里只负责回填控件
  const options = wallpaperState.options || {};
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
      const form = new FormData();
      form.append("name", file.name);
      form.append("file", file, file.name);
      if (probe.thumb) {
        // 缩略图在浏览器里顺手生成一次，随媒体一起上传——不留本地持久化
        const ext = (probe.thumb.type || "").includes("webp") ? "webp" : "jpg";
        form.append("thumb", probe.thumb, `thumb.${ext}`);
      }
      const saved = await wallpaperRequest("/api/wallpapers", {method: "POST", body: form});
      await loadWallpapers();
      lastId = saved.id;
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
// 必须等所有脚本就位再拉：本文件在 app.js 之前加载，此刻 authFetch 还没定义，
// 立刻调会静默失败——画廊空着，只有用户手动上传（脚本已加载完）才碰巧成功。
function initWallpaperStore() {
  (async () => {
    await migrateLegacyWallpapers();
    await loadWallpapers();
    applyUiWallpaper(wallpaperState.wallpaper, true);
    loadWallpaperOptions();
    syncWallpaperVideoToggle();
  })();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initWallpaperStore);
} else {
  initWallpaperStore();
}
document.getElementById("btn-settings").onclick = () => showSettings();
{
  const themeBtn = document.getElementById("btn-theme-toggle");
  if (themeBtn) {
    themeBtn.onclick = toggleUiTheme;
    // 图标跟当前主题走（暗色显示太阳=切到白天，反之月亮）
    const syncIcon = () => {
      const isLight = document.documentElement.dataset.theme === "light";
      themeBtn.classList.toggle("is-light", isLight);
      themeBtn.title = isLight ? _t("切换到深色") : _t("切换到浅色");
    };
    syncIcon();
    window.addEventListener("ot-theme-change", syncIcon);
  }
}
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
{
  const input = document.getElementById("wallpaper-dir-input");
  const save = () => saveWallpapersDir((input.value || "").trim());
  document.getElementById("btn-wallpaper-dir-browse").onclick = chooseWallpaperDir;
  // 没有「保存」按钮：系统框选完自动存；手填的路径回车/改完失焦即存
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    save();
  });
  input.addEventListener("change", save);
}
["wallpaper-fit", "wallpaper-position", "wallpaper-opacity", "wallpaper-brightness"]
  .forEach(id => {
    document.getElementById(id).addEventListener("input", applyWallpaperOptions);
    document.getElementById(id).addEventListener("change", applyWallpaperOptions);
  });
{
  const play = document.getElementById("wallpaper-video-play");
  syncWallpaperVideoToggle();
  play.addEventListener("change", () => {
    saveWallpaperState({video_paused: !play.checked});
    refreshWallpaperSelection();
  });
}
// 切到后台或用户要求减少动态时停掉解码，回来再续播
document.addEventListener("visibilitychange", refreshWallpaperSelection);
if (window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener)
  window.matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", refreshWallpaperSelection);
