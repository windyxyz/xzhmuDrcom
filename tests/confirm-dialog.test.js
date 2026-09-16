"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createController } = require("../CRX/confirm-dialog.js");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.textContent = "";
    this.open = false;
    this.focused = false;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {
    this.focused = true;
  }
}

function createElements() {
  return {
    dialog: new FakeTarget(),
    title: new FakeTarget(),
    message: new FakeTarget(),
    cancelButton: new FakeTarget(),
    confirmButton: new FakeTarget()
  };
}

test("危险确认默认聚焦取消按钮，并在取消时返回 false", async () => {
  const elements = createElements();
  const controller = createController(elements);
  const answer = controller.ask({
    title: "删除账号？",
    message: "将删除账号“主账号”。",
    confirmLabel: "删除账号"
  });

  assert.equal(elements.dialog.open, true);
  assert.equal(elements.cancelButton.focused, true);
  assert.equal(elements.title.textContent, "删除账号？");
  assert.equal(elements.message.textContent, "将删除账号“主账号”。");
  assert.equal(elements.confirmButton.textContent, "删除账号");

  elements.cancelButton.emit("click", { isTrusted: true });
  assert.equal(await answer, false);
  assert.equal(elements.dialog.open, false);
});

test("危险确认支持 Escape 取消和显式确认", async () => {
  const elements = createElements();
  const controller = createController(elements);
  const cancelled = controller.ask({ title: "清空记录？", message: "将清空 3 条记录。" });
  let prevented = false;
  elements.dialog.emit("cancel", { isTrusted: true, preventDefault() { prevented = true; } });
  assert.equal(await cancelled, false);
  assert.equal(prevented, true);

  const confirmed = controller.ask({ title: "恢复默认？", message: "将重置设置。" });
  elements.confirmButton.emit("click", { isTrusted: true });
  assert.equal(await confirmed, true);
});

test("危险确认拒绝合成确认点击", async () => {
  const elements = createElements();
  const controller = createController(elements);
  let settled = false;
  const answer = controller.ask({ title: "保存？" }).then((value) => { settled = true; return value; });
  elements.confirmButton.emit("click", { isTrusted: false });
  await Promise.resolve();
  assert.equal(settled, false);
  elements.cancelButton.emit("click", { isTrusted: true });
  assert.equal(await answer, false);
});

test("危险确认默认值与取消按钮支持双语并能在广播后重译", async () => {
  let language = "zh-CN";
  const dictionaries = {
    "zh-CN": { confirm_default_title: "确认操作？", confirm_default_message: "此操作可能无法撤销。", confirm_default_action: "确认", cancel: "取消" },
    en: { confirm_default_title: "Confirm action?", confirm_default_message: "This action may not be reversible.", confirm_default_action: "Confirm", cancel: "Cancel" }
  };
  const elements = createElements();
  const controller = createController(elements, {
    t(key) { return dictionaries[language][key]; },
    setLanguage(next) { language = next; }
  });
  const answer = controller.ask();
  assert.equal(elements.cancelButton.textContent, "取消");
  assert.equal(elements.title.textContent, "确认操作？");

  controller.setLanguage("en");
  assert.equal(elements.cancelButton.textContent, "Cancel");
  assert.equal(elements.title.textContent, "Confirm action?");
  assert.equal(elements.message.textContent, "This action may not be reversible.");
  assert.equal(elements.confirmButton.textContent, "Confirm");
  elements.cancelButton.emit("click", { isTrusted: true });
  assert.equal(await answer, false);
});

test("默认确认框收到语言广播后立即重译当前内容", async () => {
  const listeners = [];
  const built = createElements();
  const created = [built.dialog, {}, built.title, built.message, {}, built.cancelButton, built.confirmButton];
  let index = 0;
  let language = "zh-CN";
  const dictionary = {
    "zh-CN": { confirm_default_title: "确认操作？", confirm_default_message: "此操作可能无法撤销。", confirm_default_action: "确认", cancel: "取消" },
    en: { confirm_default_title: "Confirm action?", confirm_default_message: "This action may not be reversible.", confirm_default_action: "Confirm", cancel: "Cancel" }
  };
  for (const target of created) {
    target.append ||= () => {};
    target.setAttribute ||= () => {};
  }
  const context = vm.createContext({
    chrome: { runtime: { id: "test", onMessage: { addListener(listener) { listeners.push(listener); } } } },
    document: { body: { append() {} }, createElement() { return created[index++]; } },
    DrcomI18n: { t(key) { return dictionary[language][key]; }, setLanguage(next) { language = next; } }
  });
  new vm.Script(readFileSync(join(__dirname, "..", "CRX", "confirm-dialog.js"), "utf8")).runInContext(context);
  const answer = context.DrcomConfirmDialog.ask();
  listeners[0]({ action: "language:changed", preference: "en" }, { id: "test" });
  assert.equal(built.cancelButton.textContent, "Cancel");
  assert.equal(built.title.textContent, "Confirm action?");
  built.cancelButton.emit("click", { isTrusted: true });
  assert.equal(await answer, false);
});
