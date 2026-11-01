import { describe, expect, test } from "bun:test";
import { main } from "../../src/pw/cli";
import { main as codeMain } from "../../src/pw/code-cli";
import { startFakeDaemon, useTempScratch } from "../../src/pw/test-support";

useTempScratch();

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		env: {
			cwd: process.cwd(),
			out: (text: string) => out.push(text),
			err: (text: string) => err.push(text),
		},
		out: () => out.join("\n"),
		err: () => err.join("\n"),
	};
}

describe("pw main", () => {
	test("prints the index help and exits 2 with no command", async () => {
		const io = capture();
		expect(await main([], io.env)).toBe(2);
		expect(io.out()).toContain("Usage: pw");
	});

	test("prints the index help and exits 0 for --help", async () => {
		const io = capture();
		expect(await main(["--help"], io.env)).toBe(0);
		expect(io.out()).toContain("Usage: pw");
	});

	test("lists install-browser under the core group", async () => {
		const io = capture();
		await main(["--help"], io.env);
		const core = io
			.out()
			.split(/\n\n/)
			.find((section) => section.startsWith("core:"));
		expect(core).toContain("install-browser");
	});

	test("rejects code as an unknown subcommand", async () => {
		const io = capture();
		expect(await main(["code", "1+1"], io.env)).toBe(2);
		expect(io.err()).toContain("Unknown command: code");
	});

	test("rejects run-code and points to the separate command", async () => {
		const io = capture();
		expect(await main(["run-code", "1"], io.env)).toBe(2);
		expect(io.err()).toContain("pw-code");
	});
});

describe("pw main hidden daemon route", () => {
	test("exits 2 and reports a missing launch spec when no JSON argument follows", async () => {
		const entry = new URL("../../src/pw/cli.ts", import.meta.url).pathname;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import(${JSON.stringify(entry)}).then((m) => m.main(["__daemon"]))`,
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await child.exited).toBe(2);
		expect(await new Response(child.stdout).text()).toContain(
			"ERROR missing launch spec",
		);
	});
});

describe("pw-code main", () => {
	test("prints its help and exits 0 for --help", async () => {
		const io = capture();
		expect(await codeMain(["--help"], io.env)).toBe(0);
		expect(io.out()).toContain("Usage: pw-code");
	});

	test("exits 2 and prints usage when no code is given", async () => {
		const io = capture();
		expect(await codeMain([], io.env)).toBe(2);
		expect(io.err()).toContain(
			"Provide the code as an argument or with --filename",
		);
	});

	test("forwards the code to the session with method code", async () => {
		const methods: string[] = [];
		const fake = await startFakeDaemon("default", {}, (request) => {
			methods.push(request.method);
			return { text: "ok", exitCode: 0 };
		});
		try {
			const io = capture();
			expect(await codeMain(["1+1"], io.env)).toBe(0);
			expect(methods).toEqual(["code"]);
			expect(io.out()).toBe("ok");
		} finally {
			fake.dispose();
		}
	});
});
