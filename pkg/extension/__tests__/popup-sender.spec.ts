import { describe, expect, it } from "bun:test";
import {
	isExtensionPageSender,
	isOwnPageSender,
	isPopupSender,
} from "@/lib/background/popup-sender";

const ROOT = "chrome-extension://abc/";

describe("sender gates", () => {
	it("accepts an extension page in a tab as an extension page but not as the popup", () => {
		const sender = { url: `${ROOT}review.html`, tab: { id: 3 } };

		expect(isExtensionPageSender(sender, ROOT)).toBe(true);
		expect(isPopupSender(sender, ROOT)).toBe(false);
	});

	it("accepts a tab-less extension page as the popup", () => {
		const sender = { url: `${ROOT}popup.html` };

		expect(isExtensionPageSender(sender, ROOT)).toBe(true);
		expect(isPopupSender(sender, ROOT)).toBe(true);
	});

	it("refuses a content script and a malformed sender", () => {
		const script = { url: "https://example.test/", tab: { id: 3 } };

		expect(isExtensionPageSender(script, ROOT)).toBe(false);
		expect(isPopupSender(script, ROOT)).toBe(false);
		expect(isExtensionPageSender(undefined, ROOT)).toBe(false);
		expect(isPopupSender({}, ROOT)).toBe(false);
	});
});

describe("isOwnPageSender", () => {
	const PAGE = `${ROOT}popup.html`;

	it("accepts this extension's page with or without a query or hash", () => {
		expect(isOwnPageSender({ id: "abc", url: PAGE }, "abc", PAGE)).toBe(true);
		expect(isOwnPageSender({ id: "abc", url: `${PAGE}?x=1` }, "abc", PAGE)).toBe(true);
		expect(isOwnPageSender({ id: "abc", url: `${PAGE}#top` }, "abc", PAGE)).toBe(true);
	});

	it("refuses another extension, another page, a web page, a missing id and a malformed sender", () => {
		expect(isOwnPageSender({ id: "other", url: PAGE }, "abc", PAGE)).toBe(false);
		expect(isOwnPageSender({ id: "abc", url: `${ROOT}options.html` }, "abc", PAGE)).toBe(false);
		expect(isOwnPageSender({ id: "abc", url: "https://example.test/popup.html" }, "abc", PAGE)).toBe(false);
		expect(isOwnPageSender({ url: PAGE }, undefined, PAGE)).toBe(false);
		expect(isOwnPageSender({ id: "abc" }, "abc", PAGE)).toBe(false);
		expect(isOwnPageSender(undefined, "abc", PAGE)).toBe(false);
	});
});
