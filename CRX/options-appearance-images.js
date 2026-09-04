"use strict";

(() => {
  const BACKGROUND_IMAGE_BUDGET_BYTES = 1_900_000; // Chrome 内联样式单值上限约 2,048,000 字符，图片 Data URL 必须低于该值
  const BACKGROUND_SOURCE_LIMIT_BYTES = 48 * 1024 * 1024;
  const BACKGROUND_TARGET_DIMENSIONS = [2560, 2240, 1920, 1600, 1280, 960];
  const BACKGROUND_WEBP_QUALITIES = [0.92, 0.88, 0.84];

async function optimizeBackgroundImage(file) {
  const supported = ["image/png", "image/jpeg", "image/webp", "image/avif"];
  if (!supported.includes(file.type)) throw new Error("请选择 PNG、JPEG、WebP 或 AVIF 图片");
  if (file.size > BACKGROUND_SOURCE_LIMIT_BYTES) throw new Error("原图不能超过 48 MB");

  if (estimatedDataUrlSize(file.size, file.type) <= BACKGROUND_IMAGE_BUDGET_BYTES) {
    const original = await readBlobAsDataUrl(file);
    assertBackgroundImageBudget(original);
    return original;
  }

  if (typeof createImageBitmap !== "function") {
    throw new Error("当前浏览器无法自动压缩图片，请换用尺寸更小的图片");
  }

  const bitmap = await createImageBitmap(file);
  try {
    return await compressBackgroundBitmap(bitmap);
  } finally {
    bitmap.close();
  }
}

async function compressBackgroundBitmap(bitmap) {
  const sourceMax = Math.max(bitmap.width, bitmap.height);
  const dimensions = BACKGROUND_TARGET_DIMENSIONS
    .filter((dimension) => dimension < sourceMax)
    .concat(Math.min(sourceMax, BACKGROUND_TARGET_DIMENSIONS.at(-1)))
    .filter((dimension, index, values) => values.indexOf(dimension) === index);
  const canvas = document.createElement("canvas");

  for (const targetMax of dimensions) {
    const ratio = Math.min(1, targetMax / sourceMax);
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法处理这张图片");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const qualities = targetMax === dimensions.at(-1)
      ? [...BACKGROUND_WEBP_QUALITIES, 0.8, 0.76, 0.72]
      : BACKGROUND_WEBP_QUALITIES;

    for (const quality of qualities) {
      const blob = await encodeCanvas(canvas, quality);
      if (estimatedDataUrlSize(blob.size, blob.type) > BACKGROUND_IMAGE_BUDGET_BYTES) continue;
      const dataUrl = await readBlobAsDataUrl(blob);
      if (dataUrl.length <= BACKGROUND_IMAGE_BUDGET_BYTES) return dataUrl;
    }
  }

  throw new Error("图片自动压缩后仍超过 1.9 MB，请换用更简单的背景图");
}

function encodeCanvas(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("无法压缩这张图片"));
    }, "image/webp", quality);
  });
}

function estimatedDataUrlSize(blobBytes, mimeType = "image/webp") {
  const headerLength = `data:${mimeType || "image/webp"};base64,`.length;
  return headerLength + Math.ceil(Math.max(0, Number(blobBytes) || 0) / 3) * 4;
}

function assertBackgroundImageBudget(dataUrl) {
  const bytes = String(dataUrl || "").length;
  if (bytes > BACKGROUND_IMAGE_BUDGET_BYTES) {
    throw new Error("图片处理后仍然过大，请换一张尺寸更小的图片");
  }
  return bytes;
}

function formatStorageSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
  return `${Math.round(value / (1024 * 102.4)) / 10} MB`;
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(new Error("读取图片失败")), { once: true });
    reader.readAsDataURL(blob);
  });
}

  const api = {
    assertBackgroundImageBudget,
    compressBackgroundBitmap,
    encodeCanvas,
    estimatedDataUrlSize,
    formatStorageSize,
    optimizeBackgroundImage,
    readBlobAsDataUrl
  };

  globalThis.DrcomOptionsAppearanceImages = api;
  Object.assign(globalThis, api);
})();
