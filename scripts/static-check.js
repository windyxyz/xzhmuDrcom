"use strict";

const { readdirSync } = require("node:fs");
const { join, relative } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = join(__dirname, "..");
const defaultRoots = [join(projectRoot, "CRX"), join(projectRoot, "scripts")];

function collectJavaScriptFiles(roots = defaultRoots) {
  const files = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(fullPath);
      }
    }
  }

  for (const root of roots) walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function runStaticCheck(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const spawn = options.spawnSyncImpl || spawnSync;
  const files = options.files || collectJavaScriptFiles(options.roots || defaultRoots);
  let failed = 0;

  for (const file of files) {
    const result = spawn(process.execPath, ["--check", file], {
      cwd: projectRoot,
      stdio: options.capture ? "pipe" : "inherit",
      encoding: options.capture ? "utf8" : undefined
    });

    if (result.error) {
      failed += 1;
      stderr.write(`${relative(projectRoot, file)}: ${result.error.message}\n`);
      continue;
    }

    if ((result.status ?? 1) !== 0) {
      failed += 1;
      if (options.capture) {
        if (result.stdout) stdout.write(result.stdout);
        if (result.stderr) stderr.write(result.stderr);
      }
    }
  }

  if (failed === 0) {
    stdout.write(`静态检查通过：${files.length} 个 JavaScript 文件。\n`);
    return 0;
  }

  stderr.write(`静态检查失败：${failed}/${files.length} 个 JavaScript 文件未通过。\n`);
  return 1;
}

if (require.main === module) {
  process.exitCode = runStaticCheck();
}

module.exports = {
  collectJavaScriptFiles,
  runStaticCheck
};
