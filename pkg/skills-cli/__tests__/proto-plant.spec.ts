import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	PROTO_MAX_MARKUP_CHARS,
	PROTO_MAX_VARIATIONS,
	type ProtoPlan,
	sanitizeVariationHtml,
	type Verdict,
	validateVerdict,
} from "@dg/common";
import {
	dgProtoPath,
	protoScratchPath,
	protoSlug,
} from "../src/utils/proto-paths";

const temporaryDirectories: string[] = [];
const skillsCliRoot = join(import.meta.dir, "..");
const skillsCliEntry = join(skillsCliRoot, "src", "index.ts");

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "dg-proto-plant-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function buildPlan(url: string, overrides: Partial<ProtoPlan> = {}): ProtoPlan {
	return {
		slug: protoSlug(url),
		question: "Which account summary works best?",
		mountSelector: "#account-summary",
		mode: "replace",
		variations: [
			{
				key: "compact",
				label: "Compact",
				html: '<section><img src="x" onerror="alert(1)"><p>Compact</p></section>',
				css: ".summary { padding: 1rem; }",
			},
			{
				key: "detailed",
				label: "Detailed",
				html: '<section><a href="javascript:alert(2)">Details</a></section>',
				css: ".summary { padding: 2rem; }",
			},
		],
		...overrides,
	};
}

function buildStyleGuide(url: string) {
	return {
		meta: { url, scrapedAt: 1_721_234_567_890, sameOrigin: true },
		tokens: {
			customProps: {},
			colors: ["rgb(0, 0, 0)"],
			fontStack: "sans-serif",
			typeScale: [],
			spacing: [],
			radii: [],
			shadows: [],
		},
		components: { button: {}, input: {}, link: {} },
	};
}

async function executable(path: string, source: string): Promise<void> {
	await writeFile(path, source);
	await chmod(path, 0o755);
}

type CliResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};

