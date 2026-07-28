/**
 * Unit tests for the settings page's routing (lib/options-nav.ts) and the
 * narration-mode coercion the page shares with the tour (lib/config.ts).
 */
import { describe, expect, it } from "bun:test";
import { DEFAULTS, getNarrationMode } from "@/lib/config";
import { PAGES, resolvePage } from "@/lib/options-nav";

describe("resolvePage", () => {
	it("routes the explicit slash form", () => {
		expect(resolvePage("#/privacy")).toBe("privacy");
		expect(resolvePage("#/kudos")).toBe("kudos");
		expect(resolvePage("#/settings")).toBe("settings");
	});

	it("accepts the bare anchor form the page used before routing", () => {
		expect(resolvePage("#privacy")).toBe("privacy");
		expect(resolvePage("#kudos")).toBe("kudos");
	});

	it("defaults to settings for an empty or unknown hash", () => {
		expect(resolvePage("")).toBe("settings");
		expect(resolvePage("#")).toBe("settings");
		expect(resolvePage("#/nope")).toBe("settings");
		expect(resolvePage("#kudos-extra")).toBe("settings");
	});

	it("ignores case and surrounding whitespace", () => {
		expect(resolvePage("#/PRIVACY")).toBe("privacy");
		expect(resolvePage("#/ kudos ")).toBe("kudos");
	});

	it("exposes settings first so it is the landing view", () => {
		expect(PAGES[0]).toBe("settings");
		expect([...PAGES]).toEqual(["settings", "privacy", "kudos"]);
	});
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
	});
});
