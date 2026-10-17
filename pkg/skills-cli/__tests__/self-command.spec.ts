import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selfCommand, shellCommand } from "../src/utils/self-command";
import { proxyFixtures } from "./proxy-fixtures";

let fixture: ReturnType<typeof proxyFixtures>;
beforeEach(() => {
	fixture = proxyFixtures();
});
afterEach(() => fixture.cleanup());
const trickyArgs = [
	"proxy",
	"--prompt",
	"spaces ' quotes \" $HOME $(touch forbidden)",
	"--cwd",
	"/a path/with ' quotes",
];

describe("selfCommand", () => {
	test.each([
		"/$bunfs/root/bun",
		"C:\\$bunfs\\root\\bun.exe",
		"/~BUN/root/bun",
		"C:\\~BUN\\root\\bun.exe",
	])("rejects a virtual executable %s", (execPath) => {
		expect(() => selfCommand(trickyArgs, { execPath, compiled: true })).toThrow(
			/virtual Bun filesystem/,
		);
	});

	test.each([
		"/$bunfs/root/index.js",
		"C:\\$bunfs\\root\\index.js",
		"/~BUN/root/index.js",
		"C:\\~BUN\\root\\index.js",
	])(
		"detects compiled entrypoint %s without reexecuting a virtual path",
		(entrypoint) => {
			expect(
				selfCommand(trickyArgs, { execPath: process.execPath, entrypoint }),
			).toEqual([process.execPath, ...trickyArgs]);
		},
	);

	test("rejects missing source entrypoints before constructing a launch command", () => {
		expect(() =>
			selfCommand(trickyArgs, {
				execPath: process.execPath,
				entrypoint: join(fixture.root, "missing.ts"),
				compiled: false,
			}),
		).toThrow(/does not exist/);
	});

	test("source mode executes the real entrypoint with intact argument boundaries", () => {
		const entrypoint = join(fixture.root, "source entry ' main.ts");
		writeFileSync(
			entrypoint,
			"console.log(JSON.stringify(process.argv.slice(2)));\n",
		);
		const argv = selfCommand(trickyArgs, {
			execPath: process.execPath,
			entrypoint,
			compiled: false,
		});
		const result = Bun.spawnSync(argv, { env: fixture.env() });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual(trickyArgs);
	});

	test("compiled mode invokes the executable without a virtual source path", () => {
		const executable = join(fixture.root, "compiled binary ' spaced");
		writeFileSync(
			executable,
			`#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
		);
		chmodSync(executable, 0o755);
		const argv = selfCommand(trickyArgs, {
			execPath: executable,
			entrypoint: "/$bunfs/root/index.js",
			compiled: true,
		});
		expect(argv).toEqual([executable, ...trickyArgs]);
		const result = Bun.spawnSync(argv, { env: fixture.env() });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual(trickyArgs);
	});

	test("shellCommand survives a real shell with spaces, quotes, and metacharacters", () => {
		const entrypoint = join(fixture.root, "argv ' recorder.ts");
		writeFileSync(
			entrypoint,
			"console.log(JSON.stringify(process.argv.slice(2)));\n",
		);
		const argv = selfCommand([...trickyArgs, "", "line\nbreak"], {
			execPath: process.execPath,
			entrypoint,
			compiled: false,
		});
		const result = Bun.spawnSync(["/bin/sh", "-c", shellCommand(argv)], {
			cwd: fixture.root,
			env: fixture.env(),
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual([
			...trickyArgs,
			"",
			"line\nbreak",
		]);
	});
});
