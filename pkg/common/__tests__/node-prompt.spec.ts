import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { promptHidden } from "../src/node/prompt";

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

type Listener = (chunk: string) => void;

function fakeInput() {
	const listeners = new Set<Listener>();
	const raw: boolean[] = [];
	let paused = false;
	return {
		raw,
		get paused() {
			return paused;
		},
		listenerCount: () => listeners.size,
		emit: (chunk: string) => {
			for (const listener of [...listeners]) listener(chunk);
		},
		input: {
			setRawMode: (mode: boolean) => raw.push(mode),
			setEncoding: () => undefined,
			resume: () => {
				paused = false;
			},
			pause: () => {
				paused = true;
			},
			on: (_event: "data", listener: Listener) => listeners.add(listener),
			off: (_event: "data", listener: Listener) => listeners.delete(listener),
		},
	};
}

describe("promptHidden", () => {
	it("returns the typed text and writes only the prompt and a newline", async () => {
		const tty = fakeInput();
		const written: string[] = [];

		const pending = promptHidden("Token: ", tty.input, {
			write: (text) => written.push(text),
		});
		tty.emit("abc");
		tty.emit("def\r");

		expect(await pending).toBe("abcdef");
		expect(written.join("")).toBe("Token: \n");
	});

	it("applies backspace and delete to the typed text", async () => {
		const tty = fakeInput();

		const pending = promptHidden("", tty.input, { write: () => undefined });
		tty.emit("abx\u007f\bc\n");

		expect(await pending).toBe("ac");
	});

	it("turns raw mode on, then off, and stops listening", async () => {
		const tty = fakeInput();

		const pending = promptHidden("", tty.input, { write: () => undefined });
		tty.emit("x\r");
		await pending;

		expect(tty.raw).toEqual([true, false]);
		expect(tty.listenerCount()).toBe(0);
		expect(tty.paused).toBe(true);
	});

	it("rejects with Canceled. on Ctrl-C and restores the terminal", async () => {
		const tty = fakeInput();

		const pending = promptHidden("", tty.input, { write: () => undefined });
		tty.emit("ab\u0003");

		await expect(pending).rejects.toThrow("Canceled.");
		expect(tty.raw).toEqual([true, false]);
	});
});
