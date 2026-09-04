"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadWallpaperService(options = {}) {
  const localStore = options.localStore || {};
  let permissionGranted = options.permissionGranted !== false;
  const fetchCalls = [];
  const context = vm.createContext({
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    console,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    String,
    Uint8Array,
    Date,
    Promise,
    fetch: async (input, init) => {
      fetchCalls.push({ url: String(input), init: init || null });
      return options.fetch(input, init);
    },
    chrome: {
      permissions: {
        async contains() {
          return permissionGranted;
        },
        setGranted(value) {
          permissionGranted = value;
        }
      },
      storage: {
        local: {
          async get(keys) {
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((key) => key in localStore).map((key) => [key, structuredClone(localStore[key])]));
          },
          async set(patch) {
            Object.assign(localStore, structuredClone(patch));
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete localStore[key];
          }
        }
      }
    }
  });
  context.chrome.permissions.setGranted = (value) => { permissionGranted = value; };
  const source = readFileSync(join(__dirname, "..", "CRX", "background", "wallpaper-service.js"), "utf8");
  new vm.Script(source, { filename: "wallpaper-service.js" }).runInContext(context);
  return { context, fetchCalls, localStore, setPermission: (value) => { permissionGranted = value; } };
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

test("同一天的壁纸缓存直接命中，不发出网络请求", async () => {
  const service = loadWallpaperService({});
  const today = service.context.wallpaperToday();
  service.localStore.drcomDailyWallpaper = { day: today, dataUrl: "data:image/jpeg;base64,AAAA" };

  const result = await service.context.requestDailyWallpaper();

  assert.equal(result.ok, true);
  assert.equal(result.dataUrl, "data:image/jpeg;base64,AAAA");
  assert.equal(service.fetchCalls.length, 0);
});

test("已授权时获取必应每日图并写入缓存", async () => {
  const service = loadWallpaperService({
    fetch: async (url) => {
      if (String(url).includes("HPImageArchive")) {
        return jsonResponse({ images: [{ urlbase: "/th?id=OHR.TestImage" }] });
      }
      return {
        ok: true,
        blob: async () => ({ size: 4, type: "application/octet-stream", arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0x00]).buffer })
      };
    }
  });

  const result = await service.context.requestDailyWallpaper();

  assert.equal(result.ok, true);
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
  const imageCall = service.fetchCalls.find((call) => call.url.includes("_1920x1080.jpg"));
  assert.ok(imageCall, "应请求 1920x1080 规格图片");
  assert.equal(service.localStore.drcomDailyWallpaper.day, service.context.wallpaperToday());
  assert.equal(service.localStore.drcomDailyWallpaper.dataUrl, result.dataUrl);
});

test("壁纸元数据拒绝非必应来源和伪装图片内容", async () => {
  for (const fixture of [
    {
      metadata: { images: [{ urlbase: "https://evil.example/collect" }] },
      image: null
    },
    {
      metadata: { images: [{ urlbase: "https://cn.bing.com.evil.example/collect" }] },
      image: null
    },
    {
      metadata: { images: [{ urlbase: "/th?id=OHR.Fake" }] },
      image: { ok: true, blob: async () => ({ size: 5, type: "image/jpeg", arrayBuffer: async () => new TextEncoder().encode("<html").buffer }) }
    }
  ]) {
    const service = loadWallpaperService({ fetch: async (url) => {
      if (String(url).includes("HPImageArchive")) return jsonResponse(fixture.metadata);
      if (!fixture.image) throw new Error("不应请求非必应图片");
      return fixture.image;
    } });
    const result = await service.context.requestDailyWallpaper();
    assert.equal(result.ok, false);
    assert.equal(service.localStore.drcomDailyWallpaper, undefined);
    assert.equal(service.fetchCalls.every((call) => new URL(call.url).origin === "https://cn.bing.com"), true);
  }
});

test("壁纸按文件签名识别 PNG、JPEG 和 WebP", async () => {
  const signatures = [
    { bytes: [0xff, 0xd8, 0xff, 0x00], type: "image/jpeg" },
    { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: "image/png" },
    { bytes: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], type: "image/webp" }
  ];
  for (const signature of signatures) {
    const service = loadWallpaperService({ fetch: async (url) => {
      if (String(url).includes("HPImageArchive")) return jsonResponse({ images: [{ urlbase: "/th?id=OHR.Valid" }] });
      const bytes = new Uint8Array(signature.bytes);
      return { ok: true, blob: async () => ({ size: bytes.byteLength, type: "", arrayBuffer: async () => bytes.buffer }) };
    } });
    const result = await service.context.requestDailyWallpaper();
    assert.match(result.dataUrl, new RegExp(`^data:${signature.type.replace("/", "\\/")};base64,`));
  }
});

test("未授权时不发起任何网络请求", async () => {
  const service = loadWallpaperService({ permissionGranted: false, fetch: async () => { throw new Error("should not fetch"); } });

  const result = await service.context.requestDailyWallpaper();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "permission");
  assert.equal(service.fetchCalls.length, 0);
});

test("接口失败或图片超限时返回不可用且不落缓存", async () => {
  const service = loadWallpaperService({
    fetch: async (url) => {
      if (String(url).includes("HPImageArchive")) {
        return jsonResponse({ images: [{ urlbase: "/th?id=OHR.Huge" }] });
      }
      return {
        ok: true,
        blob: async () => ({ size: 4 * 1024 * 1024, type: "image/jpeg", arrayBuffer: async () => new Uint8Array([1]).buffer })
      };
    }
  });

  const result = await service.context.requestDailyWallpaper();

  assert.equal(result.ok, false);
  assert.equal(service.localStore.drcomDailyWallpaper, undefined);
});
