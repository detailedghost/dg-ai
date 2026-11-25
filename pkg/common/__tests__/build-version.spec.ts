import { afterEach, describe, expect, test } from "bun:test";
import { buildVersion } from "../src/build-version";

const saved = process.env.DG_BUILD_VERSION;

afterEach(() => {
	if (saved === undefined) delete process.env.DG_BUILD_VERSION;
	else process.env.DG_BUILD_VERSION = saved;
});

describe("buildVersion", () => {
	test("returns the baked version", () => {
		process.env.DG_BUILD_VERSION = "7.1.2";
		expect(buildVersion()).toBe("7.1.2");
	});

	test("returns dev when the version is unset", () => {
		delete process.env.DG_BUILD_VERSION;
		expect(buildVersion()).toBe("dev");
	});

	test("returns dev when the version is empty, like the native VersionCommand", () => {
		process.env.DG_BUILD_VERSION = "";
		expect(buildVersion()).toBe("dev");
	});
});
