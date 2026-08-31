"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createController } = require("../CRX/confirm-dialog.js");

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

  elements.cancelButton.emit("click");
  assert.equal(await answer, false);
  assert.equal(elements.dialog.open, false);
});

test("危险确认支持 Escape 取消和显式确认", async () => {
  const elements = createElements();
  const controller = createController(elements);
  const cancelled = controller.ask({ title: "清空记录？", message: "将清空 3 条记录。" });
  let prevented = false;
  elements.dialog.emit("cancel", { preventDefault() { prevented = true; } });
  assert.equal(await cancelled, false);
  assert.equal(prevented, true);

  const confirmed = controller.ask({ title: "恢复默认？", message: "将重置设置。" });
  elements.confirmButton.emit("click");
  assert.equal(await confirmed, true);
});
