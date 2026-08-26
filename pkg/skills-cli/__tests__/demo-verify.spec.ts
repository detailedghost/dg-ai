/**
 * `demo --verify <plan.md>` — the AI's own real-browser check before handing a
 * plan to the user. Exercised end-to-end (real subprocess, real Chromium, real
 * dg-ai-extension) rather than mocked: the whole point is that findings can't
 * drift from the extension's actual behaviour (see slice 6 brief).
 *
 * Exit-code semantics aren't pinned by the spec; these tests assume 0 (no
 * `process.exit` in the sibling `--print` path either) and focus primarily on
 * "stdout is parseable JSON with the right shape" as the load-bearing check.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TourScript, TourStep } from "@dg/common";
import { toPlanMarkdown } from "@dg/common";
import {
	browserArgs,
	sandboxDisabled,
} from "../src/utils/cdp-harness";
import { callInSubprocess, mergeEnv } from "./module-call";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const EXTENSION_DIR = join(import.meta.dir, "..", "..", "extension");
const EXTENSION_MANIFEST = join(
	EXTENSION_DIR,
	".output",
	"chrome-mv3",
	"manifest.json",
);
const DEMO_VERIFY = join(
	import.meta.dir,
	"..",
	"src",
	"utils",
	"demo-verify.ts",
);

type VerifyResult = { ok: boolean; findings: Array<Record<string, unknown>> };

async function runVerify(
	planPath: string,
	env?: Record<string, string | undefined>,
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", ENTRY, "demo", "--verify", planPath], {
		stdout: "pipe",
		stderr: "pipe",
		...(env ? { env: mergeEnv(env) } : {}),
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

function writePlan(dir: string, name: string, script: TourScript): string {
	const path = join(dir, name);
	writeFileSync(path, toPlanMarkdown(script));
	return path;
}

/** Parse the CLI's stdout the way a caller must — throws if it isn't valid JSON. */
function parseVerify(out: string): VerifyResult {
	return JSON.parse(out);
}

/** A clean run, or a failure that names what the harness actually reported. */
function expectClean(result: VerifyResult): void {
	if (result.ok) return;
	throw new Error(`expected a clean plan; verify reported ${describeFindings(result)}`);
}

/** The finding of `kind`, or a failure carrying every finding verify did report. */
function requireFinding(
	result: VerifyResult,
	kind: string,
): Record<string, unknown> {
	const found = result.findings.find((f) => f.kind === kind);
	if (!found) throw new Error(`no ${kind} finding in ${describeFindings(result)}`);
	return found;
}

function describeFindings(result: VerifyResult): string {
	return JSON.stringify(result.findings, null, 1);
}

