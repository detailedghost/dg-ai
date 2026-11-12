import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type AcceptedRecord,
	parseRecord,
	renderAccepted,
} from "../src/layout/record";
import type { LayoutResult } from "../src/layout/fingerprint";
import { recordAcceptance } from "../src/prototype/accepted";
import type { Capturer, CaptureRequest } from "../src/verify/capture-model";
import { verifyBrowserAvailable } from "../src/verify/playwright-capturer";
import { makeTempDir } from "./git-repo-fixtures";
import { collectRun, type SpecRun } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");
const browser = process.env.PW_E2E === "1" && verifyBrowserAvailable();

interface Session {
	pid: number;
	port: number;
	sentinelDir: string;
}

let root: string;
let scratch: string;
let project: string;
const children: Array<{ kill(): void }> = [];

beforeEach(() => {
	root = makeTempDir("dg-prototype-accept-");
	scratch = join(root, "scratch");
	project = join(root, "project");
	mkdirSync(scratch, { recursive: true });
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	const stateDir = join(scratch, "prototype-ui");
	if (existsSync(stateDir))
		for (const file of readdirSync(stateDir).filter((f) => f.endsWith(".json"))) {
			try {
				const state = JSON.parse(readFileSync(join(stateDir, file), "utf8")) as Session;
				process.kill(state.pid, "SIGKILL");
			} catch {
				continue;
			}
		}
	rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		AI_SCRATCH_DIR: scratch,
		DG_SKILLS_DIR: SKILLS,
		PROTOTYPE_UI_NO_OPEN: "1",
		DG_VERIFY_BROWSER: "/nonexistent",
		...extra,
	};
}

function cli(args: string[], extra: Record<string, string> = {}) {
	const proc = Bun.spawn([process.execPath, ENTRY, "prototype", ...args], {
		cwd: project,
		env: env(extra),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	return { done: collectRun(proc) as Promise<SpecRun> };
}

async function sessionFor(chain: string): Promise<Session> {
	for (let i = 0; i < 100; i++) {
		try {
			return JSON.parse(
				readFileSync(join(scratch, "prototype-ui", `${chain}.json`), "utf8"),
			) as Session;
		} catch {
			await Bun.sleep(100);
		}
	}
	throw new Error(`no session for ${chain}`);
}

function manifest(name: string, chain?: string, body?: string): string {
	const path = join(root, `${name}.md`);
	writeFileSync(
		path,
		`---\nname: ${name}\n${chain ? `chain: ${chain}\n` : ""}labels:\n  A: Alpha\n---\n${body ?? "::: A\n<h1>Alpha</h1>\n:::\n::: B\n<h1>Beta</h1>\n:::\n"}`,
	);
	return path;
}

function decide(port: number, body: Record<string, unknown>) {
	return fetch(`http://127.0.0.1:${port}/prototype-decision`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Sec-Fetch-Site": "same-origin",
		},
		body: JSON.stringify({
			action: "confirm",
			variant: "A",
			notes: "",
			...body,
		}),
	});
}

function recordPath(name: string): string {
	return join(project, ".agents", "prototype", name, "accepted.json");
}

function readRecord(name: string): AcceptedRecord {
	return JSON.parse(readFileSync(recordPath(name), "utf8")) as AcceptedRecord;
}

const port = () => 44000 + Math.floor(Math.random() * 2000);

setDefaultTimeout(60_000);

