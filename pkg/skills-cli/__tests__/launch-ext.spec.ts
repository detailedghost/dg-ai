import { afterEach, describe, expect, test } from "bun:test";
import { extensionRequiredMessage } from "../src/utils/cli-only";
import { type ExtCommandWorld, extCommandWorld } from "./ext-command-harness";

const requiredPrefix = (subject: string) =>
	extensionRequiredMessage(subject).split(" Run ")[0] ?? "";

const REFUSAL =
	"launch: an extension-only command; add --ext (dg-skills launch --ext ...)";

describe("launch without --ext", () => {
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
			expect(run.error).toStartWith(requiredPrefix("dg-skills launch"));
			expect(run.detectCalls).toBe(0);
		} finally {
			world.cleanup();
		}
	});
});

describe("launch --ext", () => {
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
		expect(run.error).toStartWith(requiredPrefix("dg-skills launch"));
		expect(run.detectCalls).toBe(0);
	});
});