describe("demo --verify", () => {
	let server: ReturnType<typeof Bun.serve>;
	let base: string;
	let dir: string;

	/** Shared fixture script: base URL + title, per-test steps only. */
	function scriptWithSteps(steps: TourStep[]): TourScript {
		return { title: "verify fixture", startUrl: `${base}/entry.html`, steps };
	}

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/entry.html") {
					return new Response(
						"<!doctype html><html><body>" +
							'<div id="ok-target">Ready</div>' +
							'<a id="next-link" href="/landed.html">Next</a>' +
							"</body></html>",
						{ headers: { "content-type": "text/html" } },
					);
				}
				if (path === "/landed.html") {
					return new Response(
						'<!doctype html><html><body><h1 id="landed">Landed</h1></body></html>',
						{ headers: { "content-type": "text/html" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});
		base = `http://127.0.0.1:${server.port}`;
		dir = mkdtempSync(join(tmpdir(), "dg-verify-fixtures-"));

		// The harness needs a real built extension to load; build once for a fresh
		// checkout that has never run `bun run build` under pkg/extension.
		if (!existsSync(EXTENSION_MANIFEST)) {
			Bun.spawnSync(["bun", "run", "build"], { cwd: EXTENSION_DIR });
		}
	});

	afterAll(() => {
		server?.stop(true);
	});

	test("a wrong selector is reported as selector-unresolved, naming the step and selector", async () => {
		const script = scriptWithSteps([
			{
				title: "Missing target",
				selector: "#totally-bogus-selector-xyz",
				body: "This selector should not resolve.",
				advance: 500,
			},
			{ title: "Done", body: "End of tour.", advance: 500 },
		]);
		const plan = writePlan(dir, "wrong-selector.md", script);
		const { code, out } = await runVerify(plan);
		expect(code).toBe(0);
		const result = parseVerify(out);
		expect(result.ok).toBe(false);
		const finding = requireFinding(result, "selector-unresolved");
		expect(finding.selector).toBe("#totally-bogus-selector-xyz");
		// Ambiguous whether `step` is 0- or 1-indexed; the plan's own authored
		// numbering (`toPlanMarkdown`'s `i + 1`) is 1-indexed and is what an
		// agent re-reading the plan.md to fix it would expect, so that's assumed.
		expect(finding.step).toBe(1);
	}, 45000);

	test("a click that navigates with no authored `navigate` is reported as unrecorded-navigation with the landed URL", async () => {
		const script = scriptWithSteps([
			{
				title: "Follow the link",
				selector: "#next-link",
				body: "Clicking this leaves the page.",
				action: { do: "click" },
				advance: 500,
			},
			{
				title: "Arrived",
				body: "You should now be on the next page.",
				advance: 500,
			},
		]);
		const plan = writePlan(dir, "unrecorded-nav.md", script);
		const { code, out } = await runVerify(plan);
		expect(code).toBe(0);
		const result = parseVerify(out);
		expect(result.ok).toBe(false);
		const finding = requireFinding(result, "unrecorded-navigation");
		expect(finding.url).toBe(`${base}/landed.html`);
		expect(typeof finding.step).toBe("number");
	}, 45000);

	test("a clean plan yields ok:true and no findings", async () => {
		const script = scriptWithSteps([
			{
				title: "Look here",
				selector: "#ok-target",
				body: "This selector resolves fine.",
				advance: 500,
			},
			{ title: "Done", body: "End of the clean tour.", advance: 500 },
		]);
		const plan = writePlan(dir, "clean.md", script);
		const { code, out } = await runVerify(plan);
		expect(code).toBe(0);
		const result = parseVerify(out);
		expectClean(result);
		expect(result.findings).toEqual([]);
	}, 45000);

	test("a malformed plan is reported as a finding, never an unhandled throw", async () => {
		// No `startUrl`, no `## Steps`, no ```json fallback block — the real
		// parser (extractScriptFromMarkdown) throws; --verify must catch that,
		// not let it crash the process or print a bare stack trace.
		const path = join(dir, "malformed.md");
		writeFileSync(path, "---\ntitle: Broken\n---\n\nnothing parseable here\n");
		const { out } = await runVerify(path);
		expect(() => JSON.parse(out)).not.toThrow();
		const result = parseVerify(out);
		expect(result.ok).toBe(false);
		expect(result.findings.length).toBeGreaterThan(0);
		expect(typeof result.findings[0].kind).toBe("string");
	}, 15000);

	test("findings JSON is written to the process's real stdout, not just captured in-memory", async () => {
		const script = scriptWithSteps([
			{
				title: "Look here",
				selector: "#ok-target",
				body: "Fine.",
				advance: 500,
			},
		]);
		const plan = writePlan(dir, "stdout-sink.md", script);
		const proc = Bun.spawn(["bun", ENTRY, "demo", "--verify", plan], {
			stdout: "pipe",
			stderr: "pipe",
		});
		// Stream straight off the child's OS pipe, not through a console.log stub.
		const chunks: Uint8Array[] = [];
		for await (const chunk of proc.stdout) chunks.push(chunk as Uint8Array);
		await proc.exited;
		const out = Buffer.concat(chunks).toString("utf8");
		expect(() => JSON.parse(out)).not.toThrow();
		expectClean(parseVerify(out));
	}, 45000);

	test("two concurrent verify runs both succeed — a throwaway profile per run, not the user's browser", async () => {
		const planA = writePlan(
			dir,
			"concurrent-a.md",
			scriptWithSteps([
				{ title: "A", selector: "#ok-target", body: "A.", advance: 300 },
			]),
		);
		const planB = writePlan(
			dir,
			"concurrent-b.md",
			scriptWithSteps([
				{ title: "B", selector: "#ok-target", body: "B.", advance: 300 },
			]),
		);
		const [a, b] = await Promise.all([runVerify(planA), runVerify(planB)]);
		expect(a.code).toBe(0);
		expect(b.code).toBe(0);
		expectClean(parseVerify(a.out));
		expectClean(parseVerify(b.out));
	}, 60000);

	test("a plan path that does not exist is reported as plan-unreadable, not thrown", async () => {
		const missing = join(dir, "does-not-exist.md");
		const { code, out } = await runVerify(missing);
		expect(code).toBe(0);
		const result = parseVerify(out);
		expect(result.ok).toBe(false);
		expect(result.findings).toEqual([
			{
				step: 0,
				kind: "plan-unreadable",
				message: expect.stringContaining("ENOENT"),
			},
		]);
	}, 15000);

	test("a schema-invalid JSON script (non-.md path) is reported as plan-unreadable, not thrown", async () => {
		const path = join(dir, "invalid-schema.json");
		writeFileSync(path, JSON.stringify({ startUrl: "not-a-url", steps: [] }));
		const { code, out } = await runVerify(path);
		expect(code).toBe(0);
		const result = parseVerify(out);
		expect(result.ok).toBe(false);
		expect(result.findings).toEqual([
			{
				step: 0,
				kind: "plan-unreadable",
				message: expect.stringContaining("startUrl"),
			},
		]);
	}, 15000);

	test("a broken DG_VERIFY_BROWSER override is reported as a harness-error finding, not a crash", async () => {
		const plan = writePlan(
			dir,
			"harness-error.md",
			scriptWithSteps([
				{
					title: "Look here",
					selector: "#ok-target",
					body: "Fine.",
					advance: 500,
				},
			]),
		);
		const { code, out } = await runVerify(plan, {
			DG_VERIFY_BROWSER: "/nonexistent/binary-does-not-exist-xyz",
		});
		expect(code).toBe(0);
		const result = parseVerify(out);
		expect(result.ok).toBe(false);
		expect(result.findings).toEqual([
			{
				step: 0,
				kind: "harness-error",
				message: expect.stringContaining(
					"nonexistent/binary-does-not-exist-xyz",
				),
			},
		]);
	}, 15000);
});

