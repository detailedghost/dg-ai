import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	makeShellTag,
	redactTokens,
	runShell,
	ShellError,
} from "../src/utils/git";
import { writeFakeCli } from "./fake-cli";

describe("runShell process compatibility", () => {
	for (const exitCode of [0, 23]) {
		test(`preserves exact separate binary buffers and status ${exitCode}`, async () => {
			const stdout = Buffer.from([32, 0, 255, 195, 169, 10, 10]);
			const stderr = Buffer.from([9, 254, 0, 10]);
			const args = [
				"-e",
				`process.stdout.write(Buffer.from(${JSON.stringify([...stdout])})); process.stderr.write(Buffer.from(${JSON.stringify([...stderr])})); process.exitCode = ${exitCode};`,
			];
			if (exitCode === 0) {
				const result = await runShell(process.execPath, args);
				expect(result.exitCode).toBe(exitCode);
				expect(Buffer.isBuffer(result.stdout)).toBe(true);
				expect(Buffer.isBuffer(result.stderr)).toBe(true);
				expect(result.stdout).toEqual(stdout);
				expect(result.stderr).toEqual(stderr);
				expect(result.text()).toBe(stdout.toString());
			} else {
				let caught: unknown;
				try {
					await runShell(process.execPath, args);
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(ShellError);
				const error = caught as ShellError;
				expect(error.name).toBe("ShellError");
				expect(error.bin).toBe(process.execPath);
				expect(error.args).toEqual(args);
				expect(error.exitCode).toBe(exitCode);
				expect(Buffer.isBuffer(error.stdout)).toBe(true);
				expect(Buffer.isBuffer(error.stderr)).toBe(true);
				expect(error.stdout).toEqual(stdout);
				expect(error.stderr).toEqual(stderr);
			}
		});
	}

	test("text decodes a multibyte character split across process chunks without trimming whitespace", async () => {
		const text = "  €\n\n";
		const result = await runShell(process.execPath, [
			"-e",
			`
const bytes = Buffer.from(${JSON.stringify(text)});
process.stdout.write(bytes.subarray(0, 3));
setTimeout(() => process.stdout.write(bytes.subarray(3)), 25);
`,
		]);
		expect(result.stdout).toEqual(Buffer.from(text));
		expect(result.text()).toBe(text);
	});

	test("startup errors retain their native code and are not converted into ShellError", async () => {
		const bin = "/nonexistent/dg-runshell-startup-test";
		let caught: unknown;
		try {
			await runShell(bin, []);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ShellError);
		expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
		expect((caught as Error).message).toContain(bin);
	});
});

describe("redactTokens", () => {
	const cases: Array<[label: string, token: string]> = [
		[
			"classic gh*_ personal access token",
			"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
		],
		["another gh*_ letter (gho_)", "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
		[
			"fine-grained github_pat_ token",
			"github_pat_11ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuvwxyz0123456789",
		],
		["glab glpat- token", "glpat-ABCDEFGHIJKLMNOPQRSTUV"],
		["glab gldt- token", "gldt-ABCDEFGHIJKLMNOPQRSTUV"],
		["glab glrt- token", "glrt-ABCDEFGHIJKLMNOPQRSTUV"],
		["glab glcbt- token", "glcbt-ABCDEFGHIJKLMNOPQRSTUV"],
		["glab glptt- token", "glptt-ABCDEFGHIJKLMNOPQRSTUV"],
		["glab glsoat- token", "glsoat-ABCDEFGHIJKLMNOPQRSTUV"],
	];

	for (const [label, token] of cases) {
		test(`hides a ${label} embedded in surrounding text`, () => {
			const input = `authentication failed: bad credentials (token=${token}) while calling API`;
			const output = redactTokens(input);
			expect(output).not.toContain(token);
			expect(output).toContain("authentication failed");
			expect(output).toContain("while calling API");
		});
	}

	test("redacts a token that abuts punctuation without eating the punctuation around it", () => {
		const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
		const output = redactTokens(
			`Authorization: 'Bearer ${token}', retry=false`,
		);
		expect(output).not.toContain(token);
		expect(output).toContain("Authorization: 'Bearer ");
		expect(output).toContain("', retry=false");
	});

	test("redacts a token appearing twice in one string, not just its first occurrence", () => {
		const token = "glpat-ABCDEFGHIJKLMNOPQRSTU";
		const output = redactTokens(`first ${token} then again ${token}`);
		expect(output).not.toContain(token);
		expect(output.match(/<redacted-token>/g)?.length).toBe(2);
	});

	test("leaves a string with no token prefix unchanged", () => {
		const input =
			"fatal: repository 'https://example.com/acme/widgets.git' not found";
		expect(redactTokens(input)).toBe(input);
	});

	test("redacts every occurrence when two different tokens appear in the same string", () => {
		const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
		const glToken = "glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		const input = `leaked gh token ${ghToken} and leaked glab token ${glToken} in one payload`;
		const output = redactTokens(input);
		expect(output).not.toContain(ghToken);
		expect(output).not.toContain(glToken);
		expect(output.match(/<redacted-token>/g)?.length).toBe(2);
	});
});

describe("ShellError — redacts tokens from constructed error messages", () => {
	test("a token on stderr is not present in the resulting .message (regression + widened prefix)", () => {
		const token =
			"github_pat_11ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuvwxyz0123456789";
		const err = new ShellError(
			"gh",
			["pr", "create"],
			1,
			Buffer.from(""),
			Buffer.from(`error: bad credentials for token ${token}`),
		);
		expect(err.message).not.toContain(token);
		expect(err.message).toContain("bad credentials");
	});

	test("a glab-prefixed token on stderr is not present in the resulting .message", () => {
		const token = "glpat-ABCDEFGHIJKLMNOPQRSTUV";
		const err = new ShellError(
			"glab",
			["mr", "create"],
			1,
			Buffer.from(""),
			Buffer.from(`403 Forbidden: token ${token} lacks the required scope`),
		);
		expect(err.message).not.toContain(token);
		expect(err.message).toContain("403 Forbidden");
	});

	test("a token on stdout (empty stderr) is not present in the resulting .message (Contract 8)", () => {
		const token = "glpat-ZZZZZZZZZZZZZZZZZZZZZZZZ";
		const err = new ShellError(
			"glab",
			["mr", "update"],
			1,
			Buffer.from(`push rejected: token ${token} not authorized`),
			Buffer.from(""),
		);
		expect(err.message).not.toContain(token);
		expect(err.message).toContain("not authorized");
	});

	test("a token embedded in the command's own args (e.g. a credentialed remote URL) is not present in the resulting .message", () => {
		const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
		const err = new ShellError(
			"git",
			["push", `https://x-access-token:${token}@github.com/acme/widgets.git`],
			1,
			Buffer.from(""),
			Buffer.from("fatal: authentication failed"),
		);
		expect(err.message).not.toContain(token);
		expect(err.message).toContain("authentication failed");
	});

	test("a token straddling the 200-char truncation boundary is fully redacted, not left as a fragment", () => {
		const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
		const filler = "z".repeat(185);
		const err = new ShellError(
			"gh",
			["pr", "create"],
			1,
			Buffer.from(""),
			Buffer.from(`${filler}${token} trailer`),
		);
		expect(err.message).not.toContain(token);
		expect(err.message).not.toMatch(/ghp_[A-Za-z0-9]+/);
	});
});

describe("git tag — end-to-end token redaction through a real spawned failure", () => {
	test("a token printed to stdout by a failing `git` binary never reaches the thrown ShellError's message", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "git-redact-fakebin-"));
		const fakeGitPath = join(fakeDir, "git");
		const token = "glpat-QQQQQQQQQQQQQQQQQQQQQQQQ";
		writeFileSync(
			fakeGitPath,
			`#!/bin/sh\necho "push rejected: token ${token} not authorized"\nexit 1\n`,
		);
		chmodSync(fakeGitPath, 0o755);

		try {
			const fakeGit = makeShellTag(fakeGitPath);
			let caught: unknown;
			try {
				await fakeGit`push origin main`;
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ShellError);
			const message = (caught as InstanceType<typeof ShellError>).message;
			expect(message).not.toContain(token);
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});
});

