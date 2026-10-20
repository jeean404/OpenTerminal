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
let wallpaperImageUrl = null;
let wallpaperImageRevision = 0;

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

function applyUiWallpaper(wallpaper, preserveCustom = false) {
  const selected = WALLPAPERS.some(([id]) => id === wallpaper) ? wallpaper : "aurora";
  document.documentElement.dataset.wallpaper = selected;
  localStorage.setItem("ot-wallpaper", selected);
  if (!preserveCustom) localStorage.setItem("ot-wallpaper-custom", "false");
  document.documentElement.style.removeProperty("--wallpaper-image");
  const useImageButton = document.getElementById("btn-use-wallpaper-image");
  if (useImageButton) {
    useImageButton.classList.remove("selected");
    useImageButton.setAttribute("aria-pressed", "false");
    useImageButton.textContent = "使用图片";
  }
  document.querySelectorAll("[data-wallpaper-choice]").forEach(button => {
    const active = button.dataset.wallpaperChoice === selected;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-checked", String(active));
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

function readWallpaperImage() {
  return indexedWallpaperRequest("readonly", store => store.get(WALLPAPER_IMAGE_KEY));
}

function saveWallpaperImage(record) {
  return indexedWallpaperRequest("readwrite",
    store => store.put(record, WALLPAPER_IMAGE_KEY));
}

function deleteWallpaperImage() {
  return indexedWallpaperRequest("readwrite",
    store => store.delete(WALLPAPER_IMAGE_KEY));
}

function setWallpaperImageRecord(record) {
  if (wallpaperImageUrl) URL.revokeObjectURL(wallpaperImageUrl);
  wallpaperImageRevision += 1;
  wallpaperImageUrl = record ? URL.createObjectURL(record.blob) : null;
  const useButton = document.getElementById("btn-use-wallpaper-image");
  const removeButton = document.getElementById("btn-remove-wallpaper-image");
  const status = document.getElementById("wallpaper-image-status");
  useButton.hidden = !record;
  removeButton.hidden = !record;
  status.textContent = record
    ? `已保存：${record.name}。图片仅保存在本浏览器。`
    : "图片仅保存在本浏览器，不会上传到服务器。";
  if (record && localStorage.getItem("ot-wallpaper-custom") === "true")
    activateCustomWallpaper();
}

function activateCustomWallpaper() {
  if (!wallpaperImageUrl) return;
  localStorage.setItem("ot-wallpaper-custom", "true");
  document.documentElement.style.setProperty("--wallpaper-image",
    `url("${wallpaperImageUrl}")`);
  const useButton = document.getElementById("btn-use-wallpaper-image");
  useButton.classList.add("selected");
  useButton.setAttribute("aria-pressed", "true");
  useButton.textContent = "正在使用";
  document.querySelectorAll("[data-wallpaper-choice]").forEach(button => {
    button.classList.remove("selected");
    button.setAttribute("aria-checked", "false");
  });
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
    Number.isInteger(options.opacity) ? Math.min(100, Math.max(0, options.opacity)) : 35;
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

async function handleWallpaperUpload(file) {
  showWallpaperError("");
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    showWallpaperError("请选择 PNG、JPEG 或 WebP 图片。");
    return;
  }
  if (file.size > WALLPAPER_IMAGE_MAX_BYTES) {
    showWallpaperError("图片不能超过 12 MB。");
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 40_000_000) {
      showWallpaperError("图片分辨率过大，请选择低于 4000 万像素的图片。");
      return;
    }
    const record = {blob: file, name: file.name};
    await saveWallpaperImage(record);
    setWallpaperImageRecord(record);
    activateCustomWallpaper();
  } catch (error) {
    showWallpaperError(`图片保存失败：${error.message}`);
  } finally {
    if (bitmap) bitmap.close();
    document.getElementById("wallpaper-image-input").value = "";
  }
}

function renderWallpaperOptions() {
  const options = document.getElementById("wallpaper-options");
  options.innerHTML = WALLPAPERS.map(([id, name, description]) => `
    <button type="button" class="wallpaper-option" data-wallpaper-choice="${id}"
      role="radio" aria-checked="false" aria-label="${name}：${description}">
      <span class="wallpaper-preview" data-wallpaper-preview="${id}"></span>
      <span class="wallpaper-name">${name}</span>
      <span class="wallpaper-description">${description}</span>
    </button>`).join("");
  options.querySelectorAll("[data-wallpaper-choice]").forEach(button => {
    button.onclick = () => applyUiWallpaper(button.dataset.wallpaperChoice);
  });
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
readWallpaperImage().then(record => {
  if (wallpaperImageRevision === initialWallpaperImageRevision &&
      record && record.blob instanceof Blob) setWallpaperImageRecord(record);
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
  handleWallpaperUpload(event.target.files[0]);
});
document.getElementById("btn-use-wallpaper-image").onclick = activateCustomWallpaper;
document.getElementById("btn-remove-wallpaper-image").onclick = async () => {
  showWallpaperError("");
  try {
    await deleteWallpaperImage();
    localStorage.setItem("ot-wallpaper-custom", "false");
    setWallpaperImageRecord(null);
    document.documentElement.style.removeProperty("--wallpaper-image");
  } catch (error) {
    showWallpaperError(`移除图片失败：${error.message}`);
  }
};
["wallpaper-fit", "wallpaper-position", "wallpaper-opacity", "wallpaper-brightness"]
  .forEach(id => {
    document.getElementById(id).addEventListener("input", applyWallpaperOptions);
    document.getElementById(id).addEventListener("change", applyWallpaperOptions);
  });
