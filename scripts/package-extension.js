"use strict";

const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;
const RELEASE_FILES = [
  ["CRX/manifest.json", "manifest.json"],
  ["LICENSE", "LICENSE"],
  ["CRX/account-utils.js", "account-utils.js"],
  ["CRX/appearance.js", "appearance.js"],
  ["CRX/portal-diagnostics-utils.js", "portal-diagnostics-utils.js"],
  ["CRX/confirm-dialog.js", "confirm-dialog.js"],
  ["CRX/background.js", "background.js"],
  ["CRX/background/state-store.js", "background/state-store.js"],
  ["CRX/background/diagnostics-service.js", "background/diagnostics-service.js"],
  ["CRX/background/drcom-client.js", "background/drcom-client.js"],
  ["CRX/background/account-service.js", "background/account-service.js"],
  ["CRX/background/connection-service.js", "background/connection-service.js"],
  ["CRX/background/portal-service.js", "background/portal-service.js"],
  ["CRX/background/message-router.js", "background/message-router.js"],
  ["CRX/design-tokens.css", "design-tokens.css"],
  ["CRX/options.html", "options.html"],
  ["CRX/options.css", "options.css"],
  ["CRX/options.js", "options.js"],
  ["CRX/popup.html", "popup.html"],
  ["CRX/popup.css", "popup.css"],
  ["CRX/popup.js", "popup.js"],
  ["CRX/portal.css", "portal.css"],
  ["CRX/portal-ui.js", "portal-ui.js"],
  ["CRX/portal-diagnostics.js", "portal-diagnostics.js"],
  ["CRX/portal-modernizer.js", "portal-modernizer.js"],
  ["CRX/welcome.html", "welcome.html"],
  ["CRX/welcome.css", "welcome.css"],
  ["CRX/welcome.js", "welcome.js"]
].map(([sourcePath, archivePath]) => ({ sourcePath, archivePath }));

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

function makeLocalHeader(nameBuffer, content, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(content.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function makeCentralHeader(nameBuffer, content, checksum, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(content.length, 20);
  header.writeUInt32LE(content.length, 24);
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
    const localHeader = makeLocalHeader(nameBuffer, entry.content, checksum);
    const centralHeader = makeCentralHeader(nameBuffer, entry.content, checksum, localOffset);

    localParts.push(localHeader, nameBuffer, entry.content);
    centralParts.push(centralHeader, nameBuffer);
    localOffset += localHeader.length + nameBuffer.length + entry.content.length;
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
  const version = readVersion(projectRoot);
  const entries = RELEASE_FILES.map((entry) => {
    const absolutePath = join(projectRoot, ...entry.sourcePath.split("/"));
    if (!existsSync(absolutePath)) {
      throw new Error(`打包白名单文件不存在：${entry.sourcePath}`);
    }
    return { ...entry, content: readFileSync(absolutePath) };
  });
  const zipBuffer = createZip(entries);
  const sha256 = createHash("sha256").update(zipBuffer).digest("hex");
  const fileName = `drcom-xuzhou-medical-${version}.zip`;
  const checksumName = `drcom-xuzhou-medical-${version}.sha256`;
  const zipPath = join(outputDirectory, fileName);
  const checksumPath = join(outputDirectory, checksumName);

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(zipPath, zipBuffer);
  writeFileSync(checksumPath, `${sha256}  ${fileName}\n`, "utf8");

  return { checksumName, checksumPath, fileName, sha256, zipPath };
}

if (require.main === module) {
  const result = buildPackage();
  console.log(`已生成 ${result.zipPath}`);
  console.log(`SHA-256 ${result.sha256}`);
}

module.exports = {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  RELEASE_FILES,
  buildPackage,
  createZip,
  crc32
};