async function runCli(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [skillsCliEntry, ...args], {
			cwd: env.DG_TEST_PROJECT_ROOT ?? skillsCliRoot,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
}

async function plantHarness(
	plan: ProtoPlan,
	verdictJson = "",
): Promise<{
	env: NodeJS.ProcessEnv;
	openedUrlPath: string;
	planPath: string;
	projectRoot: string;
	verdictDownloadPath: string;
	verdictScratchPath: string;
}> {
	const directory = await temporaryDirectory();
	const bin = join(directory, "bin");
	const downloads = join(directory, "downloads");
	const projectRoot = join(directory, "project");
	const scratch = join(directory, "scratch");
	const planPath = join(directory, "plan.json");
	const openedUrlPath = join(directory, "opened-url.txt");
	const verdictDownloadPath = join(
		downloads,
		dgProtoPath(plan.slug, "verdict.json"),
	);
	const verdictScratchPath = protoScratchPath(plan.slug, "verdict.json", {
		env: { AI_SCRATCH_DIR: scratch },
	});
	const styleGuidePath = protoScratchPath(plan.slug, "style-guide.json", {
		env: { AI_SCRATCH_DIR: scratch },
	});

	await Promise.all([
		mkdir(bin, { recursive: true }),
		mkdir(projectRoot, { recursive: true }),
		mkdir(dirname(styleGuidePath), { recursive: true }),
	]);
	await Promise.all([
		writeFile(planPath, JSON.stringify(plan)),
		writeFile(
			styleGuidePath,
			JSON.stringify(
				buildStyleGuide("https://example.test/account#tab=summary"),
			),
		),
	]);
	await executable(
		join(bin, "xdg-user-dir"),
		'#!/bin/sh\nprintf "%s\\n" "$DG_TEST_DOWNLOADS"\n',
	);
	const opener = [
		"#!/bin/sh",
		'if [ "${DG_REQUIRE_STALE_REMOVED:-0}" = "1" ] && { [ -e "$DG_TEST_VERDICT_PATH" ] || [ -e "$DG_TEST_VERDICT_PATH.crdownload" ]; }; then',
		"  exit 41",
		"fi",
		'printf "%s" "$1" > "$DG_TEST_OPENED_URL"',
		'if [ -n "${DG_TEST_VERDICT:-}" ]; then',
		'  mkdir -p "$(dirname "$DG_TEST_VERDICT_PATH")"',
		'  printf "%s" "$DG_TEST_VERDICT" > "$DG_TEST_VERDICT_PATH"',
		"fi",
		"exit 0",
		"",
	].join("\n");
	await Promise.all([
		executable(join(bin, "xdg-open"), opener),
		executable(join(bin, "wslview"), opener),
		executable(
			join(bin, "cmd.exe"),
			'#!/bin/sh\nprintf "%s\\n" "C:\\\\Users\\\\Ada"\n',
		),
		executable(
			join(bin, "wslpath"),
			'#!/bin/sh\nprintf "%s\\n" "$DG_TEST_DOWNLOADS"\n',
		),
	]);

	return {
		env: {
			...process.env,
			AI_SCRATCH_DIR: scratch,
			DG_TEST_DOWNLOADS: downloads,
			DG_TEST_PROJECT_ROOT: projectRoot,
			DG_TEST_OPENED_URL: openedUrlPath,
			DG_TEST_VERDICT: verdictJson,
			DG_TEST_VERDICT_PATH: verdictDownloadPath,
			PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			WSL_DISTRO_NAME: "",
		},
		openedUrlPath,
		planPath,
		projectRoot,
		verdictDownloadPath,
		verdictScratchPath,
	};
}

async function readPlantPayload(openedUrlPath: string) {
	const openedUrl = await readFile(openedUrlPath, "utf8");
	const marker = new URLSearchParams(new URL(openedUrl).hash.slice(1)).get(
		"_proto",
	);
	if (!marker) throw new Error("opened URL did not contain a prototype marker");
	return {
		openedUrl,
		payload: JSON.parse(
			gunzipSync(Buffer.from(marker, "base64url")).toString("utf8"),
		) as { phase: string; slug: string; plan: ProtoPlan },
	};
}

describe("proto plant command", () => {
	test("validates the plan before opening a browser", async () => {
		const url = "https://example.test/account";
		const invalid = {
			...buildPlan(url),
			mode: "overlay",
		} as unknown as ProtoPlan;
		const harness = await plantHarness(invalid);

		const result = await runCli(
			["proto", "plant", harness.planPath, "--timeout", "250"],
			harness.env,
		);

		expect(result.code).toBe(1);
		await expect(readFile(harness.openedUrlPath, "utf8")).rejects.toThrow();
		expect(result.stderr).toMatch(/prototype plan|mode/i);
	});

	for (const invalidPlan of [
		{
			name: "more than five variations",
			build(url: string): ProtoPlan {
				return buildPlan(url, {
					variations: Array.from(
						{ length: PROTO_MAX_VARIATIONS + 1 },
						(_, index) => ({
							key: `variation-${index}`,
							label: `Variation ${index}`,
							html: `<p>Variation ${index}</p>`,
							css: "p { color: black; }",
						}),
					),
				});
			},
			error: /at most 5 variations|remove extra variations/i,
		},
		{
			name: "highly compressible markup over the render cap",
			build(url: string): ProtoPlan {
				return buildPlan(url, {
					variations: [
						{
							key: "too-large",
							label: "Too large",
							html: "x".repeat(PROTO_MAX_MARKUP_CHARS + 1),
							css: "",
						},
					],
				});
			},
			error: /HTML\+CSS|524288|trim variation markup/i,
		},
	] as const) {
		test(`rejects ${invalidPlan.name} before opening a browser`, async () => {
			const url = `https://example.test/account?invalid=${encodeURIComponent(
				invalidPlan.name,
			)}`;
			const harness = await plantHarness(invalidPlan.build(url));

			const result = await runCli(
				["proto", "plant", harness.planPath, "--timeout", "250"],
				harness.env,
			);

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(invalidPlan.error);
			await expect(readFile(harness.openedUrlPath, "utf8")).rejects.toThrow();
		});
	}

	test("sanitizes every variation, clears stale verdicts, and preserves the source fragment", async () => {
		const url = "https://example.test/account";
		const plan = buildPlan(url);
		const verdict: Verdict = {
			slug: plan.slug,
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_567_999,
		};
		const harness = await plantHarness(plan, JSON.stringify(verdict));
		await mkdir(dirname(harness.verdictDownloadPath), { recursive: true });
		await Promise.all([
			writeFile(harness.verdictDownloadPath, '{"stale":true}'),
			writeFile(`${harness.verdictDownloadPath}.crdownload`, "stale partial"),
			writeFile(harness.verdictScratchPath, '{"staleScratch":true}'),
		]);

		const result = await runCli(
			["proto", "plant", harness.planPath, "--timeout", "500"],
			{
				...harness.env,
				DG_REQUIRE_STALE_REMOVED: "1",
			},
		);
		expect(result.code).toBe(0);
		const { openedUrl, payload } = await readPlantPayload(
			harness.openedUrlPath,
		);

		expect(payload.phase).toBe("plant");
		expect(payload.slug).toBe(plan.slug);
		expect(payload.plan.variations.map((variation) => variation.html)).toEqual(
			plan.variations.map((variation) => sanitizeVariationHtml(variation.html)),
		);
		expect(
			new URLSearchParams(new URL(openedUrl).hash.slice(1)).get("tab"),
		).toBe("summary");
		expect(result.stdout.trim()).toBe(
			join(
				harness.projectRoot,
				".agents",
				"prototype",
				plan.slug,
				"index.html",
			),
		);
		expect(
			validateVerdict(
				JSON.parse(await readFile(harness.verdictScratchPath, "utf8")),
			),
		).toEqual(verdict);
	});

	test("rejects an oversized sanitized plan before opening", async () => {
		const url = "https://example.test/account";
		const plan = buildPlan(url, {
			variations: [
				{
					key: "oversized",
					label: "Oversized",
					html: "<section>Still benign</section>",
					css: randomBytes(100_000).toString("base64"),
				},
			],
		});
		const harness = await plantHarness(plan);

		const result = await runCli(
			["proto", "plant", harness.planPath, "--timeout", "250"],
			harness.env,
		);

		expect(result.code).toBe(1);
		await expect(readFile(harness.openedUrlPath, "utf8")).rejects.toThrow();
		expect(result.stderr).toMatch(/32K|trim your variations/i);
	});

	for (const verdict of [
		{
			action: "approve",
			selectedKey: "compact",
		},
		{
			action: "reject",
			selectedKey: "detailed",
			feedback: "Keep the detail but reduce the density.",
		},
	] as const) {
		test(`reads, validates, copies, and handles a fresh ${verdict.action} verdict`, async () => {
			const url = `https://example.test/account?verdict=${verdict.action}`;
			const plan = buildPlan(url);
			const expected = {
				slug: plan.slug,
				...verdict,
				ts: 1_721_234_568_000,
			} as Verdict;
			const harness = await plantHarness(plan, JSON.stringify(expected));

			const result = await runCli(
				["proto", "plant", harness.planPath, "--timeout", "500"],
				harness.env,
			);

			expect(result.code).toBe(0);
			if (expected.action === "approve") {
				expect(result.stdout.trim()).toBe(
					join(
						harness.projectRoot,
						".agents",
						"prototype",
						plan.slug,
						"index.html",
					),
				);
			} else {
				expect(result.stdout).toContain(expected.feedback);
				expect(result.stdout).toMatch(/same slug|re-plant/i);
			}
			expect(
				validateVerdict(
					JSON.parse(await readFile(harness.verdictScratchPath, "utf8")),
				),
			).toEqual(expected);
		});
	}

	test("rejects a malformed downloaded verdict instead of copying or printing it", async () => {
		const url = "https://example.test/account?verdict=invalid";
		const plan = buildPlan(url);
		const harness = await plantHarness(
			plan,
			JSON.stringify({
				slug: plan.slug,
				action: "approve",
				selectedKey: "",
				ts: 1_721_234_568_001,
			}),
		);

		const result = await runCli(
			["proto", "plant", harness.planPath, "--timeout", "500"],
			harness.env,
		);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		await expect(
			readFile(harness.verdictScratchPath, "utf8"),
		).rejects.toThrow();
		expect(result.stderr).toMatch(/invalid verdict|selectedKey/i);
	});

	for (const invalidVerdict of [
		{
			name: "a different prototype slug",
			build(plan: ProtoPlan): Verdict {
				return {
					slug: "different-prototype",
					action: "approve",
					selectedKey: plan.variations[0].key,
					ts: 1_721_234_568_002,
				};
			},
			error: /verdict\.slug does not match/i,
		},
		{
			name: "a selected key outside the plan",
			build(plan: ProtoPlan): Verdict {
				return {
					slug: plan.slug,
					action: "reject",
					selectedKey: "not-a-plan-variation",
					feedback: "This key was never offered.",
					ts: 1_721_234_568_003,
				};
			},
			error: /selectedKey does not belong/i,
		},
	]) {
		test(`rejects a structurally valid verdict with ${invalidVerdict.name}`, async () => {
			const url = `https://example.test/account?invalid=${encodeURIComponent(
				invalidVerdict.name,
			)}`;
			const plan = buildPlan(url);
			const harness = await plantHarness(
				plan,
				JSON.stringify(invalidVerdict.build(plan)),
			);

			const result = await runCli(
				["proto", "plant", harness.planPath, "--timeout", "500"],
				harness.env,
			);

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			await expect(
				readFile(harness.verdictScratchPath, "utf8"),
			).rejects.toThrow();
			expect(result.stderr).toMatch(invalidVerdict.error);
		});
	}
});
