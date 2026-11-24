import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptedSummary, recordAcceptance } from "../src/prototype/accepted";
import { sentinelPaths } from "../src/prototype/paths";
import { confirm, writeSentinel } from "../src/prototype/sentinels";
import { writeSignIn } from "../src/prototype/signin";
import type { Capturer } from "../src/verify/capture-model";
import { startSignInApp } from "./fixtures/prototype/signin-app";
import { makeTempDir } from "./git-repo-fixtures";
import { collectRun } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const WAIT_CLAIM = join(import.meta.dir, "fixtures/prototype/wait-claim.ts");
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");
const SHOT_MS = 1_000;

setDefaultTimeout(60_000);

let root: string;
let project: string;
let stopApp: (() => void) | undefined;
const children: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];

beforeEach(() => {
	root = makeTempDir("dg-prototype-fp-progress-");
	project = join(root, "project");
	mkdirSync(join(root, "scratch"), { recursive: true });
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	stopApp?.();
	stopApp = undefined;
	for (const child of children.splice(0)) child.kill();
	rmSync(root, { recursive: true, force: true });
});

const sandbox = () => join(project, ".agents", "prototype", "demo");

const env = () => ({
	...(process.env as Record<string, string>),
	AI_SCRATCH_DIR: join(root, "scratch"),
	DG_SKILLS_DIR: SKILLS,
	PROTOTYPE_UI_NO_OPEN: "1",
	DG_VERIFY_BROWSER: "/nonexistent",
});

async function statusFingerprint(): Promise<string> {
	const proc = Bun.spawn([process.execPath, ENTRY, "prototype", "status", "demo", "--json"], {
		cwd: project,
		env: env(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	const run = await collectRun(proc);
	return (JSON.parse(run.stdout) as { accepted: { fingerprint: string } }).accepted.fingerprint;
}

function pickBehindSignIn(): void {
	const app = startSignInApp();
	stopApp = app.stop;
	const variantB = `${app.origin}/ScheduleDoctor/ViewSchedule?variant=B`;
	writeSignIn(sandbox(), {
		signIn: `${app.origin}/prototype-signin?returnUrl=${encodeURIComponent("/ScheduleDoctor/ViewSchedule?variant=A")}`,
	});
	const paths = sentinelPaths(sandbox());
	confirm(paths, "B", "rework the flyout", "browser");
	writeSentinel(paths.url, `${variantB}\n`);
}

async function claimAndReadFirstLine() {
	const proc = Bun.spawn([process.execPath, WAIT_CLAIM, project, "demo", String(SHOT_MS)], {
		cwd: project,
		env: env(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	const reader = proc.stdout.getReader();
	let text = "";
	while (!text.includes("\n")) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += new TextDecoder().decode(chunk.value);
	}
	await reader.cancel();
	return { proc, first: text.split("\n")[0] ?? "" };
}

describe("a reader that looks while the fingerprint is still recording", () => {
	test("a caller that reads only the pick and closes the pipe sees recording in progress, then the full fingerprint", async () => {
		pickBehindSignIn();
		const { proc, first } = await claimAndReadFirstLine();
		expect(JSON.parse(first)).toEqual({ status: "ok", variant: "B", notes: "rework the flyout" });
		const during = await statusFingerprint();
		expect(during).toContain(`recording in progress (pid ${proc.pid})`);
		expect(during).not.toContain("interrupted");
		expect(await proc.exited).toBe(0);
		const record = JSON.parse(readFileSync(join(sandbox(), "accepted.json"), "utf8")) as {
			skipped: string | null;
			fingerprint: { readings: unknown[] } | null;
			recording?: unknown;
		};
		expect(record.skipped).toBeNull();
		expect(record.fingerprint?.readings).toHaveLength(6);
		expect(record.recording).toBeUndefined();
		expect(await statusFingerprint()).toBe("6 readings");
		expect(await new Response(proc.stderr).text()).toContain("it is final when this command exits");
	});

	test("a recorder killed mid-capture reads back as interrupted, naming the pid that exited", async () => {
		pickBehindSignIn();
		const { proc } = await claimAndReadFirstLine();
		const deadline = Date.now() + 10_000;
		while (!existsSync(join(sandbox(), "accepted.json"))) {
			if (Date.now() > deadline) throw new Error("the claim never stored its placeholder record");
			await Bun.sleep(20);
		}
		proc.kill("SIGKILL");
		await proc.exited;
		const after = await statusFingerprint();
		expect(after).toContain(`recording interrupted: recorder pid ${proc.pid} exited before the fingerprint finished`);
		expect(after).toContain("run prototype fingerprint demo --url=");
		expect(after).not.toContain("in progress");
	});
});

describe("the stored record while recording", () => {
	const claim = { variant: "D", notes: "", source: "browser", url: "http://127.0.0.1:4321/" };
	const now = () => new Date("2026-11-23T00:00:00.000Z");

	test("names this process as the recorder until the capture ends", async () => {
		const dir = join(root, "sandbox");
		let seen: string | undefined;
		const open = async (): Promise<Capturer> => {
			seen = acceptedSummary(dir)?.fingerprint;
			throw new Error("spawn ENOENT");
		};
		const record = await recordAcceptance({ dir, name: "demo", chain: "demo" }, claim, { open, now });
		expect(seen).toBe(`recording in progress (pid ${process.pid}); the record is final when that process exits`);
		expect(record.skipped).toContain("browser unavailable");
		expect(acceptedSummary(dir)?.fingerprint).toContain("none: browser unavailable");
	});

	test("a placeholder whose recorder pid is still alive but far too old says interrupted, as after pid reuse", async () => {
		const dir = join(root, "sandbox");
		void recordAcceptance({ dir, name: "demo", chain: "demo" }, claim, { open: () => new Promise<Capturer>(() => {}), now });
		const stored = JSON.parse(readFileSync(join(dir, "accepted.json"), "utf8"));
		writeFileSync(
			join(dir, "accepted.json"),
			JSON.stringify({ ...stored, recording: { pid: process.pid, at: "2026-01-01T00:00:00.000Z" } }),
		);
		expect(acceptedSummary(dir)?.fingerprint).toContain(`recording interrupted: recorder pid ${process.pid} did not finish within 5 minutes`);
	});

	test("a placeholder left by a recorder that is gone says interrupted", async () => {
		const dir = join(root, "sandbox");
		const gone = Bun.spawn(["true"]);
		await gone.exited;
		void recordAcceptance({ dir, name: "demo", chain: "demo" }, claim, { open: () => new Promise<Capturer>(() => {}), now });
		const stored = JSON.parse(readFileSync(join(dir, "accepted.json"), "utf8"));
		writeFileSync(join(dir, "accepted.json"), JSON.stringify({ ...stored, recording: { ...stored.recording, pid: gone.pid } }));
		expect(acceptedSummary(dir)?.fingerprint).toBe(
			`none: recording interrupted: recorder pid ${gone.pid} exited before the fingerprint finished; run prototype fingerprint demo --url=<url>`,
		);
	});
});
