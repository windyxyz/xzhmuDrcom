"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("欢迎页主操作进入网关，次操作打开设置", () => {
  const documentListeners = {};
  const elementListeners = {};
  const updatedTabs = [];
  let optionsOpened = 0;
  const elements = new Map(
    ["open-portal", "open-options"].map((id) => [
      id,
      {
        addEventListener(type, listener) {
          elementListeners[`${id}:${type}`] = listener;
        }
      }
    ])
  );
  const context = vm.createContext({
    chrome: {
      runtime: {
        openOptionsPage() {
          optionsOpened += 1;
        }
      },
      tabs: {
        update(options) {
          updatedTabs.push(options);
        }
      }
    },
    document: {
      addEventListener(type, listener) {
        documentListeners[type] = listener;
      },
      getElementById(id) {
        return elements.get(id) || null;
      }
    }
  });
  const source = readFileSync(join(__dirname, "..", "CRX", "welcome.js"), "utf8");

  new vm.Script(source, { filename: "welcome.js" }).runInContext(context);
  documentListeners.DOMContentLoaded();
  elementListeners["open-portal:click"]();
  elementListeners["open-options:click"]();

  assert.deepEqual(JSON.parse(JSON.stringify(updatedTabs)), [{ url: "http://10.10.10.2/" }]);
  assert.equal(optionsOpened, 1);
});
