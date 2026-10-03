"use strict";

const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { deflateRawSync } = require("node:zlib");

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;
/* Edge Add-ons 的包校验器会拒绝 STORE（不压缩）方式的产物，
   即使条目、CRC 与中央目录都合法也报"不是有效的 ZIP"；
   改用固定压缩级别的 DEFLATE，产物体积从约 1.06 MB 降到约 375 KB。
   deflateRawSync 对相同输入是确定性的，配合固定 DOS 时间戳
   仍能保证同一 Node 版本下重复构建字节一致。 */
const DEFLATE_LEVEL = 9;
const STORED_METHOD = 0;
const DEFLATED_METHOD = 8;
const RELEASE_FILES = [
  ["CRX/manifest.json", "manifest.json"],
  ["LICENSE", "LICENSE"],
  ["CRX/i18n-messages.js", "i18n-messages.js"],
  ["CRX/i18n.js", "i18n.js"],
  ["CRX/_locales/zh_CN/messages.json", "_locales/zh_CN/messages.json"],
  ["CRX/_locales/en/messages.json", "_locales/en/messages.json"],
  ["CRX/account-utils.js", "account-utils.js"],
  ["CRX/portal-url.js", "portal-url.js"],
  ["CRX/portal-session.js", "portal-session.js"],
  ["CRX/appearance.js", "appearance.js"],
  ["CRX/portal-diagnostics-utils.js", "portal-diagnostics-utils.js"],
  ["CRX/confirm-dialog.js", "confirm-dialog.js"],
  ["CRX/background.js", "background.js"],
  ["CRX/background/state-store.js", "background/state-store.js"],
  ["CRX/background/response-reader.js", "background/response-reader.js"],
  ["CRX/background/diagnostics-service.js", "background/diagnostics-service.js"],
  ["CRX/background/portal-context.js", "background/portal-context.js"],
  ["CRX/background/drcom-protocol.js", "background/drcom-protocol.js"],
  ["CRX/background/drcom-client.js", "background/drcom-client.js"],
  ["CRX/background/account-service.js", "background/account-service.js"],
  ["CRX/background/connection-service.js", "background/connection-service.js"],
  ["CRX/background/wallpaper-service.js", "background/wallpaper-service.js"],
  ["CRX/background/portal-service.js", "background/portal-service.js"],
  ["CRX/background/language-service.js", "background/language-service.js"],
  ["CRX/background/message-router.js", "background/message-router.js"],
  ["CRX/fonts/segoe-fluent-icons.ttf", "fonts/segoe-fluent-icons.ttf"],
  ["CRX/design-tokens.css", "design-tokens.css"],
  ["CRX/options.html", "options.html"],
  ["CRX/options.css", "options.css"],
  ["CRX/options-color-utils.js", "options-color-utils.js"],
  ["CRX/options-gateway-controller.js", "options-gateway-controller.js"],
  ["CRX/options-diagnostics-controller.js", "options-diagnostics-controller.js"],
  ["CRX/options-account-controller.js", "options-account-controller.js"],
  ["CRX/options-appearance-images.js", "options-appearance-images.js"],
  ["CRX/options-refresh-controller.js", "options-refresh-controller.js"],
  ["CRX/options-account-capture-controller.js", "options-account-capture-controller.js"],
  ["CRX/options.js", "options.js"],
  ["CRX/popup.html", "popup.html"],
  ["CRX/popup.css", "popup.css"],
  ["CRX/popup.js", "popup.js"],
  ["CRX/portal.css", "portal.css"],
  ["CRX/animated-characters.js", "animated-characters.js"],
  ["CRX/portal-ui.js", "portal-ui.js"],
  ["CRX/portal-capture.js", "portal-capture.js"],
  ["CRX/portal-diagnostics.js", "portal-diagnostics.js"],
  ["CRX/portal-modernizer.js", "portal-modernizer.js"],
  ["CRX/welcome.html", "welcome.html"],
  ["CRX/welcome.css", "welcome.css"],
  ["CRX/welcome.js", "welcome.js"]
].map(([sourcePath, archivePath]) => ({ sourcePath, archivePath }));

const RELEASE_EXCLUSIONS = new Set([
  "CRX/manifest.firefox.json",
  "CRX/portal-preview.html",
  "CRX/portal-preview.js"
]);