describe("prototype acceptance record from a ui session", () => {
	test("an approve writes accepted.json, keeps stdout unchanged, and names the repair command on stderr", async () => {
		const run = cli(["ui", manifest("solo"), "--no-open", `--port=${port()}`, "--timeout=30"]);
		const session = await sessionFor("solo");
		await decide(session.port, { url: `http://127.0.0.1:${session.port}/` });
		const result = await run.done;
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ status: "ok", variant: "A", notes: "" });
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		const record = readRecord("solo");
		expect(record).toMatchObject({
			version: 1,
			name: "solo",
			chain: "solo",
			mode: "local",
			variant: "A",
			label: "Alpha",
			round: 1,
			final: true,
			source: "browser",
			fingerprint: null,
		});
		expect(record.skipped).toMatch(/browser/);
		expect(record.history).toHaveLength(1);
		expect(result.stderr).toContain(recordPath("solo"));
		expect(result.stderr).toContain("prototype fingerprint solo --url=");
	});

	test("a second approve appends history and only the one without notes is final", async () => {
		const first = cli(["ui", manifest("hist"), "--no-open", `--port=${port()}`, "--timeout=60"]);
		const session = await sessionFor("hist");
		await decide(session.port, { notes: "tighten", url: `http://127.0.0.1:${session.port}/` });
		expect(JSON.parse((await first.done).stdout).notes).toBe("tighten");
		expect(readRecord("hist")).toMatchObject({ round: 1, final: false });

		const second = cli(["ui", manifest("hist"), "--no-open", "--timeout=60"]);
		await Bun.sleep(800);
		await decide(session.port, { variant: "B", url: `http://127.0.0.1:${session.port}/` });
		expect(JSON.parse((await second.done).stdout).variant).toBe("B");
		const record = readRecord("hist");
		expect(record.round).toBe(2);
		expect(record.final).toBe(true);
		expect(record.variant).toBe("B");
		expect(record.history.map((entry) => [entry.round, entry.variant, entry.notes])).toEqual([
			[1, "A", "tighten"],
			[2, "B", ""],
		]);
	});

	test("stop marks the latest record final", async () => {
		const run = cli(["ui", manifest("stopme"), "--no-open", `--port=${port()}`, "--timeout=60"]);
		const session = await sessionFor("stopme");
		await decide(session.port, { notes: "more", url: `http://127.0.0.1:${session.port}/` });
		await run.done;
		expect(readRecord("stopme").final).toBe(false);
		await cli(["stop", "stopme"]).done;
		expect(readRecord("stopme").final).toBe(true);
	});

	test("a series writes one record per prototype name", async () => {
		const first = cli([
			"ui", manifest("series-one", "chain"), "--series", "--no-open", `--port=${port()}`, "--timeout=60",
		]);
		const session = await sessionFor("chain");
		await decide(session.port, { url: `http://127.0.0.1:${session.port}/` });
		await first.done;
		const second = cli(["ui", manifest("series-two", "chain"), "--series", "--no-open", "--timeout=60"]);
		await Bun.sleep(800);
		await decide(session.port, { url: `http://127.0.0.1:${session.port}/` });
		await second.done;
		expect(readRecord("series-one").name).toBe("series-one");
		expect(readRecord("series-two")).toMatchObject({ name: "series-two", chain: "chain" });
	});

	test.skipIf(!browser)("the server still answers while the record is taken", async () => {
		const page = manifest(
			"shotted",
			undefined,
			'::: A\n<div data-verify-root="shotted"><button type="button">Add note</button></div>\n:::\n',
		);
		const run = cli(["ui", page, "--no-open", `--port=${port()}`, "--timeout=60"], {
			DG_VERIFY_BROWSER: process.env.DG_VERIFY_BROWSER ?? "",
		});
		const session = await sessionFor("shotted");
		await decide(session.port, { url: `http://127.0.0.1:${session.port}/?variant=A` });
		await run.done;
		const record = readRecord("shotted");
		expect(record.skipped).toBeNull();
		expect(record.fingerprint?.readings).toHaveLength(6);
		expect(readdirSync(join(project, ".agents", "prototype", "shotted", "accepted")).sort()).toEqual([
			"desktop-dark.png",
			"desktop-light.png",
			"mobile-dark.png",
			"mobile-light.png",
			"tablet-dark.png",
			"tablet-light.png",
		]);
	});
});

describe("prototype acceptance record from hand-wired commands", () => {
	test("confirm then wait records a skip for the missing page url", async () => {
		await cli(["confirm", "wired", "A"]).done;
		const result = await cli(["wait", "wired", "--timeout=1"]).done;
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("A\n");
		const record = readRecord("wired");
		expect(record.skipped).toContain("no page url recorded");
		expect(record.source).toBe("cli");
		expect(result.stderr).toContain("prototype fingerprint wired --url=");
	});

	test("a rejected claim writes no record", async () => {
		const dir = join(project, ".agents", "prototype", "nope");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".reject"), "redo\n");
		const result = await cli(["wait", "nope", "--timeout=1"]).done;
		expect(result.exitCode).toBe(0);
		expect(existsSync(recordPath("nope"))).toBe(false);
	});

	test("fingerprint refuses a name with nothing accepted", async () => {
		const result = await cli(["fingerprint", "ghost", "--url=http://127.0.0.1:4321/"]).done;
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('prototype: nothing accepted for "ghost"');
	});

	test("fingerprint refuses a non-loopback url", async () => {
		await cli(["confirm", "wired2", "A"]).done;
		await cli(["wait", "wired2", "--timeout=1"]).done;
		const result = await cli(["fingerprint", "wired2", "--url=http://example.com/"]).done;
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("prototype: refused non-loopback url");
	});

	test("status --json reports the accepted record", async () => {
		await cli(["confirm", "wired3", "A"]).done;
		await cli(["wait", "wired3", "--timeout=1"]).done;
		const result = await cli(["status", "wired3", "--json"]).done;
		const body = JSON.parse(result.stdout) as { accepted?: Record<string, unknown> };
		expect(body.accepted).toMatchObject({ variant: "A", round: 1, final: true });
		expect(String(body.accepted?.fingerprint)).toMatch(/^none: /);
	});
});

