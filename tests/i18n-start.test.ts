import assert from "node:assert/strict";
import { test } from "node:test";
import { El, page, stored } from "./zen-dom.ts";

// startI18n reads the language the menu chose (`sb-locale`) from the store once, at load.
class Option {
	text: string;
	value: string;
	selected: boolean;
	constructor(text: string, value: string, _d: boolean, selected: boolean) {
		[this.text, this.value, this.selected] = [text, value, selected];
	}
}
const menu = new El("select");
const root = { lang: "" };
Object.assign(globalThis, { Option });
Object.defineProperty(globalThis, "navigator", { value: { languages: ["en-US"] }, configurable: true });
Object.assign(page, { documentElement: root, querySelectorAll: () => [], getElementById: () => menu });
const { startI18n } = await import("../gui/i18n.ts");
const { KEYS } = await import("../gui/prefs.ts");

test("the stored language wins over the browser's: the page's lang and the menu's selected option follow it", () => {
	stored.set(KEYS.locale, "zh-TW");
	startI18n();
	assert.equal(root.lang, "zh-TW");
	const picked = menu.kids.filter((k) => (k as unknown as Option).selected).map((k) => (k as unknown as Option).value);
	assert.deepEqual(picked, ["zh-TW"]);
});
