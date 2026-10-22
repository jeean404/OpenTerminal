"use strict";

const UI_THEMES = new Set(["dark", "light", "midnight"]);
const WALLPAPER_DB = "openterminal-preferences";
const WALLPAPER_DB_STORE = "wallpapers";
const WALLPAPER_IMAGE_KEY = "custom-background";
const WALLPAPER_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const WALLPAPERS = [
  ["aurora", "极光", "冰蓝与薄荷绿"],
  ["twilight", "暮色", "靛蓝与紫罗兰"],
  ["ocean", "深海", "海湾蓝与青绿"],
  ["sunset", "落日", "珊瑚橙与玫瑰"],
  ["forest", "雨林", "松针绿与翡翠"],
  ["desert", "沙丘", "琥珀金与暖棕"],
  ["glacier", "冰川", "极地蓝与银白"],
  ["blossom", "花影", "樱粉与梅子紫"],
  ["nebula", "星云", "太空紫与电光蓝"],
  ["graphite", "石墨", "冷灰与柔和青蓝"],
];
const WALLPAPER_FLOW = [
  ["flow-aurora", "极光流动", "冰蓝与翠绿缓缓游走"],
  ["flow-sunset", "落日流光", "橙红与紫罗兰渐变"],
  ["flow-nebula", "星云漂移", "深空紫与电光蓝"],
];
const WALLPAPER_PHOTOS = [
  ["photo:trommekilen", "暮色湖湾", "trommekilen"],
  ["photo:wilderness", "云海山巅", "wilderness"],
  ["photo:ida", "伊达山麓", "ida"],
  ["photo:san-juan", "圣胡安河谷", "san-juan"],
  ["photo:scuol", "阿尔卑斯", "scuol"],
  ["photo:bayanzag-3", "火焰崖", "bayanzag-3"],
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
  if (active) root.style.setProperty("--wallpaper-image", `url("${active.url}")`);
  else root.style.removeProperty("--wallpaper-image");
  if (active) root.dataset.wallpaperActive = "image";
  else delete root.dataset.wallpaperActive;
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

function indexedWallpaperRequest(mode, action) {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("此浏览器不支持本地图片存储。"));
      return;
    }
    const request = indexedDB.open(WALLPAPER_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WALLPAPER_DB_STORE))
        request.result.createObjectStore(WALLPAPER_DB_STORE);
    };
    request.onerror = () => reject(request.error || new Error("无法打开本地图片存储。"));
    request.onblocked = () => reject(new Error("本地图片存储正被其他页面占用，请关闭其他 OpenTerminal 页面后重试。"));
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
        const error = transaction.error || new Error("本地图片存储失败。");
        db.close();
        reject(error);
      };
      transaction.onabort = () => {
        const error = transaction.error || new Error("本地图片存储已取消。");
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
      // 旧版本只存了一张图，且没有 id，沿用原来的存储键
      return {id: record.id || WALLPAPER_LEGACY_ID, name: record.name || "未命名图片",
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

function renderWallpaperTiles(gallery, images) {
  gallery.querySelectorAll("[data-wallpaper-image]").forEach(tile => tile.remove());
  images.forEach(image => {
    const tile = document.createElement("div");
    tile.className = "wallpaper-image";
    tile.tabIndex = 0;
    tile.setAttribute("role", "radio");
    tile.setAttribute("aria-label", `使用图片：${image.name}`);
    tile.dataset.wallpaperImage = image.id;
    const img = document.createElement("img");
    img.src = image.thumbUrl;
    img.alt = "";
    img.draggable = false;
    const name = document.createElement("span");
    name.className = "wallpaper-image-name";
    name.textContent = image.name;
    tile.append(img, name);
    if (!image.builtin) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "wallpaper-image-remove";
      remove.title = "删除图片";
      remove.setAttribute("aria-label", `删除图片：${image.name}`);
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
  const message = `确定删除「${image.name}」吗？删除后无法恢复。`;
  if (typeof modalConfirm !== "function") {
    if (confirm(message)) removeWallpaperImage(image.id);
    return;
  }
  modalConfirm("删除图片", message, ok => {
    if (ok) return removeWallpaperImage(image.id);
  }, "删除", "取消");
}

async function removeWallpaperImage(id) {
  showWallpaperError("");
  try {
    await deleteWallpaperImage(id);
  } catch (error) {
    showWallpaperError(`删除图片失败：${error.message}`);
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
    showWallpaperError("背景参数无法读取，已恢复默认显示方式。");
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

async function makeWallpaperThumb(bitmap) {
  const scale = Math.min(1, 360 / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.85));
}

async function handleWallpaperUpload(files) {
  showWallpaperError("");
  const errors = [];
  let lastId = null;
  for (const file of files) {
    if (wallpaperImages.length >= WALLPAPER_MAX_IMAGES) {
      errors.push(`最多保存 ${WALLPAPER_MAX_IMAGES} 张图片，请先删除不需要的图片。`);
      break;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      errors.push(`${file.name}：请选择 PNG、JPEG 或 WebP 图片。`);
      continue;
    }
    if (file.size > WALLPAPER_IMAGE_MAX_BYTES) {
      errors.push(`${file.name}：图片不能超过 12 MB。`);
      continue;
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 40_000_000) {
        errors.push(`${file.name}：图片分辨率过大，请选择低于 4000 万像素的图片。`);
        continue;
      }
      let thumb = null;
      try {
        thumb = await makeWallpaperThumb(bitmap);
      } catch (error) {
        thumb = null;
      }
      const record = {id: newWallpaperImageId(), blob: file, thumb, name: file.name,
                      addedAt: Date.now()};
      await saveWallpaperImage(record);
      setWallpaperImages([...await readWallpaperImages()]);
      lastId = record.id;
    } catch (error) {
      errors.push(`${file.name}：图片保存失败：${error.message}`);
    } finally {
      if (bitmap) bitmap.close();
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

function showSettings(section = "appearance") {
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
  if (section === "models") showModelProfiles();
}

applyUiTheme(localStorage.getItem("ot-theme") || "dark");
renderWallpaperOptions();
applyUiWallpaper(localStorage.getItem("ot-wallpaper") || "aurora", true);
loadWallpaperOptions();
const initialWallpaperImageRevision = wallpaperImageRevision;
readWallpaperImages().then(records => {
  if (wallpaperImageRevision === initialWallpaperImageRevision) setWallpaperImages(records);
}).catch(error => {
  showWallpaperError(`读取本地背景图片失败：${error.message}`);
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
