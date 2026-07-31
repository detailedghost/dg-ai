/**
 * Tests for lib/config.ts — the narration-mode coercion shared by the settings
 * page and the tour, and readNarrationMode's fallback (a rejected sync-storage
 * read must not stop a display path from rendering).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { getVideoQuality } from "@/lib/capture-quality";

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
	voiceLabel,
	VOICES,
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

describe("videoQuality", () => {
	it("defaults to 1080p — sharper than Chrome's 720p, without 4K file sizes", () => {
		expect(DEFAULTS.videoQuality).toBe("1080p");
	});

	it("round-trips a chosen preset through storage", async () => {
		await setConfig({ ...DEFAULTS, videoQuality: "2160p" });

		expect((await getConfig()).videoQuality).toBe("2160p");
	});

	// The recorder indexes a table with this, so an unknown value must not reach it.
	it("coerces a stored value that is no longer a valid preset", () => {
		expect(getVideoQuality("4320p")).toBe(DEFAULTS.videoQuality);
		expect(getVideoQuality("")).toBe(DEFAULTS.videoQuality);
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

describe("voiceLabel", () => {
	it("reads the accent and gender out of the id prefix", () => {
		expect(voiceLabel("af_heart")).toBe("Heart — American female");
		expect(voiceLabel("am_michael")).toBe("Michael — American male");
		expect(voiceLabel("bf_emma")).toBe("Emma — British female");
		expect(voiceLabel("bm_george")).toBe("George — British male");
	});

	it("labels every shipped voice without falling back to the raw id", () => {
		for (const v of VOICES) {
			expect(voiceLabel(v)).not.toBe(v);
			expect(voiceLabel(v)).toMatch(
				/^[A-Z].* — (American|British) (female|male)$/,
			);
		}
	});

	// A future id that breaks the convention should still be selectable, just unpretty.
	it("passes through an id that doesn't match the convention", () => {
		expect(voiceLabel("zz_weird")).toBe("zz_weird");
		expect(voiceLabel("nonsense")).toBe("nonsense");
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
