/**
 * Tests for lib/config.ts — the narration-mode coercion shared by the settings
 * page and the tour, and readNarrationMode's fallback (a rejected sync-storage
 * read must not stop a display path from rendering).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

const store: Record<string, unknown> = {};
const syncGet = mock((defaults: Record<string, unknown>) =>
	Promise.resolve({ ...defaults, ...store }),
);
const syncSet = mock((cfg: Record<string, unknown>) => {
	Object.assign(store, cfg);
	return Promise.resolve();
});

mock.module("wxt/browser", () => ({
	browser: { storage: { sync: { get: syncGet, set: syncSet } } },
}));

const {
	DEFAULTS,
	getConfig,
	getNarrationMode,
	narrationModeLabel,
	readNarrationMode,
	setConfig,
} = await import("@/lib/config");

beforeEach(() => {
	for (const k of Object.keys(store)) delete store[k];
	syncGet.mockClear();
	syncSet.mockClear();
});

describe("getNarrationMode", () => {
	it("passes through every valid mode", () => {
		expect(getNarrationMode("both")).toBe("both");
		expect(getNarrationMode("voice")).toBe("voice");
		expect(getNarrationMode("captions")).toBe("captions");
	});

	it("falls back to the default for empty or unknown input", () => {
		expect(getNarrationMode("")).toBe(DEFAULTS.narration);
		expect(getNarrationMode("invalid")).toBe(DEFAULTS.narration);
		expect(getNarrationMode("BOTH")).toBe(DEFAULTS.narration);
	});
});

describe("getConfig", () => {
	it("returns defaults when nothing is stored", async () => {
		expect(await getConfig()).toEqual(DEFAULTS);
	});

	it("returns stored values over defaults", async () => {
		await setConfig({ ...DEFAULTS, color: "cyan", voice: "am_puck" });
		const cfg = await getConfig();
		expect(cfg.color).toBe("cyan");
		expect(cfg.voice).toBe("am_puck");
	});
});

describe("narrationModeLabel", () => {
	it("gives each mode the label the settings page shows", () => {
		expect(narrationModeLabel("both")).toBe("Voiceover + captions");
		expect(narrationModeLabel("voice")).toBe("Voiceover only");
		expect(narrationModeLabel("captions")).toBe("Captions only (silent)");
	});
});

describe("readNarrationMode", () => {
	it("returns the stored mode", async () => {
		await setConfig({ ...DEFAULTS, narration: "captions" });
		expect(await readNarrationMode()).toBe("captions");
	});

	it("coerces a stored value that is no longer a valid mode", async () => {
		Object.assign(store, { narration: "subtitles" });
		expect(await readNarrationMode()).toBe(DEFAULTS.narration);
	});

	// The prompt that renders this is the only way to start a recording, so a failed
	// read has to degrade to the default instead of taking the dialog down with it.
	it("falls back to the default when sync storage rejects", async () => {
		syncGet.mockImplementationOnce(() =>
			Promise.reject(new Error("sync unavailable")),
		);
		expect(await readNarrationMode()).toBe(DEFAULTS.narration);
	});
});
