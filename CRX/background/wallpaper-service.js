"use strict";

/* 每日壁纸：从必应获取每日一图并本地缓存（独立 storage.local 键，不占用状态预算）。
   仅在用户启用"每日壁纸"并授予 cn.bing.com 可选主机权限后才会发出网络请求。 */

const WALLPAPER_STORAGE_KEY = "drcomDailyWallpaper";
const WALLPAPER_ORIGINS = ["https://cn.bing.com/*"];
const WALLPAPER_IMAGE_MAX_BYTES = 1_400_000; // 转 Data URL 后须低于 Chrome 内联样式 ~2,048,000 字符上限
const WALLPAPER_FETCH_TIMEOUT_MS = 10000;

let wallpaperFlight = null;

function wallpaperToday(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function readWallpaperCache() {
  try {
    const stored = await chrome.storage.local.get([WALLPAPER_STORAGE_KEY]);
    const value = stored && stored[WALLPAPER_STORAGE_KEY];
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    return null;
  }
}

async function writeWallpaperCache(cache) {
  try {
    await chrome.storage.local.set({ [WALLPAPER_STORAGE_KEY]: cache });
  } catch (error) {}
}

async function isWallpaperPermissionGranted() {
  const permissions = chrome.permissions;
  if (!permissions || typeof permissions.contains !== "function") return true;
  try {
    return await permissions.contains({ origins: WALLPAPER_ORIGINS });
  } catch (error) {
    return false;
  }
}

function wallpaperTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, done: () => clearTimeout(timer) };
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function fetchWallpaperImage(imageUrl) {
  const { controller, done } = wallpaperTimeoutController(WALLPAPER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob || blob.size > WALLPAPER_IMAGE_MAX_BYTES || !blob.size) return null;
    const buffer = await blob.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > WALLPAPER_IMAGE_MAX_BYTES) return null;
    const type = wallpaperMimeFromSignature(new Uint8Array(buffer));
    if (!type) return null;
    return `data:${type};base64,${bytesToBase64(buffer)}`;
  } catch (error) {
    return null;
  } finally {
    done();
  }
}

function wallpaperMimeFromSignature(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) {
    return "image/png";
  }
  if (bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}

async function fetchDailyWallpaper(now = new Date()) {
  const { controller, done } = wallpaperTimeoutController(WALLPAPER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch("https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1", {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const entry = payload && Array.isArray(payload.images) ? payload.images[0] : null;
    const urlbase = entry && typeof entry.urlbase === "string" ? entry.urlbase : "";
    if (!urlbase) return null;
    const base = new URL(urlbase, "https://cn.bing.com/");
    if (base.origin !== "https://cn.bing.com") return null;
    return await fetchWallpaperImage(`${base.toString()}_1920x1080.jpg`);
  } catch (error) {
    return null;
  } finally {
    done();
  }
}

function wallpaperResult(dataUrl) {
  return dataUrl
    ? { ok: true, dataUrl, day: wallpaperToday() }
    : { ok: false, dataUrl: "" };
}

async function requestDailyWallpaper() {
  if (wallpaperFlight) return wallpaperFlight;
  wallpaperFlight = (async () => {
    const today = wallpaperToday();
    const cached = await readWallpaperCache();
    if (cached && cached.day === today && typeof cached.dataUrl === "string" && cached.dataUrl) {
      return wallpaperResult(cached.dataUrl);
    }
    if (!await isWallpaperPermissionGranted()) {
      return { ok: false, dataUrl: "", reason: "permission" };
    }
    const dataUrl = await fetchDailyWallpaper();
    if (dataUrl) await writeWallpaperCache({ day: today, dataUrl, fetchedAt: Date.now() });
    return wallpaperResult(dataUrl);
  })();
  try {
    return await wallpaperFlight;
  } finally {
    wallpaperFlight = null;
  }
}

async function clearWallpaperCache() {
  try {
    await chrome.storage.local.remove([WALLPAPER_STORAGE_KEY]);
  } catch (error) {}
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    WALLPAPER_ORIGINS,
    WALLPAPER_IMAGE_MAX_BYTES,
    bytesToBase64,
    clearWallpaperCache,
    fetchDailyWallpaper,
    requestDailyWallpaper,
    wallpaperMimeFromSignature,
    wallpaperToday
  };
}