describe("runShell — bare binary name resolution against a PATH entry added at runtime", () => {
	test("a binary that exists only on a dir prepended to process.env.PATH at runtime is found and run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runshell-live-path-"));
		const binName = "totally-unique-runshell-live-path-bin";
		const binPath = join(dir, binName);
		writeFileSync(binPath, '#!/bin/sh\necho "reached the fake"\nexit 0\n');
		chmodSync(binPath, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
		try {
			const result = await runShell(binName, []);
			expect(result.stdout.toString().trim()).toBe("reached the fake");
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("makeShellTag(bareName) resolves the same way — the calling style git/gh/glab all use", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runshell-live-path-tag-"));
		const binName = "totally-unique-shelltag-live-path-bin";
		const binPath = join(dir, binName);
		writeFileSync(binPath, '#!/bin/sh\necho "tag reached the fake"\nexit 0\n');
		chmodSync(binPath, 0o755);
		const originalPath = process.env.PATH;
		process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
		try {
			const tag = makeShellTag(binName);
			const result = await tag``;
			expect(result.stdout.toString().trim()).toBe("tag reached the fake");
		} finally {
			process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("writeFakeCli + makeShellTag('glab') — what every GitLab-adapter test depends on", () => {
	test("a glab-named fake placed via writeFakeCli is what actually runs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runshell-glab-fake-"));
		try {
			writeFakeCli(
				dir,
				"glab",
				'#!/bin/sh\necho "fake glab reached"\nexit 0\n',
			);
			const glab = makeShellTag("glab");
			const result = await glab``;
			expect(result.stdout.toString().trim()).toBe("fake glab reached");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runShell — opts.input", () => {
	test("data passed via opts.input is readable on the spawned process's stdin", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "runshell-stdin-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-stdin-cat");
		writeFileSync(fakeBinPath, "#!/bin/sh\ncat\nexit 0\n");
		chmodSync(fakeBinPath, 0o755);
		try {
			const result = await runShell(fakeBinPath, [], {
				input: "hello from stdin\n",
			});
			expect(result.stdout.toString()).toBe("hello from stdin\n");
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("omitting opts.input leaves the spawned process's stdin empty (regression: default behavior unchanged)", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "runshell-nostdin-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-nostdin-cat");
		writeFileSync(fakeBinPath, "#!/bin/sh\ncat\nexit 0\n");
		chmodSync(fakeBinPath, 0o755);
		try {
			const result = await runShell(fakeBinPath, []);
			expect(result.stdout.toString()).toBe("");
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test('opts.input: "" still opens a real stdin pipe rather than falling back to no stdin (distinguishes !== undefined from truthiness)', async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "runshell-emptystdin-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-emptystdin-probe");
		writeFileSync(fakeBinPath, "#!/bin/sh\nreadlink /proc/self/fd/0\nexit 0\n");
		chmodSync(fakeBinPath, 0o755);
		try {
			const withEmptyInput = await runShell(fakeBinPath, [], { input: "" });
			const withNoInput = await runShell(fakeBinPath, []);
			expect(withEmptyInput.stdout.toString()).not.toBe(
				withNoInput.stdout.toString(),
			);
			expect(withNoInput.stdout.toString().trim()).toBe("/dev/null");
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});
});

describe("makeShellTag(bin).withInput", () => {
	test("returns a new tagged-template function distinct from the original, bound to the given stdin", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-identity-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-identity-cat");
		writeFileSync(fakeBinPath, "#!/bin/sh\ncat\nexit 0\n");
		chmodSync(fakeBinPath, 0o755);
		try {
			const tag = makeShellTag(fakeBinPath);
			const bound = tag.withInput("bound stdin\n");
			expect(bound).not.toBe(tag);
			const result = await bound``;
			expect(result.stdout.toString()).toBe("bound stdin\n");
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("gh.withInput(longText)`pr edit --body-file -` pipes the text via stdin, not argv (Acceptance: avoids ARG_MAX)", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-gh-fakebin-"));
		const fakeGhPath = join(fakeDir, "gh");
		writeFileSync(
			fakeGhPath,
			'#!/bin/sh\nprintf "ARGV:[%s]\\n" "$*"\nprintf "STDIN:"\ncat\nexit 0\n',
		);
		chmodSync(fakeGhPath, 0o755);
		const longBody = "line one of the pr body\n".repeat(2000);
		try {
			const fakeGh = makeShellTag(fakeGhPath);
			const result = await fakeGh.withInput(longBody)`pr edit --body-file -`;
			const output = result.stdout.toString();
			expect(output).toContain("ARGV:[pr edit --body-file -]");
			expect(output).toContain(`STDIN:${longBody}`);
			const [argvLine] = output.split("\n");
			expect(argvLine).not.toContain(longBody);
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("a body larger than the OS pipe buffer is delivered whole, not truncated at the first 64KB", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-largebody-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-large-cat");
		writeFileSync(fakeBinPath, "#!/bin/sh\ncat\nexit 0\n");
		chmodSync(fakeBinPath, 0o755);
		const longBody = "a".repeat(1_000_000);
		try {
			const result = await makeShellTag(fakeBinPath).withInput(
				longBody,
			)`pr edit --body-file -`;
			expect(result.stdout.toString().length).toBe(longBody.length);
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("a command that exits nonzero without ever reading stdin still rejects with ShellError rather than hanging on a broken pipe", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-epipe-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-epipe-failer");
		writeFileSync(
			fakeBinPath,
			'#!/bin/sh\necho "auth required" 1>&2\nexit 4\n',
		);
		chmodSync(fakeBinPath, 0o755);
		try {
			let caught: unknown;
			try {
				await makeShellTag(fakeBinPath).withInput(
					"x".repeat(500_000),
				)`pr edit --body-file -`;
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ShellError);
			expect((caught as InstanceType<typeof ShellError>).exitCode).toBe(4);
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("a token printed by a failing command run through withInput is still redacted from the thrown message", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-redact-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-redact-failer");
		const token = "glpat-WWWWWWWWWWWWWWWWWWWW";
		writeFileSync(
			fakeBinPath,
			`#!/bin/sh\ncat > /dev/null\necho "denied for token ${token}"\nexit 1\n`,
		);
		chmodSync(fakeBinPath, 0o755);
		try {
			let caught: unknown;
			try {
				await makeShellTag(fakeBinPath).withInput(
					"body text",
				)`pr edit --body-file -`;
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(ShellError);
			expect((caught as Error).message).not.toContain(token);
			expect((caught as Error).message).toContain("denied for token");
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("binding stdin does not leak back into the original tag — a later plain call still gets empty stdin", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-noleak-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-noleak-cat");
		writeFileSync(fakeBinPath, "#!/bin/sh\ncat\nexit 0\n");
		chmodSync(fakeBinPath, 0o755);
		try {
			const tag = makeShellTag(fakeBinPath);
			const bound = await tag.withInput("bound body")``;
			expect(bound.stdout.toString()).toBe("bound body");
			const plain = await tag``;
			expect(plain.stdout.toString()).toBe("");
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("a multibyte UTF-8 body round-trips byte-exactly through stdin", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-utf8-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-utf8-cat");
		writeFileSync(fakeBinPath, "#!/bin/sh\ncat\nexit 0\n");
		chmodSync(fakeBinPath, 0o755);
		const body = "résumé — naïve éèê test\n";
		try {
			const result = await makeShellTag(fakeBinPath).withInput(body)``;
			expect(result.stdout.toString()).toBe(body);
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});

	test("two calls through the same bound function each carry their own args, sharing the same stdin text", async () => {
		const fakeDir = mkdtempSync(join(tmpdir(), "withinput-reuse-fakebin-"));
		const fakeBinPath = join(fakeDir, "fake-reuse-echo");
		writeFileSync(
			fakeBinPath,
			'#!/bin/sh\nprintf "ARGS:[%s] " "$*"\ncat\nexit 0\n',
		);
		chmodSync(fakeBinPath, 0o755);
		try {
			const bound = makeShellTag(fakeBinPath).withInput("shared-body");
			const first = await bound`--slot one`;
			const second = await bound`--slot two`;
			expect(first.stdout.toString()).toBe("ARGS:[--slot one] shared-body");
			expect(second.stdout.toString()).toBe("ARGS:[--slot two] shared-body");
		} finally {
			rmSync(fakeDir, { recursive: true, force: true });
		}
	});
});
