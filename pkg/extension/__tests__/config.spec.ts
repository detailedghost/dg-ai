/**
 * Tests for lib/config.ts — the narration-mode coercion shared by the settings
 * page and the tour, and patchConfig's read-then-merge (the guard against a
 * long-lived dialog writing back a stale snapshot).
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

const { DEFAULTS, getConfig, getNarrationMode, patchConfig, setConfig } =
	await import("@/lib/config");

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

describe("patchConfig", () => {
	it("changes only the named field", async () => {
		await setConfig({ color: "cyan", voice: "am_puck", narration: "both" });

		await patchConfig({ narration: "captions" });

		expect(await getConfig()).toEqual({
			color: "cyan",
			voice: "am_puck",
			narration: "captions",
		});
	});

	it("keeps fields written after the caller read its snapshot", async () => {
		// The bug this exists for: a dialog reads config, the settings page then
		// saves a new color, and the dialog's later write must not revert it.
		await setConfig({ ...DEFAULTS, color: "grey" });
		const stale = await getConfig();
		await setConfig({ ...stale, color: "orange" });

		await patchConfig({ narration: "voice" });

		const cfg = await getConfig();
		expect(cfg.color).toBe("orange");
		expect(cfg.narration).toBe("voice");
	});

	it("re-reads rather than trusting the caller, unlike spreading a snapshot", async () => {
		await setConfig({ ...DEFAULTS, color: "grey" });
		const stale = await getConfig();
		await setConfig({ ...stale, color: "pink" });

		// What the old call site did — proof the spread is what loses the change.
		await setConfig({ ...stale, narration: "voice" });
		expect((await getConfig()).color).toBe("grey");

		await setConfig({ ...DEFAULTS, color: "pink" });
		await patchConfig({ narration: "voice" });
		expect((await getConfig()).color).toBe("pink");
	});
});
