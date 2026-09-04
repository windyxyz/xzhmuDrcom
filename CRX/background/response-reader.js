"use strict";

class ResponseSizeLimitError extends Error {
  constructor(limitBytes) {
    const label = limitBytes === 64 * 1024 ? "64 KiB" : limitBytes === 1024 * 1024 ? "1 MiB" : `${limitBytes} bytes`;
    super(`响应正文超过 ${label} 安全上限`);
    this.name = "ResponseSizeLimitError";
    this.limitBytes = limitBytes;
  }
}

async function readLimitedResponse(response, limitBytes, controller = null) {
  const declared = Number(response && response.headers && typeof response.headers.get === "function"
    ? response.headers.get("content-length")
    : NaN);
  if (Number.isFinite(declared) && declared > limitBytes) {
    if (controller) controller.abort();
    throw new ResponseSizeLimitError(limitBytes);
  }

  if (response && response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const parts = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value || []);
        totalBytes += value.byteLength;
        if (totalBytes > limitBytes) {
          try { await reader.cancel(); } catch (error) {}
          if (controller) controller.abort();
          throw new ResponseSizeLimitError(limitBytes);
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
  }

  const text = await response.text();
  if (new TextEncoder().encode(String(text)).byteLength > limitBytes) {
    if (controller) controller.abort();
    throw new ResponseSizeLimitError(limitBytes);
  }
  return String(text);
}
