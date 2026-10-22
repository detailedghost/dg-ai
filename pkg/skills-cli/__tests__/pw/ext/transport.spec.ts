import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCliOnly } from "../../../src/utils/cli-only";
import { defaultExtTransport, ExtBridgeNotImplementedError } from "../../../src/pw/ext/transport";

describe("defaultExtTransport", () => {
	let home: string;
	let previousHome: string | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pw-ext-transport-"));
		previousHome = process.env["DG_HOME"];
		process.env["DG_HOME"] = join(home, ".dg");
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env["DG_HOME"];
		else process.env["DG_HOME"] = previousHome;
		rmSync(home, { recursive: true, force: true });
	});

	test("reports the CLI-only hint first when the extension is not installed", async () => {
		setCliOnly(true);
		await expect(defaultExtTransport({ verb: "current" })).rejects.toThrow("CLI-only install");
	});

	test("fails clearly once the extension is installed, instead of claiming a reply", async () => {
		setCliOnly(false);
		await expect(defaultExtTransport({ verb: "current" })).rejects.toThrow(ExtBridgeNotImplementedError);
	});
});
