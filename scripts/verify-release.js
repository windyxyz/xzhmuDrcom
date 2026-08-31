"use strict";

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function extractChangelogSection(changelog, version) {
  const lines = String(changelog).replace(/\r\n/g, "\n").split("\n");
  const heading = "## [" + version + "]";
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) throw new Error("CHANGELOG.md 缺少版本 " + version + " 的变更说明");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## [")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim() + "\n";
}

function verifyRelease(options = {}) {
  const projectRoot = options.projectRoot || join(__dirname, "..");
  const outputDirectory = options.outputDirectory || join(projectRoot, "dist");
  const tag = String(options.tag || "").trim();
  const packageMetadata = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(projectRoot, "CRX", "manifest.json"), "utf8"));
  if (packageMetadata.version !== manifest.version) {
    throw new Error("package.json 版本 " + packageMetadata.version + " 与 Manifest 版本 " + manifest.version + " 不一致");
  }

  const expectedTag = "v" + manifest.version;
  if (tag !== expectedTag) {
    throw new Error("标签 " + (tag || "（空）") + " 与 Manifest 版本 " + manifest.version + " 不一致；应为 " + expectedTag);
  }

  const changelogPath = join(projectRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) throw new Error("缺少 CHANGELOG.md");
  const notes = extractChangelogSection(readFileSync(changelogPath, "utf8"), manifest.version);
  const notesPath = join(outputDirectory, "release-notes.md");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(notesPath, notes, "utf8");
  return { notesPath, tag, version: manifest.version };
}

if (require.main === module) {
  const result = verifyRelease({ tag: process.argv[2] || process.env.GITHUB_REF_NAME });
  console.log("发布标签验证通过：" + result.tag);
  console.log("已生成变更说明：" + result.notesPath);
}

module.exports = { extractChangelogSection, verifyRelease };
