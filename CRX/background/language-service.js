(function (root, factory) {
  "use strict";
  const i18n = typeof module === "object" && module.exports
    ? require("../i18n.js")
    : root.DrcomI18n;
  const api = factory(i18n);

  if (typeof module === "object" && module.exports) module.exports = api;
  root.createLanguageService = api.createLanguageService;
  if (root.chrome && root.chrome.storage && root.chrome.storage.local) {
    root.languageService = api.createLanguageService({
      storage: root.chrome.storage.local,
      runtime: root.chrome.runtime,
      tabs: root.chrome.tabs
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (i18n) {
  "use strict";

  const LANGUAGE_STORAGE_KEY = "drcomAssistantLanguage";

  function createLanguageService({ storage, runtime, tabs }) {
    async function getPreference() {
      const stored = await storage.get(LANGUAGE_STORAGE_KEY);
      return i18n.normalizePreference(stored[LANGUAGE_STORAGE_KEY]);
    }

    async function broadcast(preference) {
      const message = { action: "language:changed", preference };
      const tasks = [
        Promise.resolve(runtime.sendMessage(message)).catch(() => undefined)
      ];
      const openTabs = await Promise.resolve(tabs.query({})).catch(() => []);

      for (const tab of openTabs) {
        if (!Number.isInteger(tab && tab.id)) continue;
        tasks.push(Promise.resolve(tabs.sendMessage(tab.id, message)).catch(() => undefined));
      }

      await Promise.all(tasks);
    }

    async function setPreference(value) {
      const preference = i18n.normalizePreference(value);
      if (typeof value !== "string" || preference !== value) {
        throw new Error("不支持的界面语言");
      }
      await storage.set({ [LANGUAGE_STORAGE_KEY]: preference });
      await broadcast(preference);
      return preference;
    }

    return { getPreference, setPreference, broadcast };
  }

  return { createLanguageService };
});
