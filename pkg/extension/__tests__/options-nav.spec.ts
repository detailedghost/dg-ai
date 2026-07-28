/** Unit tests for the settings page's routing (lib/options-nav.ts). */
import { describe, expect, it } from "bun:test";
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
