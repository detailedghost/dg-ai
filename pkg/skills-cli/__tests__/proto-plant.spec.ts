import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { protoScratchPath, protoSlug } from "../src/utils/proto-paths";
import { protoDaemonFixture } from "./proto-cli-harness";

const temporaryDirectories: string[] = [];
const servers: Array<{ stop: () => void }> = [];
const skillsCliRoot = join(import.meta.dir, "..");
const skillsCliEntry = join(skillsCliRoot, "src", "index.ts");

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "dg-proto-plant-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop();
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

async function plantHarness(plan: ProtoPlan, verdictJson = "") {
	const directory = await temporaryDirectory();
	const projectRoot = join(directory, "project");
	const scratch = join(directory, "scratch");
	const dgHome = join(directory, "dg-home");
	const planPath = join(directory, "plan.json");
	const verdictScratchPath = protoScratchPath(plan.slug, "verdict.json", {
		env: { AI_SCRATCH_DIR: scratch },
	});
	const styleGuidePath = protoScratchPath(plan.slug, "style-guide.json", {
		env: { AI_SCRATCH_DIR: scratch },
	});

	await mkdir(projectRoot, { recursive: true });
	await mkdir(dirname(styleGuidePath), { recursive: true });
	await Promise.all([
		writeFile(planPath, JSON.stringify(plan)),
		writeFile(
			styleGuidePath,
			JSON.stringify(
				buildStyleGuide("https://example.test/account#tab=summary"),
			),
		),
	]);

	let currentVerdictJson = verdictJson;
	const server = protoDaemonFixture(
		{ cwd: projectRoot, dgHome },
		(request, reply) => {
			if (!currentVerdictJson) {
				reply({
					type: "cli-proto-result",
					sessionId: "fixture-cli-session",
					requestId: request.requestId,
					ok: false,
					error: "no verdict configured for this fixture",
				});
				return;
			}
			reply({
				type: "cli-proto-result",
				sessionId: "fixture-cli-session",
				requestId: request.requestId,
				ok: true,
				data: { kind: "verdict", verdict: JSON.parse(currentVerdictJson) },
			});
		},
	);
	servers.push(server);

	return {
		env: {
			...process.env,
			AI_SCRATCH_DIR: scratch,
			DG_HOME: dgHome,
			DG_TEST_PROJECT_ROOT: projectRoot,
			WSL_DISTRO_NAME: "",
		} as NodeJS.ProcessEnv,
		planPath,
		projectRoot,
		server,
		setVerdict(next: string): void {
			currentVerdictJson = next;
		},
		verdictScratchPath,
	};
}

function parseMarkedUrl(markedUrl: string) {
	const marker = new URLSearchParams(new URL(markedUrl).hash.slice(1)).get(
		"_proto",
	);
	if (!marker) throw new Error("marked URL did not contain a prototype marker");
	return {
		markedUrl,
		payload: JSON.parse(
			gunzipSync(Buffer.from(marker, "base64url")).toString("utf8"),
		) as { phase: string; slug: string; plan: ProtoPlan; expectedUrl: string },
	};
}

