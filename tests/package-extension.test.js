"use strict";

const assert = require("node:assert/strict");
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const test = require("node:test");

const {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  RELEASE_FILES,
  buildPackage
} = require("../scripts/package-extension.js");

function readCentralDirectory(zipBuffer) {
  const entries = [];
  for (let offset = 0; offset <= zipBuffer.length - 46; offset += 1) {
    if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = zipBuffer.readUInt16LE(offset + 28);
    const extraLength = zipBuffer.readUInt16LE(offset + 30);
    const commentLength = zipBuffer.readUInt16LE(offset + 32);
    entries.push({
      name: zipBuffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
      method: zipBuffer.readUInt16LE(offset + 10),
      dosTime: zipBuffer.readUInt16LE(offset + 12),
      dosDate: zipBuffer.readUInt16LE(offset + 14)
    });
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readStoredZipEntry(zipBuffer, wantedName) {
  for (let offset = 0; offset <= zipBuffer.length - 30;) {
    if (zipBuffer.readUInt32LE(offset) !== 0x04034b50) break;
    const contentLength = zipBuffer.readUInt32LE(offset + 18);
    const nameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = zipBuffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === wantedName) {
      return zipBuffer.subarray(contentStart, contentStart + contentLength);
    }
    offset = contentStart + contentLength;
  }
  throw new Error("ZIP 中缺少文件：" + wantedName);
}

function buildAndRead(target) {
  const projectRoot = join(__dirname, "..");
  const outputDirectory = mkdtempSync(join(tmpdir(), "drcom-browser-locales-"));
  const result = buildPackage({ projectRoot, outputDirectory, target });
  const zipBuffer = readFileSync(result.zipPath);

  return {
    text(path) {
      return readStoredZipEntry(zipBuffer, path).toString("utf8");
    },
    cleanup() {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  };
}

test("诊断运行时模块以依赖顺序进入分发白名单", () => {
  const archivePaths = RELEASE_FILES.map((entry) => entry.archivePath);
  const expected = [
    "portal-session.js",
    "portal-diagnostics-utils.js",
    "background/diagnostics-service.js",
    "background/portal-context.js",
    "portal-diagnostics.js"
  ];
  let previousIndex = -1;

  for (const path of expected) {
    const currentIndex = archivePaths.indexOf(path);
    assert.ok(currentIndex > previousIndex, `${path} must be packaged after its dependencies`);
    previousIndex = currentIndex;
  }
});

test("扩展 ZIP 只包含固定顺序的运行白名单并排除预览与源码文件", () => {
  const projectRoot = join(__dirname, "..");
  const outputDirectory = mkdtempSync(join(tmpdir(), "drcom-package-"));

  try {
    const result = buildPackage({ projectRoot, outputDirectory });
    const zipBuffer = readFileSync(result.zipPath);
    const entries = readCentralDirectory(zipBuffer);
    const expected = RELEASE_FILES
      .filter((entry) => !entry.optional)
      .map((entry) => entry.archivePath);

    assert.deepEqual(entries.map((entry) => entry.name), expected);
    assert.ok(entries.every((entry) => entry.method === 0), "固定使用 STORE 方法，避免压缩器版本导致结果漂移");
    assert.ok(entries.every((entry) => entry.dosTime === FIXED_DOS_TIME));
    assert.ok(entries.every((entry) => entry.dosDate === FIXED_DOS_DATE));
    assert.ok(!entries.some((entry) => entry.name.includes("portal-preview")));
    assert.ok(!entries.some((entry) => entry.name.startsWith("tests/")));
    assert.ok(!entries.some((entry) => entry.name.startsWith("docs/")));
    assert.ok(entries.some((entry) => entry.name === "LICENSE"), "分发包必须随附 GPL-3.0 许可证");
    assert.match(readFileSync(result.checksumPath, "utf8"), new RegExp(`^[a-f0-9]{64}  ${result.fileName}\\n$`));
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});
test("CRX 目录出现未列入分发白名单的文件时拒绝打包", () => {
  const sourceRoot = join(__dirname, "..");
  const projectRoot = mkdtempSync(join(tmpdir(), "drcom-package-source-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "drcom-package-"));
  const unexpectedPath = join(projectRoot, "CRX", "accidental-secret.txt");

  try {
    copyFileSync(join(sourceRoot, "package.json"), join(projectRoot, "package.json"));
    for (const entry of RELEASE_FILES) {
      const sourcePath = join(sourceRoot, ...entry.sourcePath.split("/"));
      const fixturePath = join(projectRoot, ...entry.sourcePath.split("/"));
      mkdirSync(dirname(fixturePath), { recursive: true });
      copyFileSync(sourcePath, fixturePath);
    }
    writeFileSync(unexpectedPath, "must not ship\n", "utf8");

    assert.throws(
      () => buildPackage({ projectRoot, outputDirectory }),
      /打包白名单未覆盖：CRX\/accidental-secret\.txt/
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("相同源码重复打包会生成逐字节一致的 ZIP 与 SHA-256", () => {
  const projectRoot = join(__dirname, "..");
  const firstDirectory = mkdtempSync(join(tmpdir(), "drcom-package-a-"));
  const secondDirectory = mkdtempSync(join(tmpdir(), "drcom-package-b-"));

  try {
    const first = buildPackage({ projectRoot, outputDirectory: firstDirectory });
    const second = buildPackage({ projectRoot, outputDirectory: secondDirectory });

    assert.deepEqual(readFileSync(first.zipPath), readFileSync(second.zipPath));
    assert.equal(first.sha256, second.sha256);
    assert.equal(readFileSync(first.checksumPath, "utf8"), readFileSync(second.checksumPath, "utf8"));
  } finally {
    rmSync(firstDirectory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test("Chrome 与 Firefox 分发包使用各自的安全清单", () => {
  const projectRoot = join(__dirname, "..");
  const outputDirectory = mkdtempSync(join(tmpdir(), "drcom-browser-manifests-"));

  try {
    const chromePackage = buildPackage({ projectRoot, outputDirectory, target: "chrome" });
    const firefoxPackage = buildPackage({ projectRoot, outputDirectory, target: "firefox" });
    const chromeManifest = JSON.parse(readStoredZipEntry(readFileSync(chromePackage.zipPath), "manifest.json"));
    const firefoxManifest = JSON.parse(readStoredZipEntry(readFileSync(firefoxPackage.zipPath), "manifest.json"));

    assert.equal(Object.hasOwn(chromeManifest, "key"), false);
    assert.equal(Object.hasOwn(firefoxManifest, "key"), false);
    assert.equal(Object.hasOwn(firefoxManifest, "options_page"), false);
    assert.equal(firefoxManifest.options_ui.page, "options.html");
    assert.equal(firefoxManifest.browser_specific_settings.gecko.id, "xzhmu-campus-net@xzhmu.local");
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("语言服务及其本地化依赖会在两个浏览器包中按路由前的顺序加载", () => {
  const archivePaths = RELEASE_FILES.map((entry) => entry.archivePath);
  for (const path of ["i18n-messages.js", "i18n.js", "background/language-service.js", "background/message-router.js"]) {
    assert.notEqual(archivePaths.indexOf(path), -1, `${path} must be distributed`);
  }

  const firefoxArchive = buildAndRead("firefox");
  try {
    const scripts = JSON.parse(firefoxArchive.text("manifest.json")).background.scripts;
    assert.ok(scripts.indexOf("i18n-messages.js") < scripts.indexOf("i18n.js"));
    assert.ok(scripts.indexOf("i18n.js") < scripts.indexOf("background/language-service.js"));
    assert.ok(scripts.indexOf("background/language-service.js") < scripts.indexOf("background/message-router.js"));
  } finally {
    firefoxArchive.cleanup();
  }
});

test("双浏览器包声明并收录中英文语言资源", () => {
  for (const target of ["chrome", "firefox"]) {
    const archive = buildAndRead(target);
    try {
      const manifest = JSON.parse(archive.text("manifest.json"));
      assert.equal(manifest.default_locale, "zh_CN");
      assert.equal(manifest.name, "__MSG_extensionName__");
      assert.equal(JSON.parse(archive.text("_locales/zh_CN/messages.json")).extensionName.message, "徐医校园网xzhmu");
      assert.equal(JSON.parse(archive.text("_locales/en/messages.json")).extensionName.message, "XZHMU Campus Network");
    } finally {
      archive.cleanup();
    }
  }
});