function listCrxFiles(projectRoot, directory = "CRX") {
  const absoluteDirectory = join(projectRoot, ...directory.split("/"));
  const files = [];

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listCrxFiles(projectRoot, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

function assertReleaseWhitelist(projectRoot) {
  const releaseSources = new Set(RELEASE_FILES.map((entry) => entry.sourcePath));
  const unexpectedFiles = listCrxFiles(projectRoot)
    .filter((sourcePath) => !releaseSources.has(sourcePath) && !RELEASE_EXCLUSIONS.has(sourcePath));

  if (unexpectedFiles.length > 0) {
    throw new Error(`打包白名单未覆盖：${unexpectedFiles.join(", ")}`);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function makeLocalHeader(nameBuffer, method, compressedSize, contentSize, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(contentSize, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function makeCentralHeader(nameBuffer, method, compressedSize, contentSize, checksum, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(contentSize, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.archivePath, "utf8");
    const checksum = crc32(entry.content);
    /* 压缩后反而更大的条目回退为 STORE，避免个别小文件出现负收益。 */
    const deflated = deflateRawSync(entry.content, { level: DEFLATE_LEVEL });
    const useDeflate = deflated.length < entry.content.length;
    const payload = useDeflate ? deflated : entry.content;
    const method = useDeflate ? DEFLATED_METHOD : STORED_METHOD;
    const localHeader = makeLocalHeader(nameBuffer, method, payload.length, entry.content.length, checksum);
    const centralHeader = makeCentralHeader(
      nameBuffer,
      method,
      payload.length,
      entry.content.length,
      checksum,
      localOffset
    );

    localParts.push(localHeader, nameBuffer, payload);
    centralParts.push(centralHeader, nameBuffer);
    localOffset += localHeader.length + nameBuffer.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function readVersion(projectRoot) {
  const packageMetadata = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(projectRoot, "CRX", "manifest.json"), "utf8"));
  if (packageMetadata.version !== manifest.version) {
    throw new Error(`package.json 版本 ${packageMetadata.version} 与 Manifest 版本 ${manifest.version} 不一致`);
  }
  return manifest.version;
}

function buildPackage(options = {}) {
  const projectRoot = options.projectRoot || join(__dirname, "..");
  const outputDirectory = options.outputDirectory || join(projectRoot, "dist");
  const target = options.target === "firefox" ? "firefox" : "chrome";
  const version = readVersion(projectRoot);
  assertReleaseWhitelist(projectRoot);
  const entries = RELEASE_FILES.map((entry) => {
    let absolutePath = join(projectRoot, ...entry.sourcePath.split("/"));
    if (!existsSync(absolutePath)) {
      throw new Error(`打包白名单文件不存在：${entry.sourcePath}`);
    }
    let content = readFileSync(absolutePath);
    if (entry.archivePath === "manifest.json") {
      if (target === "firefox") {
        /* Firefox 变体：无 key、options_ui、gecko 元数据 */
        const firefoxManifest = JSON.parse(readFileSync(join(projectRoot, "CRX", "manifest.firefox.json"), "utf8"));
        if (firefoxManifest.version !== version) {
          throw new Error(`Firefox 清单版本 ${firefoxManifest.version} 与主版本 ${version} 不一致`);
        }
        content = Buffer.from(JSON.stringify(firefoxManifest, null, 2) + "\n", "utf8");
      } else {
        /* Chrome 商店上传包不允许 key（商店会分配扩展 ID 与 key）。
           本地开发不再单独打包：直接以未打包目录加载 CRX/，其 manifest 保留 key 以维持稳定扩展 ID。 */
        const chromeManifest = JSON.parse(content.toString("utf8"));
        delete chromeManifest.key;
        content = Buffer.from(JSON.stringify(chromeManifest, null, 2) + "\n", "utf8");
      }
    }
    return { ...entry, content };
  });
  const zipBuffer = createZip(entries);
  const sha256 = createHash("sha256").update(zipBuffer).digest("hex");
  const targetLabel = target === "firefox" ? "firefox-" : "chrome-";
  const fileName = `drcom-xuzhou-medical-${targetLabel}${version}.zip`;
  const checksumName = `drcom-xuzhou-medical-${targetLabel}${version}.sha256`;
  const zipPath = join(outputDirectory, fileName);
  const checksumPath = join(outputDirectory, checksumName);

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(zipPath, zipBuffer);
  writeFileSync(checksumPath, `${sha256}  ${fileName}\n`, "utf8");

  return { checksumName, checksumPath, fileName, sha256, zipPath, target };
}

if (require.main === module) {
  const target = process.argv.includes("--firefox") ? "firefox" : "chrome";
  const result = buildPackage({ target });
  console.log(`已生成 ${result.zipPath}`);
  console.log(`SHA-256 ${result.sha256}`);
}

module.exports = {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  RELEASE_EXCLUSIONS,
  RELEASE_FILES,
  assertReleaseWhitelist,
  buildPackage,
  createZip,
  crc32
};