describe("proto plant command", () => {
	test("validates the plan before contacting the daemon", async () => {
		const url = "https://example.test/account";
		const invalid = {
			...buildPlan(url),
			mode: "overlay",
		} as unknown as ProtoPlan;
		const harness = await plantHarness(invalid);

		const result = await runCli(
			["proto", "--ext", "plant", harness.planPath, "--timeout", "250"],
			harness.env,
		);

		expect(result.code).toBe(1);
		expect(harness.server.requests).toHaveLength(0);
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
		test(`rejects ${invalidPlan.name} before contacting the daemon`, async () => {
			const url = `https://example.test/account?invalid=${encodeURIComponent(
				invalidPlan.name,
			)}`;
			const harness = await plantHarness(invalidPlan.build(url));

			const result = await runCli(
				["proto", "--ext", "plant", harness.planPath, "--timeout", "250"],
				harness.env,
			);

			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(invalidPlan.error);
			expect(harness.server.requests).toHaveLength(0);
		});
	}

	test("sanitizes every variation, overwrites a stale scratch verdict, and preserves the source fragment", async () => {
		const url = "https://example.test/account";
		const plan = buildPlan(url);
		const verdict: Verdict = {
			slug: plan.slug,
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_567_999,
		};
		const harness = await plantHarness(plan, JSON.stringify(verdict));
		await writeFile(harness.verdictScratchPath, '{"staleScratch":true}');

		const result = await runCli(
			["proto", "--ext", "plant", harness.planPath, "--timeout", "500"],
			harness.env,
		);
		expect(result.code).toBe(0);
		expect(harness.server.requests).toHaveLength(1);
		const { markedUrl, payload } = parseMarkedUrl(
			harness.server.requests[0]?.markedUrl as string,
		);

		expect(payload.phase).toBe("plant");
		expect(payload.slug).toBe(plan.slug);
		expect(payload.plan.variations.map((variation) => variation.html)).toEqual(
			plan.variations.map((variation) => sanitizeVariationHtml(variation.html)),
		);
		expect(
			new URLSearchParams(new URL(markedUrl).hash.slice(1)).get("tab"),
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

	test("rejects an oversized sanitized plan before contacting the daemon", async () => {
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
			["proto", "--ext", "plant", harness.planPath, "--timeout", "250"],
			harness.env,
		);

		expect(result.code).toBe(1);
		expect(harness.server.requests).toHaveLength(0);
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
		test(`reads, validates, and handles a fresh ${verdict.action} verdict from the daemon`, async () => {
			const url = `https://example.test/account?verdict=${verdict.action}`;
			const plan = buildPlan(url);
			const expected = {
				slug: plan.slug,
				...verdict,
				ts: 1_721_234_568_000,
			} as Verdict;
			const harness = await plantHarness(plan, JSON.stringify(expected));

			const result = await runCli(
				["proto", "--ext", "plant", harness.planPath, "--timeout", "500"],
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
			} else if (expected.action === "reject") {
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

	test("walks a refine chain through tweak, approve with notes, and a final approve", async () => {
		const url = "https://example.test/account?chain=refine";
		const plan = buildPlan(url);
		const harness = await plantHarness(plan);
		const verdictFor = (verdict: Record<string, string>) =>
			JSON.stringify({ slug: plan.slug, ts: 1_721_234_568_100, ...verdict });
		const plant = (verdict: Record<string, string>) => {
			harness.setVerdict(verdictFor(verdict));
			return runCli(
				["proto", "--ext", "plant", harness.planPath, "--timeout", "500"],
				harness.env,
			);
		};
		const notesPath = join(
			harness.projectRoot,
			".agents",
			"prototype",
			plan.slug,
			"NOTES.md",
		);
		const lineagePath = join(dirname(notesPath), "lineage.md");

		const tweak = await plant({
			action: "tweak",
			selectedKey: "compact",
			notes: "round the corners",
		});
		expect(tweak.code).toBe(0);
		expect(tweak.stdout.split("\n")[0]).toBe(
			"Prototype tweak requested (refine):",
		);
		expect(tweak.stdout).toContain("round the corners");
		await expect(readFile(notesPath, "utf8")).rejects.toThrow();
		await expect(readFile(lineagePath, "utf8")).rejects.toThrow();

		const refine = await plant({
			action: "approve",
			selectedKey: "compact",
			notes: "organize the buttons",
		});
		expect(refine.code).toBe(0);
		expect(refine.stdout.split("\n")[0]).toBe(
			"Prototype approved with notes (refine):",
		);
		expect(refine.stdout).toContain("Selected key: compact");
		expect(refine.stdout).toContain("Notes: organize the buttons");
		expect(refine.stdout).toContain(
			"Do not run cleanup until an approve with no notes.",
		);

		const final = await plant({ action: "approve", selectedKey: "detailed" });
		expect(final.code).toBe(0);
		expect(final.stdout.trim()).toBe(join(dirname(notesPath), "index.html"));

		const notes = await readFile(notesPath, "utf8");
		expect(notes).not.toContain("## Rounds");
		expect(notes).not.toContain("round-1");
		expect(notes).toContain("Round history lives in `lineage.md`");

		const lineage = await readFile(lineagePath, "utf8");
		expect(lineage).toContain(
			[
				"## round-1",
				"- base: none",
				"- variants: compact detailed",
				"- picked: compact",
				"- note: organize the buttons",
				"- tweaks:",
				"  - round the corners",
				"- status: done",
			].join("\n"),
		);
		expect(lineage).toContain(
			[
				"## round-2",
				"- base: round-1 compact",
				"- variants: compact detailed",
				"- picked: detailed",
				"- status: done",
			].join("\n"),
		);
	});

	describe("refine chain edge cases", () => {
		async function chainHarness(query: string) {
			const plan = buildPlan(`https://example.test/account?${query}`);
			const harness = await plantHarness(plan);
			const plant = (verdict: Record<string, string>) => {
				harness.setVerdict(
					JSON.stringify({
						slug: plan.slug,
						ts: 1_721_234_568_100,
						...verdict,
					}),
				);
				return runCli(
					["proto", "--ext", "plant", harness.planPath, "--timeout", "500"],
					harness.env,
				);
			};
			const tweaksPath = join(
				dirname(harness.verdictScratchPath),
				"tweaks.json",
			);
			const notesPath = join(
				harness.projectRoot,
				".agents",
				"prototype",
				plan.slug,
				"NOTES.md",
			);
			const lineagePath = join(dirname(notesPath), "lineage.md");
			return { plant, tweaksPath, notesPath, lineagePath };
		}

		test("drops pending tweaks when the round is rejected", async () => {
			const { plant, tweaksPath, lineagePath } =
				await chainHarness("edge=reject");
			await plant({
				action: "tweak",
				selectedKey: "compact",
				notes: "stale tweak",
			});
			await plant({
				action: "reject",
				selectedKey: "compact",
				feedback: "Start over.",
			});
			await expect(readFile(tweaksPath, "utf8")).rejects.toThrow();
			await plant({ action: "approve", selectedKey: "compact" });
			expect(await readFile(lineagePath, "utf8")).not.toContain(
				"stale tweak",
			);
		});

		test("fails with a clear error on a corrupt tweaks file", async () => {
			const { plant, tweaksPath } = await chainHarness("edge=corrupt");
			await plant({
				action: "tweak",
				selectedKey: "compact",
				notes: "first",
			});
			await writeFile(tweaksPath, '["unterminated');
			const broken = await plant({ action: "approve", selectedKey: "compact" });
			expect(broken.code).toBe(1);
			expect(broken.stderr).toMatch(/tweaks\.json/);
			await writeFile(tweaksPath, '{"not":"an array"}');
			const wrongShape = await plant({
				action: "approve",
				selectedKey: "compact",
			});
			expect(wrongShape.code).toBe(1);
			expect(wrongShape.stderr).toMatch(/tweaks\.json/);
		});

		test("starts at round-1 when lineage.md is missing and NOTES.md has no legacy Rounds section", async () => {
			const { plant, lineagePath } = await chainHarness("edge=missing");
			await plant({
				action: "approve",
				selectedKey: "compact",
				notes: "keep going",
			});
			await rm(lineagePath, { force: true });
			const again = await plant({ action: "approve", selectedKey: "detailed" });
			expect(again.code).toBe(0);
			const lineage = await readFile(lineagePath, "utf8");
			expect(lineage).toContain("## round-1\n- base: none");
			expect(lineage).not.toContain("## round-2");
		});

		test("migrates a pre-lineage.md NOTES.md's legacy ## Rounds section on the next approve", async () => {
			const { plant, notesPath, lineagePath } =
				await chainHarness("edge=legacy");
			await plant({
				action: "approve",
				selectedKey: "compact",
				notes: "keep going",
			});
			const legacyRound = (await readFile(lineagePath, "utf8"))
				.trim()
				.replace(/^## round-/, "### round-");
			const currentNotes = await readFile(notesPath, "utf8");
			await writeFile(
				notesPath,
				currentNotes.replace(
					/^## Verdict$/m,
					`## Rounds\n\n${legacyRound}\n\n## Verdict`,
				),
			);
			await rm(lineagePath, { force: true });

			const again = await plant({ action: "approve", selectedKey: "detailed" });
			expect(again.code).toBe(0);
			const notes = await readFile(notesPath, "utf8");
			expect(notes).not.toContain("## Rounds");
			expect(notes).not.toContain("round-1");
			const lineage = await readFile(lineagePath, "utf8");
			expect(lineage).toContain("## round-1\n- base: none");
			expect(lineage).toContain(
				"## round-2\n- base: round-1 compact\n- variants: compact detailed\n- picked: detailed",
			);
		});

		test("ignores a stale lineage.md left over from an unrelated question when NOTES.md is missing", async () => {
			const url = "https://example.test/account?chain=stale-lineage";
			const firstPlan = buildPlan(url, {
				question: "Which account summary works best?",
			});
			const harness = await plantHarness(firstPlan);
			const plant = (verdict: Record<string, string>) => {
				harness.setVerdict(
					JSON.stringify({
						slug: firstPlan.slug,
						ts: 1_721_234_568_100,
						...verdict,
					}),
				);
				return runCli(
					["proto", "--ext", "plant", harness.planPath, "--timeout", "500"],
					harness.env,
				);
			};
			const notesPath = join(
				harness.projectRoot,
				".agents",
				"prototype",
				firstPlan.slug,
				"NOTES.md",
			);
			const lineagePath = join(dirname(notesPath), "lineage.md");

			const opened = await plant({
				action: "approve",
				selectedKey: "compact",
				notes: "keep going",
			});
			expect(opened.code).toBe(0);
			await expect(readFile(lineagePath, "utf8")).resolves.toContain(
				"## round-1",
			);

			await rm(notesPath, { force: true });
			const secondPlan = buildPlan(url, {
				question: "A completely different question",
			});
			await writeFile(harness.planPath, JSON.stringify(secondPlan));

			const again = await plant({ action: "approve", selectedKey: "detailed" });
			expect(again.code).toBe(0);
			const lineage = await readFile(lineagePath, "utf8");
			expect(lineage).toContain("## round-1\n- base: none");
			expect(lineage).not.toContain("## round-2");
		});

		test("keeps a note line that mentions status from closing the round", async () => {
			const { plant, lineagePath } = await chainHarness("edge=status");
			await plant({
				action: "approve",
				selectedKey: "compact",
				notes: "mark - status: open here",
			});
			await plant({ action: "approve", selectedKey: "detailed" });
			const lineage = await readFile(lineagePath, "utf8");
			expect(lineage).toContain("- note: mark - status: open here");
			expect(lineage).toContain("- status: done\n\n## round-2");
		});
	});

	test("rejects a malformed verdict from the daemon instead of writing or printing it", async () => {
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
			["proto", "--ext", "plant", harness.planPath, "--timeout", "500"],
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
				["proto", "--ext", "plant", harness.planPath, "--timeout", "500"],
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
