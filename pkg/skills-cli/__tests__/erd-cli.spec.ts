import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "src", "index.ts");
const fixture = join(import.meta.dir, "fixtures", "erd", "code-graph");

async function run(args: string[], cwd = process.cwd(), stdin?: string) {
	const proc = Bun.spawn([process.execPath, entry, "erd", ...args], {
		cwd,
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("erd CLI", () => {
	test("help lists resolve, generate, and render without running work", async () => {
		const result = await run(["--help"]);
		expect(result.code).toBe(0);
		for (const verb of ["resolve", "generate", "render"]) expect(result.stdout).toContain(verb);
		expect(result.stderr).toBe("");
	});

	test("render reads sequence data from stdin and persists Markdown plus JSON", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-erd-render-"));
		try {
			const base = join(root, "sequence");
			const data = JSON.stringify({
				participants: ["Client", "Server"],
				messages: [{ from: "Client", to: "Server", label: "hello" }],
			});
			const result = await run(["render", "--type", "sequence", "--data", "-", "--out", base], root, data);
			expect(result.code, result.stderr).toBe(0);
			const parsed = JSON.parse(result.stdout) as { outPath: string; dataOutPath: string };
			expect(readFileSync(parsed.outPath, "utf8")).toContain("```mermaid\nsequenceDiagram");
			expect(JSON.parse(readFileSync(parsed.dataOutPath, "utf8")).diagram).toContain("sequenceDiagram");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("generate --type flow narrows the document without changing the default collector", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-erd-generate-"));
		try {
			const result = await run(["generate", fixture, "--type", "flow", "--out", join(root, "map")]);
			expect(result.code, result.stderr).toBe(0);
			const parsed = JSON.parse(result.stdout) as { outPath: string };
			const markdown = readFileSync(parsed.outPath, "utf8");
			expect(markdown).toContain("## Import Graph");
			expect(markdown).not.toContain("## Directory Tree");
			expect(markdown).not.toContain("## Database Schema");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("sequence generation directs described graphs to render and exits 1", async () => {
		const result = await run(["generate", fixture, "--type", "sequence"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("use erd render");
	});

	test("render rejects undocumented nested enum values", async () => {
		const data = JSON.stringify({
			classes: [{ name: "User" }],
			relations: [{ from: "Admin", to: "User", kind: "inherits" }],
		});
		const result = await run(["render", "--type", "class", "--data", "-"], process.cwd(), data);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("class.relations[0].kind must be one of");
	});

	test("legacy generate flags keep missing and malformed depth values non-fatal", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-erd-legacy-flags-"));
		try {
			const result = await run([
				"generate",
				fixture,
				"--depth",
				"--out",
				join(root, "map.md"),
			]);
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout).outPath).toBe(join(root, "map.md"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("generate --out with a non-markdown suffix does not produce a double extension", async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-erd-out-suffix-"));
		try {
			const result = await run(["generate", fixture, "--out", join(root, "map.json")]);
			expect(result.code, result.stderr).toBe(0);
			const parsed = JSON.parse(result.stdout) as { outPath: string; evidenceOutPath: string };
			expect(parsed.outPath).toBe(join(root, "map.md"));
			expect(parsed.evidenceOutPath).toBe(join(root, "map.json"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a malformed --depth value with a leading digit fails instead of silently coercing", async () => {
		const result = await run(["generate", fixture, "--depth", "3abc"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--depth must be a non-negative integer");
	});

	test("a negative --depth value fails instead of truncating every subdirectory", async () => {
		const result = await run(["generate", fixture, "--depth", "-1"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--depth must be a non-negative integer");
	});

	test("removed viz flags are rejected", async () => {
		const result = await run(["generate", fixture, "--viz"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("unknown flag: --viz");
	});
});