describe("resolveExtensionDir", () => {
	test("a dev checkout's own build takes priority over any staged install", async () => {
		const fakeRepoRoot = mkdtempSync(join(tmpdir(), "dg-verify-fake-repo-"));
		const devDir = join(
			fakeRepoRoot,
			"pkg",
			"extension",
			".output",
			"chrome-mv3",
		);
		mkdirSync(devDir, { recursive: true });
		writeFileSync(
			join(devDir, "manifest.json"),
			JSON.stringify({ name: "dev-sentinel" }),
		);
		try {
			const result = await callInSubprocess(
				DEMO_VERIFY,
				"resolveExtensionDir",
				{
					CLAUDE_PLUGIN_ROOT: fakeRepoRoot,
				},
			);
			expect(result).toEqual({ ok: true, value: devDir });
		} finally {
			rmSync(fakeRepoRoot, { recursive: true, force: true });
		}
	});
});

describe("browser sandbox flag", () => {
	test("a normal run keeps the sandbox", () => {
		expect(sandboxDisabled({})).toBe(false);
		expect(browserArgs("/p", "/e")).not.toContain("--no-sandbox");
	});

	test("DG_VERIFY_NO_SANDBOX turns it off, for a kernel that gives Chrome no usable one", () => {
		expect(sandboxDisabled({ DG_VERIFY_NO_SANDBOX: "1" })).toBe(true);
	});

	test("the launch args always carry the throwaway profile and the extension under test", () => {
		const args = browserArgs("/tmp/profile", "/tmp/ext");

		expect(args).toContain("--user-data-dir=/tmp/profile");
		expect(args).toContain("--load-extension=/tmp/ext");
		expect(args).toContain("--disable-extensions-except=/tmp/ext");
		expect(args).toContain("--remote-debugging-port=0");
	});
});
