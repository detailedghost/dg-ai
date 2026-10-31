import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "src", "index.ts");

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([process.execPath, entry, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

describe("dg-skills ssms", () => {
	test("root help registers ssms and ssms help lists both providers", async () => {
		const root = await run(["--help"]);
		expect(root.code).toBe(0);
		expect(root.out).toContain("ssms");
		const help = await run(["ssms", "--help"]);
		expect(help.code).toBe(0);
		expect(help.out).toContain("ssms <provider> link [--name NAME]");
		expect(help.out).toContain("ssms google cleanup [--dry-run] [--config PATH]");
		expect(help.out).toContain("Providers: google, signal");
	});
});
