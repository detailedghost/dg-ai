import { afterEach, describe, expect, test } from "bun:test";
import { extensionRequiredMessage } from "../src/utils/cli-only";
import { type ExtCommandWorld, extCommandWorld } from "./ext-command-harness";

const requiredPrefix = (subject: string) =>
	extensionRequiredMessage(subject).split(" Run ")[0] ?? "";

const REFUSAL =
	"launch: an extension-only command; add --ext (dg-skills pw launch --ext ...)";

describe("pw launch without --ext", () => {
	test("returns 1, prints the extension-only line and detects no browser on a full install", async () => {
		const world = extCommandWorld({ cliOnly: false });
		try {
			const run = await world.run(["launch", "https://example.test/a"]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain(REFUSAL);
			expect(run.detectCalls).toBe(0);
			expect(run.opened).toEqual([]);
		} finally {
			world.cleanup();
		}
	});

	test("exits 1 and detects no browser on a CLI-only install", async () => {
		const world = extCommandWorld({ cliOnly: true });
		try {
			const run = await world.run(["launch", "https://example.test/a"]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain(requiredPrefix("dg-skills pw launch"));
			expect(run.detectCalls).toBe(0);
		} finally {
			world.cleanup();
		}
	});
});

describe("pw launch --ext", () => {
	let world: ExtCommandWorld;
	afterEach(() => world.cleanup());

	test("reaches detectBrowsers and lists browsers on a full install", async () => {
		world = extCommandWorld({ cliOnly: false });
		const run = await world.run(["launch", "--ext", "--list"]);
		expect(run.detectCalls).toBe(1);
		expect(run.stdout).toContain("Detected browsers:");
		expect(run.stderr).not.toContain(REFUSAL);
	});

	test("is blocked on a CLI-only install before detecting browsers", async () => {
		world = extCommandWorld({ cliOnly: true });
		const run = await world.run(["launch", "--ext", "--list"]);
		expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain(requiredPrefix("dg-skills pw launch"));
		expect(run.detectCalls).toBe(0);
	});

	test("prints usage and exits 0 for --help", async () => {
		world = extCommandWorld({ cliOnly: false });
		const run = await world.run(["launch", "--help"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("Usage: pw launch");
		expect(run.stdout).toContain("--dry-run");
		expect(run.detectCalls).toBe(0);
	});

	test("routes a leading --ext to launch and lists browsers", async () => {
		world = extCommandWorld({ cliOnly: false });
		const run = await world.run(["--ext", "launch", "--list"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("Detected browsers:");
	});
});