describe("recordAcceptance", () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const found = (request: CaptureRequest): LayoutResult => ({
		root: { x: 0, y: 0, w: request.width, h: request.height },
		controls: [],
		themeApplied: request.theme,
	});
	const fake = (
		result: (request: CaptureRequest) => LayoutResult,
		seen: CaptureRequest[] = [],
	): (() => Promise<Capturer>) =>
		async () => ({
			async shot(request) {
				seen.push(request);
				return {
					png,
					html: "",
					finalUrl: request.url,
					menuFound: false,
					scrolled: false,
					engine: "playwright",
					fingerprint: result(request),
				};
			},
			async close() {},
		});
	const target = () => ({ dir: join(root, "sandbox"), name: "demo", chain: "demo" });
	const claim = { variant: "D", notes: "", source: "browser", url: "http://127.0.0.1:4321/" };
	const now = () => new Date("2026-11-03T18:22:10Z");

	test("reads six viewport and theme combinations and writes the reference shots", async () => {
		const seen: CaptureRequest[] = [];
		const record = await recordAcceptance(target(), claim, { open: fake(found, seen), now });
		expect(record.skipped).toBeNull();
		expect(record.root).toBe('[data-verify-root="demo"]');
		expect(record.fingerprint?.readings.map((reading) => `${reading.viewport}-${reading.theme}`).sort()).toEqual([
			"desktop-dark",
			"desktop-light",
			"mobile-dark",
			"mobile-light",
			"tablet-dark",
			"tablet-light",
		]);
		expect(seen).toHaveLength(6);
		for (const request of seen) {
			const url = new URL(request.url);
			expect(url.searchParams.get("variant")).toBe("D");
			expect(url.searchParams.get("mode")).toBe(request.theme);
			expect(request.fingerprintRoot).toBe('[data-verify-root="demo"]');
		}
		expect(readdirSync(join(root, "sandbox", "accepted"))).toHaveLength(6);
		expect(record.shots).toBe("accepted/");
		expect(record.at).toBe("2026-11-03T18:22:10.000Z");
		expect(JSON.parse(readFileSync(join(root, "sandbox", "accepted.json"), "utf8"))).toEqual(record);
	});

	test("drops the toolbar width override so each viewport reads the full layout", async () => {
		const seen: CaptureRequest[] = [];
		await recordAcceptance(target(), { ...claim, url: "http://127.0.0.1:4321/?variant=D&width=mobile" }, { open: fake(found, seen), now });
		expect(seen).toHaveLength(6);
		expect(seen.every((request) => new URL(request.url).searchParams.get("width") === null)).toBe(true);
	});

	test("clears the reference shots of the previous acceptance before it captures", async () => {
		mkdirSync(join(root, "sandbox", "accepted"), { recursive: true });
		writeFileSync(join(root, "sandbox", "accepted", "tablet-dark.png"), "old");
		writeFileSync(join(root, "sandbox", "accepted", "stale.png"), "old");
		await recordAcceptance(target(), claim, { open: fake(found), now });
		const files = readdirSync(join(root, "sandbox", "accepted"));
		expect(files).toHaveLength(6);
		expect(files).not.toContain("stale.png");
		expect(readFileSync(join(root, "sandbox", "accepted", "tablet-dark.png"), "utf8")).not.toBe("old");
	});

	test("records a skip when the root is missing and still keeps the shots", async () => {
		const record = await recordAcceptance(
			target(),
			claim,
			{ open: fake(() => ({ error: 'root: found 0 visible [data-verify-root="demo"]' })), now },
		);
		expect(record.fingerprint).toBeNull();
		expect(record.skipped).toBe('root: found 0 visible [data-verify-root="demo"]');
	});

	test("skips without opening a browser when no url was sent", async () => {
		let opened = false;
		const record = await recordAcceptance(
			target(),
			{ ...claim, url: undefined },
			{ open: async () => { opened = true; throw new Error("no"); }, now },
		);
		expect(opened).toBe(false);
		expect(record.skipped).toContain("no page url recorded");
	});

	test("skips a non-loopback url", async () => {
		const record = await recordAcceptance(
			target(),
			{ ...claim, url: "http://example.com/" },
			{ open: fake(found), now },
		);
		expect(record.fingerprint).toBeNull();
		expect(record.skipped).toContain("loopback");
	});

	test("never throws when the browser fails to open", async () => {
		const record = await recordAcceptance(
			target(),
			claim,
			{ open: async () => { throw new Error("spawn ENOENT"); }, now },
		);
		expect(record.skipped).toMatch(/browser/);
		expect(record.fingerprint).toBeNull();
	});

	test("stores the pick before the browser opens so a kill mid-capture keeps it", async () => {
		const notesClaim = { ...claim, notes: "tighten the header" };
		void recordAcceptance(target(), notesClaim, { open: () => new Promise<Capturer>(() => {}), now });
		const stored = JSON.parse(readFileSync(join(root, "sandbox", "accepted.json"), "utf8"));
		expect(stored).toMatchObject({
			variant: "D",
			notes: "tighten the header",
			source: "browser",
			url: "http://127.0.0.1:4321/",
			fingerprint: null,
			skipped: "recording interrupted; run prototype fingerprint demo --url=<url>",
		});
		expect(stored.history).toHaveLength(1);
	});

	test("replaces the stored pick with the final record once the capture ends", async () => {
		const record = await recordAcceptance(target(), claim, { open: fake(found), now });
		expect(record.skipped).toBeNull();
		expect(JSON.parse(readFileSync(join(root, "sandbox", "accepted.json"), "utf8")).skipped).toBeNull();
	});

	test("records a skip for a malformed url instead of throwing", async () => {
		const record = await recordAcceptance(target(), { ...claim, url: "not a url" }, { open: fake(found), now });
		expect(record.fingerprint).toBeNull();
		expect(record.skipped).toContain("not a valid url");
		expect(record.variant).toBe("D");
	});

	test("starts a fresh history after a final record", async () => {
		await recordAcceptance(target(), claim, { open: fake(found), now });
		const second = await recordAcceptance(target(), claim, { open: fake(found), now });
		expect(second.round).toBe(1);
		expect(second.history).toHaveLength(1);
	});
});

