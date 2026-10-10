import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import {
  catalogs,
  resolveLocale,
  validPreference,
  translateFor,
  translate,
  setLanguagePreference,
  getLanguagePreference,
  getLocale,
  subscribeLanguage,
  translateError,
  apiErrorMessage,
  homeTitles,
} from "../apps/web/src/i18n.js";

test("Browser preference order, Chinese scripts and regional variants resolve consistently", () => {
  for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans-TW", "ZH_hans"]) {
    assert.equal(resolveLocale([tag]), "zh-Hans", tag);
  }
  for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant-CN", "zh_Hant"]) {
    assert.equal(resolveLocale([tag]), "zh-Hant", tag);
  }
  assert.equal(resolveLocale(["en-GB", "zh-TW"]), "en");
  assert.equal(resolveLocale(["ja-JP", "zh-HK", "en"]), "zh-Hant");
  assert.equal(resolveLocale(["fr-FR"]), "en");
  assert.equal(resolveLocale([]), "en");
  for (const value of [null, undefined, "", "zh-CN", "bad", "auto"])
    assert.equal(validPreference(value), "auto");
});

test("All three catalogs include the same nonempty translations and interpolation variables", () => {
  const keys = Object.keys(catalogs["zh-Hans"]).sort();
  const tokens = (value: string) =>
    [...value.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
  for (const locale of ["zh-Hans", "zh-Hant", "en"] as const) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), keys);
    for (const key of keys) {
      assert.ok(catalogs[locale][key]?.trim(), `${locale}: ${key}`);
      assert.deepEqual(
        tokens(catalogs[locale][key]!),
        tokens(key),
        `${locale}: ${key}`,
      );
    }
    for (const title of homeTitles) assert.ok(catalogs[locale][title]);
  }
});

test("Switching language notifies React subscribers; interpolation preserves user content", () => {
  const previous = getLanguagePreference();
  let updates = 0;
  const unsubscribe = subscribeLanguage(() => updates++);
  try {
    setLanguagePreference("zh-Hant");
    assert.equal(getLocale(), "zh-Hant");
    assert.equal(translate("新对话"), "新對話");
    setLanguagePreference("en");
    assert.equal(translate("新对话"), "New chat");
    const name = "新对话 / 中文資料 {count} <b>";
    assert.equal(translate("回复 {name}", { name }), `Reply to ${name}`);
    assert.equal(translateFor("en", "toString"), "toString");
    assert.equal(
      translateFor("en", "unknown source output"),
      "unknown source output",
    );
    assert.equal(updates, 2);
    unsubscribe();
    setLanguagePreference("auto");
    assert.equal(getLanguagePreference(), "auto");
    assert.equal(updates, 2);
  } finally {
    unsubscribe();
    setLanguagePreference(previous);
  }
});

test("Interface errors follow the selected language without translating unknown native output", () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    assert.equal(
      apiErrorMessage({ code: "INVALID_LOGIN", message: "密码不正确，请重试" }),
      "Incorrect password. Try again.",
    );
    assert.equal(
      apiErrorMessage({ code: "INVALID_PATH", message: "请输入绝对路径" }),
      "Enter an absolute path.",
    );
    assert.equal(
      translateError("TypeError: Failed to fetch"),
      "Could not connect. Check your network and try again.",
    );
    const storedError = apiErrorMessage({ code: "AGENT_BUSY" });
    setLanguagePreference("zh-Hant");
    assert.equal(translateError(storedError), "成員正在執行，請等待本輪完成。");
    assert.equal(
      apiErrorMessage({
        code: "NATIVE_FAILURE",
        message: "tool failed at /my/中文/project:17",
      }),
      "tool failed at /my/中文/project:17",
    );
  } finally {
    setLanguagePreference(previous);
  }
});

test("WebUI Chinese literals are catalogued and no Chinese JSX text or attributes bypass translation", () => {
  const sourceRoot = new URL("../apps/web/src/", import.meta.url);
  for (const file of readdirSync(sourceRoot).filter(
    (name) =>
      /\.tsx?$/.test(name) &&
      !["i18n.ts", "language-picker.tsx"].includes(name),
  )) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(file, sourceRoot), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isJsxText(node)) &&
        /\p{Script=Han}/u.test(node.text)
      ) {
        assert.ok(
          !ts.isJsxText(node),
          `${file}: untranslated JSX ${node.getText(source)}`,
        );
        assert.ok(
          !ts.isJsxAttribute(node.parent),
          `${file}: untranslated attribute ${node.getText(source)}`,
        );
        assert.ok(
          Object.hasOwn(catalogs.en, node.text),
          `${file}: missing key ${node.text}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
