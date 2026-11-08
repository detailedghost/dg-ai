import { describe, expect, it } from "bun:test";
import {
	isExtensionPageSender,
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
