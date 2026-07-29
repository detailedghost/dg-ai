/**
 * Cross-browser behaviour of the recording feature, kept deliberately generic — no
 * host-application selectors or fixtures, only the browser-shaped decisions.
 *
 * Covered:
 *   - videoRecordingSupported gates on the two APIs recording actually needs, so a
 *     browser missing either never registers the record gesture
 *   - shortcutsPageUrl names the page each Chromium-family browser really serves
 *   - the manifest ships the permission set tabCapture needs, per browser target
 *
 * Chrome and Brave share an engine and are exercised through the same branches here;
 * Edge differs only in the scheme it serves its extensions pages under.
 */

import { describe, expect, it } from "bun:test";
import { videoRecordingSupported } from "@/lib/features/demo-recorder";
import { shortcutsPageUrl } from "@/lib/features/demo-tour";
import config from "../wxt.config";

// Real user-agent strings. Brave deliberately reports a Chrome UA with no Brave token,
// which is exactly why it must not be detected by sniffing for a vendor name.
const UA = {
	chrome:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
	brave:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
	edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.4078.99",
	firefox:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
};

/** Swap the ambient `chrome` global for one test, then restore whatever was there. */
function withChrome<T>(stub: unknown, run: () => T): T {
	const holder = globalThis as unknown as { chrome?: unknown };
	const had = "chrome" in holder;
	const prev = holder.chrome;
	if (stub === undefined) delete holder.chrome;
	else holder.chrome = stub;
	try {
		return run();
	} finally {
		if (had) holder.chrome = prev;
		else delete holder.chrome;
	}
}

const fullSupport = {
	offscreen: { createDocument: () => undefined },
	tabCapture: { getMediaStreamId: () => undefined },
};

describe("videoRecordingSupported", () => {
	it("is true for a Chromium browser exposing offscreen and tabCapture", () => {
		expect(withChrome(fullSupport, videoRecordingSupported)).toBe(true);
	});

	// Firefox has neither API. The gesture must stay unregistered rather than throw
	// when the user presses the shortcut.
	it("is false when the offscreen API is missing", () => {
		expect(
			withChrome(
				{ tabCapture: { getMediaStreamId: () => undefined } },
				videoRecordingSupported,
			),
		).toBe(false);
	});

	it("is false when tabCapture cannot hand out a stream id", () => {
		expect(
			withChrome(
				{ offscreen: { createDocument: () => undefined } },
				videoRecordingSupported,
			),
		).toBe(false);
	});

	// getMediaStreamId specifically — tabCapture existing is not enough, since the
	// deprecated capture() shape lacks the method this feature calls.
	it("is false when tabCapture exists without getMediaStreamId", () => {
		expect(
			withChrome(
				{ offscreen: { createDocument: () => undefined }, tabCapture: {} },
				videoRecordingSupported,
			),
		).toBe(false);
	});

	it("is false with no extension APIs at all", () => {
		expect(withChrome(undefined, videoRecordingSupported)).toBe(false);
	});
});

describe("shortcutsPageUrl", () => {
	it("sends Chrome to its own extensions page", () => {
		expect(shortcutsPageUrl(UA.chrome)).toBe("chrome://extensions/shortcuts");
	});

	/**
	 * Brave ships a Chrome user agent with no Brave token, on purpose. It resolves
	 * `chrome://extensions/shortcuts` to its own scheme, so the Chrome branch is
	 * correct for it — and any attempt to detect Brave by UA string would silently
	 * fail, which is why this asserts the shared branch rather than a Brave one.
	 */
	it("sends Brave down the Chrome branch, since its UA is indistinguishable", () => {
		expect(shortcutsPageUrl(UA.brave)).toBe("chrome://extensions/shortcuts");
		expect(UA.brave.includes("Brave")).toBe(false);
	});

	it("sends Edge to the edge:// scheme it serves the page under", () => {
		expect(shortcutsPageUrl(UA.edge)).toBe("edge://extensions/shortcuts");
	});

	// Edge's UA also contains "Chrome/", so order of checks matters: a naive
	// Chrome-first test would route Edge to a page it does not serve.
	it("prefers the Edge branch even though Edge also reports Chrome", () => {
		expect(UA.edge).toContain("Chrome/");
		expect(shortcutsPageUrl(UA.edge)).not.toBe("chrome://extensions/shortcuts");
	});

	it("falls back to the Chromium page for anything unrecognised", () => {
		expect(shortcutsPageUrl(UA.firefox)).toBe("chrome://extensions/shortcuts");
		expect(shortcutsPageUrl("")).toBe("chrome://extensions/shortcuts");
	});
});

type RelevantManifest = { permissions?: string[]; host_permissions?: string[] };
const manifestFor = config.manifest as unknown as (env: {
	browser: "chrome" | "firefox";
}) => RelevantManifest;

describe("manifest permissions per target", () => {
	// Chrome and Brave load the same build, so one target covers both.
	it("gives the Chromium build every permission tabCapture needs", () => {
		const perms = manifestFor({ browser: "chrome" }).permissions ?? [];
		for (const needed of ["activeTab", "tabCapture", "offscreen", "downloads"])
			expect(perms).toContain(needed);
	});

	it("keeps capture permissions out of the Firefox build, which cannot record", () => {
		const perms = manifestFor({ browser: "firefox" }).permissions ?? [];
		for (const absent of ["activeTab", "tabCapture", "offscreen"])
			expect(perms).not.toContain(absent);
	});
});
