import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	markerFiles,
	readMarker,
	writeMarkerEntry,
} from "../src/utils/lib";
import { isProtoExtensionInstalled } from "../src/utils/proto-detect";

const roots: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-ext-marker-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extension marker", () => {
	test("is named extension-installed, with the old name kept as the legacy path", () => {
		const { current, legacy } = markerFiles({ HOME: "/h" });
		expect(current).toBe(join("/h", ".config", "dg", "extension-installed"));
		expect(legacy).toBe(join("/h", ".config", "dg", "browser-batch-installed"));
	});

	test("reads versions from the legacy marker when the new one is absent", () => {
		const dir = scratch();
		const legacy = join(dir, "browser-batch-installed");
		writeFileSync(legacy, JSON.stringify({ chrome: "1.2.0" }));

		expect(readMarker({ current: join(dir, "extension-installed"), legacy })).toEqual({
			chrome: "1.2.0",
		});
	});

	test("prefers the new marker per target and keeps legacy-only targets", () => {
		const dir = scratch();
		const legacy = join(dir, "browser-batch-installed");
		const current = join(dir, "extension-installed");
		writeFileSync(legacy, JSON.stringify({ chrome: "1.0.0", firefox: "1.0.0" }));
		writeFileSync(current, JSON.stringify({ chrome: "1.5.0" }));

		expect(readMarker({ current, legacy })).toEqual({ chrome: "1.5.0", firefox: "1.0.0" });
	});

	test("writes the new marker and carries legacy entries over without touching the old file", () => {
		const dir = scratch();
		const legacy = join(dir, "browser-batch-installed");
		const current = join(dir, "config", "extension-installed");
		writeFileSync(legacy, JSON.stringify({ firefox: "1.0.0" }));

		writeMarkerEntry("chrome", "2.0.0", { current, legacy });

		expect(JSON.parse(readFileSync(current, "utf8"))).toEqual({
			firefox: "1.0.0",
			chrome: "2.0.0",
		});
		expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual({ firefox: "1.0.0" });
	});

	test("reads an unreadable marker as empty", () => {
		const dir = scratch();
		const current = join(dir, "extension-installed");
		writeFileSync(current, "{not json");

		expect(readMarker({ current, legacy: join(dir, "missing") })).toEqual({});
	});

	test("detection accepts either marker file", () => {
		const dir = scratch();
		const current = join(dir, "extension-installed");
		const legacy = join(dir, "browser-batch-installed");

		expect(isProtoExtensionInstalled([current, legacy])).toBe(false);
		writeFileSync(legacy, "{}");
		expect(isProtoExtensionInstalled([current, legacy])).toBe(true);
		rmSync(legacy);
		writeFileSync(current, "{}");
		expect(isProtoExtensionInstalled([current, legacy])).toBe(true);
	});
});
