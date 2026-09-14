(function (root, factory) {
  "use strict";
  const messages = factory();
  if (typeof module === "object" && module.exports) module.exports = messages;
  root.DrcomI18nMessages = messages;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  return Object.freeze({
    "zh-CN": Object.freeze({
      gateway_open: "打开 $1 并登录",
      language_switch: "语言 / Language",
      unsafe_test: "<img src=x onerror=alert(1)>",
      zh_only_test: "仅中文回退"
    }),
    en: Object.freeze({
      gateway_open: "Open $1 and sign in",
      language_switch: "Language / 语言",
      unsafe_test: "<img src=x onerror=alert(1)>"
    })
  });
});
