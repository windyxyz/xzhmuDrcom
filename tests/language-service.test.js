"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createLanguageService } = require("../CRX/background/language-service.js");

function fakeDependencies(initialStorage = {}) {
  const values = structuredClone(initialStorage);
  const storageWrites = [];
  const runtimeMessages = [];
  const tabMessages = [];
  const storage = {
    async get(key) {
      return Object.hasOwn(values, key) ? { [key]: values[key] } : {};
    },
    async set(patch) {
      storageWrites.push(structuredClone(patch));
      Object.assign(values, structuredClone(patch));
    }
  };
  const runtime = {
    async sendMessage(message) {
      runtimeMessages.push(structuredClone(message));
    }
  };
  const tabs = {
    async query() {
      return [{ id: 7 }, { id: 9 }];
    },
    async sendMessage(tabId, message) {
      if (tabId === 9) throw new Error("No receiving end");
      tabMessages.push({ tabId, message: structuredClone(message) });
    }
  };
  return { storage, runtime, tabs, storageWrites, runtimeMessages, tabMessages };
}

test("语言服务只写独立键并广播规范值", async () => {
  const dependencies = fakeDependencies();
  const service = createLanguageService(dependencies);

  assert.equal(await service.getPreference(), "auto");
  assert.equal(await service.setPreference("en"), "en");
  assert.deepEqual(dependencies.storageWrites, [{ drcomAssistantLanguage: "en" }]);
  assert.deepEqual(dependencies.runtimeMessages, [{ action: "language:changed", preference: "en" }]);
  assert.deepEqual(dependencies.tabMessages, [{
    tabId: 7,
    message: { action: "language:changed", preference: "en" }
  }]);
});

test("语言服务将损坏的存储偏好回退为 auto", async () => {
  const service = createLanguageService(fakeDependencies({ drcomAssistantLanguage: "../../account" }));

  assert.equal(await service.getPreference(), "auto");
});

test("语言服务拒绝无效值且不写入存储", async () => {
  const dependencies = fakeDependencies();
  const service = createLanguageService(dependencies);

  await assert.rejects(() => service.setPreference("javascript:alert(1)"), /语言/);
  assert.deepEqual(dependencies.storageWrites, []);
});