describe("accepted record text", () => {
	const base: AcceptedRecord = {
		version: 1,
		name: "demo",
		chain: "demo",
		mode: "local",
		variant: "D",
		label: "Trigger below",
		round: 3,
		notes: "",
		final: true,
		source: "browser",
		at: "2026-11-03T18:22:10.000Z",
		url: "http://127.0.0.1:4321/",
		root: '[data-verify-root="demo"]',
		fingerprint: {
			version: 1,
			root: '[data-verify-root="demo"]',
			readings: [
				{
					viewport: "desktop",
					width: 1440,
					height: 900,
					theme: "light",
					themeApplied: "light",
					root: { x: 0, y: 0, w: 800, h: 600 },
					controls: [
						{
							i: 0,
							role: "button",
							name: "Add | note",
							testid: "add",
							path: "button#add",
							box: { x: 1, y: 2, w: 3, h: 4 },
							band: "bottom",
							hband: "left",
							visible: true,
							occluded: false,
							occluder: null,
						},
					],
				},
			],
		},
		skipped: null,
		shots: "accepted/",
		history: [{ round: 3, variant: "D", notes: "", at: "2026-11-03T18:22:10.000Z" }],
	};

	test("parseRecord accepts a valid record and rejects another version", () => {
		expect(parseRecord(JSON.parse(JSON.stringify(base)))).toEqual(base);
		expect(() => parseRecord({ ...base, version: 2 })).toThrow();
		expect(() => parseRecord({ name: "x" })).toThrow();
	});

	test("renderAccepted lists the facts and one table per reading with no image references", () => {
		const text = renderAccepted(base, { sandbox: ".agents/prototype/demo" });
		expect(text).toContain(".agents/prototype/demo");
		expect(text).toContain("D (Trigger below)");
		expect(text).toContain('[data-verify-root="demo"]');
		expect(text).toContain("| 1 | button | Add \\| note | add | bottom/left | yes |");
		expect(text).toContain("desktop light");
		expect(text).not.toMatch(/!\[|\.png|\.jpe?g/);
	});

	test("renderAccepted states the reason when the fingerprint is missing", () => {
		const text = renderAccepted(
			{ ...base, fingerprint: null, skipped: "no page url recorded" },
			{ sandbox: "sandbox", waived: true },
		);
		expect(text).toContain("no page url recorded");
		expect(text).toContain("--no-fingerprint");
	});
});
