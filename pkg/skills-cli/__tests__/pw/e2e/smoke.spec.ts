import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { call } from "../../../src/pw/core/socket";
import { COOKIE_NAME, startFixtureSite } from "./fixture-site";

const ENTRY = path.resolve(import.meta.dir, "../../../src/index.ts");
const SESSION = "pwnext-e2e";
const SCRATCH_SESSION = "pwnext-e2e-scratch";
const STATE = "smoke";
const STEP_TIMEOUT_MS = 60_000;

type Run = { code: number; out: string; err: string };

describe.skipIf(process.env["PW_E2E"] !== "1")("pw smoke", () => {
	test("playwright-core exposes the registry install path", async () => {
		const { registry } = await import("playwright-core/lib/coreBundle");
		expect(typeof registry.registry.install).toBe("function");
		expect(registry.registry.findExecutable("chromium")).toBeTruthy();
	});

	let root: string;
	let site: ReturnType<typeof startFixtureSite>;
	let env: Record<string, string>;
	let uploadFile: string;

	const runScript = async (command: string, args: string[]): Promise<Run> => {
		const proc = Bun.spawn([process.execPath, "run", ENTRY, command, ...args], {
			cwd: root,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, out, err };
	};

	const pw = (...args: string[]) => runScript("pw", args);
	const pwCode = (...args: string[]) => runScript("pw-code", args);

	const snapshotText = (run: Run): string => {
		const link = /\[Snapshot\]\(([^)]+)\)/.exec(run.out);
		if (!link?.[1]) throw new Error(`no snapshot link in:\n${run.out}\n${run.err}`);
		return readFileSync(link[1], "utf8");
	};

	const refFor = (yaml: string, label: string): string => {
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = new RegExp(`${escaped}[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(yaml);
		if (!match?.[1]) throw new Error(`no ref for ${label} in:\n${yaml}`);
		return match[1];
	};

	beforeAll(() => {
		mkdirSync("/tmp/ai", { recursive: true });
		root = mkdtempSync("/tmp/ai/pwe2e-");
		env = {
			...(process.env as Record<string, string>),
			XDG_CACHE_HOME: path.join(root, "cache"),
			AI_STATE_DIR: path.join(root, "state"),
			AI_SCRATCH_DIR: path.join(root, "scratch"),
		};
		uploadFile = path.join(root, "upload-me.txt");
		writeFileSync(uploadFile, "e2e upload payload\n");
		site = startFixtureSite();
	});

	afterAll(async () => {
		await pw("close-all");
		site.stop();
		rmSync(root, { recursive: true, force: true });
	});

	test(
		"opens headless, logs in through refs, uploads a file, saves state, and closes",
		async () => {
			const opened = await pw(`-s=${SESSION}`, "open", "--headless", site.url);
			expect(opened.code).toBe(0);
			expect(opened.out).toContain(`### Browser \`${SESSION}\` opened`);

			const form = await pw(`-s=${SESSION}`, "snapshot");
			expect(form.code).toBe(0);
			const yaml = snapshotText(form);
			expect(yaml).toContain("Sign in");
			const snapshotFile = /\[Snapshot\]\(([^)]+)\)/.exec(form.out)?.[1] as string;
			expect(statSync(snapshotFile).mode & 0o777).toBe(0o600);
			expect(statSync(path.dirname(snapshotFile)).mode & 0o777).toBe(0o700);

			expect((await pw(`-s=${SESSION}`, "fill", refFor(yaml, 'textbox "Username"'), "alice")).code).toBe(0);
			expect((await pw(`-s=${SESSION}`, "fill", refFor(yaml, 'textbox "Password"'), "not-a-secret")).code).toBe(0);
			const submitted = await pw(`-s=${SESSION}`, "click", refFor(yaml, 'button "Log in"'));
			expect(submitted.code).toBe(0);
			expect(snapshotText(submitted)).toContain("Welcome back");

			expect((await pw(`-s=${SESSION}`, "goto", `${site.url}/upload`)).code).toBe(0);
			const uploadPage = snapshotText(await pw(`-s=${SESSION}`, "snapshot"));
			const chooser = await pw(`-s=${SESSION}`, "click", refFor(uploadPage, 'button "Attachment"'));
			expect(chooser.out).toContain("[File chooser]");
			const uploaded = await pw(`-s=${SESSION}`, "upload", uploadFile);
			expect(uploaded.code).toBe(0);
			const picked = await pw(`-s=${SESSION}`, "--raw", "eval", "document.getElementById('picked').textContent");
			expect(picked.out.trim()).toBe('"upload-me.txt"');

			const saved = await pw(`-s=${SESSION}`, "state", "save", STATE);
			expect(saved.code).toBe(0);
			const stateFile = path.join(root, "state", "pw", "states", `${STATE}.json`);
			expect(statSync(stateFile).mode & 0o777).toBe(0o600);
			expect(readFileSync(stateFile, "utf8")).toContain(COOKIE_NAME);

			const closed = await pw(`-s=${SESSION}`, "close");
			expect(closed.code).toBe(0);
			expect(closed.out).toContain("closed");
		},
		STEP_TIMEOUT_MS * 2,
	);

	test(
		"reopens the persistent profile still logged in",
		async () => {
			const reopened = await pw(`-s=${SESSION}`, "open", "--headless", `${site.url}/protected`);
			expect(reopened.code).toBe(0);
			expect(snapshotText(reopened)).toContain("Welcome back");
			expect((await pw(`-s=${SESSION}`, "close")).code).toBe(0);
		},
		STEP_TIMEOUT_MS,
	);

	test(
		"runs code only through pw-code and keeps run-code out of pw",
		async () => {
			expect((await pw(`-s=${SESSION}`, "open", "--headless", site.url)).code).toBe(0);

			const title = await pwCode(`-s=${SESSION}`, "--raw", "async (page) => page.url()");
			expect(title.code).toBe(0);
			expect(title.out.trim()).toBe(JSON.stringify(`${site.url}/`));

			const moved = await pw(`-s=${SESSION}`, "run-code", "async (page) => 1");
			expect(moved.code).toBe(2);
			expect(moved.err).toContain("run-code moved to pw-code");

			const record = JSON.parse(
				readFileSync(path.join(root, "scratch", "pw", "sessions", `${SESSION}.json`), "utf8"),
			) as { socketPath: string };
			const crafted = await call(record, {
				id: "crafted",
				method: "run",
				params: {
					argv: ["run-code", "async (page) => 1"],
					cwd: root,
					raw: false,
				},
			});
			expect(crafted).toEqual({
				id: "crafted",
				error: "Not a browser command: run-code",
			});

			expect((await pw(`-s=${SESSION}`, "close")).code).toBe(0);
		},
		STEP_TIMEOUT_MS,
	);

	test(
		"seeds a scratch session from the saved state and close-all stops everything",
		async () => {
			const scratch = await pw(
				`-s=${SCRATCH_SESSION}`,
				"open",
				"--scratch",
				"--headless",
				`--from=${STATE}`,
				`${site.url}/protected`,
			);
			expect(scratch.code).toBe(0);
			expect(snapshotText(scratch)).toContain("Welcome back");
			const cookies = await pw(`-s=${SCRATCH_SESSION}`, "cookie-list");
			expect(cookies.out).toContain(COOKIE_NAME);

			const closedAll = await pw("close-all");
			expect(closedAll.code).toBe(0);
			const listing = await pw("list");
			expect(listing.out).not.toContain(SCRATCH_SESSION);
			expect(listing.out).not.toContain(SESSION);
		},
		STEP_TIMEOUT_MS,
	);
});
