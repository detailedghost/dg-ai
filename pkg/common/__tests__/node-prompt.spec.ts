import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const PROMPT = join(import.meta.dir, "..", "src", "node", "prompt.ts");
const SCRIPT = `import { readLine } from ${JSON.stringify(PROMPT)};
const answer = await readLine("Continue? [Y/n] ");
console.log(JSON.stringify(answer));`;

async function ask(input: string) {
	const proc = Bun.spawn([process.execPath, "-e", SCRIPT], {
		stdin: new Blob([input]),
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

describe("readLine", () => {
	it("returns the first line of the input without its newline", async () => {
		const result = await ask("yes\nsecond\n");

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toBe("yes");
	});

	it("returns an empty line as an empty string", async () => {
		const result = await ask("\n");

		expect(JSON.parse(result.stdout.trim())).toBe("");
	});

	it("returns null when the input ends with no line", async () => {
		const result = await ask("");

		expect(JSON.parse(result.stdout.trim())).toBeNull();
	});

	it("writes the question to stderr and keeps stdout for the answer", async () => {
		const result = await ask("y\n");

		expect(result.stderr).toContain("Continue? [Y/n] ");
		expect(result.stdout).not.toContain("Continue?");
	});
});
