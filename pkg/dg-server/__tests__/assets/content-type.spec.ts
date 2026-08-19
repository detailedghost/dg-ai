/**
 * resolveAssetContentType: hand-rolled fixed extension lookup (Engineering —
 * "no new dependency"). Only a small raster allowlist may render inline;
 * SVG/HTML are recognized but MUST NOT be marked inline even though a naive
 * lookup would recognize their extension — that's the whole point of the
 * denylist (Code Structure's "Asset retrieval and content typing" decision).
 *
 * [SPEC] ASSUMED module surface — plan.md pins the SERVING BEHAVIOR ("only
 * safe raster types inline... nosniff... attachment for everything else")
 * but names no module or function. `resolveAssetContentType(filename)` is
 * this pass's invention; see deferrals.
 */
import { describe, expect, it } from "bun:test";
import { resolveAssetContentType } from "../../src/assets/content-type";

describe("resolveAssetContentType", () => {
	it.each([
		["photo.png", "image/png"],
		["photo.PNG", "image/png"], // case-insensitive extension match
		["photo.jpg", "image/jpeg"],
		["photo.jpeg", "image/jpeg"],
		["photo.gif", "image/gif"],
		["photo.webp", "image/webp"],
	])("marks %s inline as %s", (filename, expectedType) => {
		const info = resolveAssetContentType(filename);
		expect(info.contentType).toBe(expectedType);
		expect(info.inline).toBe(true);
	});

	it("recognizes SVG's content type but refuses to serve it inline", () => {
		const info = resolveAssetContentType("logo.svg");
		expect(info.contentType).toBe("image/svg+xml");
		expect(info.inline).toBe(false);
	});

	it("recognizes HTML's content type but refuses to serve it inline", () => {
		const info = resolveAssetContentType("page.html");
		expect(info.contentType).toBe("text/html");
		expect(info.inline).toBe(false);
		expect(resolveAssetContentType("page.htm").inline).toBe(false);
	});

	it("falls back to a generic download type for an unrecognized extension", () => {
		const info = resolveAssetContentType("data.bin");
		expect(info.contentType).toBe("application/octet-stream");
		expect(info.inline).toBe(false);
	});

	it("falls back to the generic download type for a filename with no extension at all", () => {
		const info = resolveAssetContentType("README");
		expect(info.contentType).toBe("application/octet-stream");
		expect(info.inline).toBe(false);
	});
});
