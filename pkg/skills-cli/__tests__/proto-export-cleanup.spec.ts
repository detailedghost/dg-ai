import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProtoPlan, Verdict } from "@dg/common";
import { exportApprovedAnswer } from "../src/commands/proto";
import {
	answerPagePath,
	dgProtoPath,
	protoScratchPath,
	protoSlug,
} from "../src/utils/proto-paths";

const temporaryDirectories: string[] = [];
const skillsCliRoot = join(import.meta.dir, "..");
const skillsCliEntry = join(skillsCliRoot, "src", "index.ts");

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "dg-proto-export-"));
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
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [skillsCliEntry, ...args], {
			cwd,
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

function buildPlan(
	url: string,
	question = "Which account summary works best?",
) {
	return {
		slug: protoSlug(url),
		question,
		mountSelector: "#account-summary",
		mode: "replace",
		variations: [
			{
				key: "compact",
				label: "Compact",
				html: [
					'<main id="winner">Compact answer</main>',
					'<img src="https://remote.test/tracker.png">',
				].join(""),
				css: [
					"#winner { color: rebeccapurple; }",
					'.remote { background: url("https://remote.test/image.png"); }',
				].join("\n"),
			},
			{
				key: "detailed",
				label: "Detailed",
				html: "<main>Detailed answer</main>",
				css: "main { padding: 2rem; }",
			},
		],
	} satisfies ProtoPlan;
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

async function protoHarness(
	verdict: Verdict,
	options: { preview?: string; question?: string } = {},
) {
	const directory = await temporaryDirectory();
	const projectRoot = join(directory, "project");
	const bin = join(directory, "bin");
	const downloads = join(directory, "downloads");
	const scratch = join(directory, "scratch");
	const openedUrlPath = join(directory, "opened-url.txt");
	const sourceUrl = `https://example.test/account?slug=${verdict.slug}`;
	const plan = buildPlan(
		sourceUrl,
		options.question ?? "Which account summary works best?",
	);
	plan.slug = verdict.slug;
	const planPath = join(directory, "plan.json");
	const styleGuidePath = protoScratchPath(plan.slug, "style-guide.json", {
		env: { AI_SCRATCH_DIR: scratch },
	});
	const verdictPath = join(downloads, dgProtoPath(plan.slug, "verdict.json"));
	const previewPath = join(downloads, dgProtoPath(plan.slug, "preview.png"));

	await Promise.all([
		mkdir(projectRoot, { recursive: true }),
		mkdir(bin, { recursive: true }),
		mkdir(dirname(styleGuidePath), { recursive: true }),
	]);
	await Promise.all([
		writeFile(planPath, JSON.stringify(plan)),
		writeFile(styleGuidePath, JSON.stringify(buildStyleGuide(sourceUrl))),
	]);
	await executable(
		join(bin, "xdg-user-dir"),
		'#!/bin/sh\nprintf "%s\\n" "$DG_TEST_DOWNLOADS"\n',
	);
	const opener = [
		"#!/bin/sh",
		'if [ "${DG_REQUIRE_STALE_REMOVED:-0}" = "1" ] && [ -e "$DG_TEST_VERDICT_PATH" ]; then',
		"  exit 41",
		"fi",
		'printf "%s" "$1" > "$DG_TEST_OPENED_URL"',
		'mkdir -p "$(dirname "$DG_TEST_VERDICT_PATH")"',
		'if [ -n "${DG_TEST_PREVIEW:-}" ]; then',
		'  printf "%s" "$DG_TEST_PREVIEW" > "$DG_TEST_PREVIEW_PATH"',
		"fi",
		'printf "%s" "$DG_TEST_VERDICT" > "$DG_TEST_VERDICT_PATH"',
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
		answerDirectory: join(projectRoot, ".agents", "prototype", plan.slug),
		downloads,
		env: {
			...process.env,
			AI_SCRATCH_DIR: scratch,
			DG_TEST_DOWNLOADS: downloads,
			DG_TEST_OPENED_URL: openedUrlPath,
			DG_TEST_PREVIEW: options.preview ?? "",
			DG_TEST_PREVIEW_PATH: previewPath,
			DG_TEST_VERDICT: JSON.stringify(verdict),
			DG_TEST_VERDICT_PATH: verdictPath,
			PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			WSL_DISTRO_NAME: "",
		} satisfies NodeJS.ProcessEnv,
		openedUrlPath,
		plan,
		planPath,
		previewPath,
		projectRoot,
		scratch,
		verdictPath,
	};
}

describe("proto plant answer export", () => {
	test("writes index, styles, optional preview, and NOTES in that exact order", async () => {
		const plan = buildPlan("https://example.test/ordered-export");
		const verdict = {
			slug: plan.slug,
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_567_999,
		} satisfies Verdict;
		const operations: string[] = [];

		await exportApprovedAnswer(plan, verdict, "/downloads/preview.png", {
			answerPath: (_slug, file) => `/answer/${file}`,
			copy: async (_source, destination) => {
				operations.push(`copy:${destination}`);
			},
			ensureSafePaths: async () => {},
			readText: async () => {
				throw Object.assign(new Error("not found"), { code: "ENOENT" });
			},
			removeFile: async () => {},
			writeText: async (path) => {
				operations.push(`write:${path}`);
			},
		});

		expect(operations).toEqual([
			"write:/answer/index.html",
			"write:/answer/styles.css",
			"copy:/answer/preview.png",
			"write:/answer/NOTES.md",
		]);
	});

	test("writes a cwd-relative self-contained answer and preview before the completion marker", async () => {
		const verdict = {
			slug: "account-answer",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_568_000,
		} satisfies Verdict;
		const harness = await protoHarness(verdict, {
			preview: "selected-preview-png",
		});

		const result = await runCli(
			harness.projectRoot,
			["proto", "plant", harness.planPath, "--timeout", "500"],
			harness.env,
		);

		const expectedIndexPath = join(harness.answerDirectory, "index.html");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(expectedIndexPath);
		expect(answerPagePath(verdict.slug, "index.html")).not.toBe(
			expectedIndexPath,
		);
		const [index, styles, preview, notes] = await Promise.all([
			readFile(expectedIndexPath, "utf8"),
			readFile(join(harness.answerDirectory, "styles.css"), "utf8"),
			readFile(join(harness.answerDirectory, "preview.png"), "utf8"),
			readFile(join(harness.answerDirectory, "NOTES.md"), "utf8"),
		]);
		expect(index).toContain("<style>");
		expect(index).toContain("#winner { color: rebeccapurple; }");
		expect(index).toContain('id="winner"');
		expect(index).not.toContain("remote.test");
		expect(index).not.toMatch(/<link\b/i);
		expect(styles).toBe(harness.plan.variations[0].css);
		expect(preview).toBe("selected-preview-png");
		expect(notes).toContain(harness.plan.question);
		expect(notes).toContain(verdict.selectedKey);
		expect(notes).toContain(String(verdict.ts));
		expect(notes).toMatch(/styles\.css.+do not propagate.+index\.html/is);
	});

	test("re-approve overwrites an existing answer but refuses an unrelated NOTES question", async () => {
		const verdict = {
			slug: "account-reapprove",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_568_001,
		} satisfies Verdict;
		const first = await protoHarness(verdict);
		const firstResult = await runCli(
			first.projectRoot,
			["proto", "plant", first.planPath, "--timeout", "500"],
			first.env,
		);
		expect(firstResult.code).toBe(0);
		await Promise.all([
			writeFile(join(first.answerDirectory, "index.html"), "stale index"),
			writeFile(join(first.answerDirectory, "styles.css"), "stale styles"),
			writeFile(join(first.answerDirectory, "preview.png"), "stale preview"),
		]);

		const secondResult = await runCli(
			first.projectRoot,
			["proto", "plant", first.planPath, "--timeout", "500"],
			first.env,
		);
		expect(secondResult.code).toBe(0);
		expect(
			await readFile(join(first.answerDirectory, "index.html"), "utf8"),
		).not.toBe("stale index");
		expect(
			await readFile(join(first.answerDirectory, "styles.css"), "utf8"),
		).not.toBe("stale styles");
		await expect(
			readFile(join(first.answerDirectory, "preview.png"), "utf8"),
		).rejects.toThrow();

		const unrelated = await protoHarness({
			...verdict,
			slug: "unrelated-answer",
		});
		await mkdir(unrelated.answerDirectory, { recursive: true });
		await Promise.all([
			writeFile(join(unrelated.answerDirectory, "index.html"), "keep me"),
			writeFile(
				join(unrelated.answerDirectory, "NOTES.md"),
				"# Different prototype\n\n## Question\n\nA different question.",
			),
		]);

		const unrelatedResult = await runCli(
			unrelated.projectRoot,
			["proto", "plant", unrelated.planPath, "--timeout", "500"],
			unrelated.env,
		);
		expect(unrelatedResult.code).toBe(1);
		expect(unrelatedResult.stderr).toMatch(
			/unrelated|different question|refus/i,
		);
		expect(
			await readFile(join(unrelated.answerDirectory, "index.html"), "utf8"),
		).toBe("keep me");
		await expect(readFile(unrelated.openedUrlPath, "utf8")).rejects.toThrow();
	});

	for (const outputFile of [
		"index.html",
		"styles.css",
		"preview.png",
		"NOTES.md",
	]) {
		test(`refuses symlinked ${outputFile} before modifying its external target`, async () => {
			const verdict = {
				slug: "account-symlinked-file",
				action: "approve",
				selectedKey: "compact",
				ts: 1_721_234_568_002,
			} satisfies Verdict;
			const harness = await protoHarness(verdict, { preview: "preview" });
			const externalSentinel = join(
				dirname(harness.projectRoot),
				`external-${outputFile}`,
			);
			await mkdir(harness.answerDirectory, { recursive: true });
			await writeFile(externalSentinel, "external sentinel");
			await symlink(
				externalSentinel,
				join(harness.answerDirectory, outputFile),
			);

			const result = await runCli(
				harness.projectRoot,
				["proto", "plant", harness.planPath, "--timeout", "500"],
				harness.env,
			);

			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(/symbolic link|symlink/i);
			expect(await readFile(externalSentinel, "utf8")).toBe(
				"external sentinel",
			);
			if (outputFile !== "index.html") {
				await expect(
					readFile(join(harness.answerDirectory, "index.html"), "utf8"),
				).rejects.toThrow();
			}
			await expect(readFile(harness.openedUrlPath, "utf8")).rejects.toThrow();
		});
	}

	test("refuses a symlinked answer ancestor without writing outside the project", async () => {
		const verdict = {
			slug: "account-symlinked-directory",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_568_003,
		} satisfies Verdict;
		const harness = await protoHarness(verdict, { preview: "preview" });
		const externalDirectory = join(
			dirname(harness.projectRoot),
			"external-answer-root",
		);
		const externalSentinel = join(externalDirectory, "sentinel.txt");
		await mkdir(externalDirectory, { recursive: true });
		await writeFile(externalSentinel, "external sentinel");
		await symlink(
			externalDirectory,
			join(harness.projectRoot, ".agents"),
			"dir",
		);

		const result = await runCli(
			harness.projectRoot,
			["proto", "plant", harness.planPath, "--timeout", "500"],
			harness.env,
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/symbolic link|symlink/i);
		expect(await readFile(externalSentinel, "utf8")).toBe("external sentinel");
		await expect(stat(join(externalDirectory, "prototype"))).rejects.toThrow();
		await expect(readFile(harness.openedUrlPath, "utf8")).rejects.toThrow();
	});

	test("refuses a symlinked answer directory without writing through it", async () => {
		const verdict = {
			slug: "account-symlinked-answer",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_568_004,
		} satisfies Verdict;
		const harness = await protoHarness(verdict, { preview: "preview" });
		const externalDirectory = join(
			dirname(harness.projectRoot),
			"external-answer",
		);
		const externalSentinel = join(externalDirectory, "sentinel.txt");
		await Promise.all([
			mkdir(dirname(harness.answerDirectory), { recursive: true }),
			mkdir(externalDirectory, { recursive: true }),
		]);
		await writeFile(externalSentinel, "external sentinel");
		await symlink(externalDirectory, harness.answerDirectory, "dir");

		const result = await runCli(
			harness.projectRoot,
			["proto", "plant", harness.planPath, "--timeout", "500"],
			harness.env,
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/symbolic link|symlink/i);
		expect(await readFile(externalSentinel, "utf8")).toBe("external sentinel");
		await expect(stat(join(externalDirectory, "index.html"))).rejects.toThrow();
		await expect(readFile(harness.openedUrlPath, "utf8")).rejects.toThrow();
	});

	test("surfaces reject feedback and re-plants the same slug against a fresh verdict", async () => {
		const firstVerdict = {
			slug: "account-rework",
			action: "reject",
			selectedKey: "detailed",
			feedback: "Keep the detail but reduce the density.",
			ts: 1_721_234_568_002,
		} satisfies Verdict;
		const harness = await protoHarness(firstVerdict);

		const firstResult = await runCli(
			harness.projectRoot,
			["proto", "plant", harness.planPath, "--timeout", "500"],
			harness.env,
		);
		expect(firstResult.code).toBe(0);
		expect(firstResult.stdout).toContain(firstVerdict.feedback);
		expect(firstResult.stdout).toMatch(/rework|re-plant|same slug/i);
		await expect(
			readFile(join(harness.answerDirectory, "NOTES.md"), "utf8"),
		).rejects.toThrow();

		const secondVerdict = {
			...firstVerdict,
			feedback: "The fresh second verdict.",
			ts: firstVerdict.ts + 1,
		};
		const secondResult = await runCli(
			harness.projectRoot,
			["proto", "plant", harness.planPath, "--timeout", "500"],
			{
				...harness.env,
				DG_REQUIRE_STALE_REMOVED: "1",
				DG_TEST_VERDICT: JSON.stringify(secondVerdict),
			},
		);
		expect(secondResult.code).toBe(0);
		expect(secondResult.stdout).toContain(secondVerdict.feedback);
		expect(secondResult.stdout).not.toContain(firstVerdict.feedback);
	});
});

describe("proto cleanup command", () => {
	test("requires the export marker before removing temporary artifacts", async () => {
		const verdict = {
			slug: "cleanup-without-export",
			action: "reject",
			selectedKey: "compact",
			feedback: "Not approved yet.",
			ts: 1_721_234_568_003,
		} satisfies Verdict;
		const harness = await protoHarness(verdict);
		const scratchFile = protoScratchPath(verdict.slug, "verdict.json", {
			env: { AI_SCRATCH_DIR: harness.scratch },
		});
		await Promise.all([
			mkdir(dirname(harness.verdictPath), { recursive: true }),
			mkdir(dirname(scratchFile), { recursive: true }),
		]);
		await Promise.all([
			writeFile(harness.verdictPath, "temporary verdict"),
			writeFile(scratchFile, "temporary scratch"),
		]);

		const result = await runCli(
			harness.projectRoot,
			["proto", "cleanup", verdict.slug],
			harness.env,
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`no exported answer found for ${verdict.slug} — run plant to approve first`,
		);
		expect(await readFile(harness.verdictPath, "utf8")).toBe(
			"temporary verdict",
		);
		expect(await readFile(scratchFile, "utf8")).toBe("temporary scratch");
	});

	test("removes Downloads and scratch artifacts, preserves the answer, and is idempotent", async () => {
		const verdict = {
			slug: "cleanup-exported",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_568_004,
		} satisfies Verdict;
		const harness = await protoHarness(verdict, { preview: "preview" });
		const plantResult = await runCli(
			harness.projectRoot,
			["proto", "plant", harness.planPath, "--timeout", "500"],
			harness.env,
		);
		expect(plantResult.code).toBe(0);
		const scratchFile = protoScratchPath(verdict.slug, "extra.tmp", {
			env: { AI_SCRATCH_DIR: harness.scratch },
		});
		await writeFile(scratchFile, "scratch");
		const notesBefore = await readFile(
			join(harness.answerDirectory, "NOTES.md"),
			"utf8",
		);

		const firstCleanup = await runCli(
			harness.projectRoot,
			["proto", "cleanup", verdict.slug],
			harness.env,
		);
		const secondCleanup = await runCli(
			harness.projectRoot,
			["proto", "cleanup", verdict.slug],
			harness.env,
		);

		expect(firstCleanup.code).toBe(0);
		expect(secondCleanup.code).toBe(0);
		await expect(
			readFile(
				join(harness.downloads, dgProtoPath(verdict.slug, "verdict.json")),
			),
		).rejects.toThrow();
		await expect(readFile(scratchFile, "utf8")).rejects.toThrow();
		expect(
			await readFile(join(harness.answerDirectory, "NOTES.md"), "utf8"),
		).toBe(notesBefore);
	});
});

describe("proto command help", () => {
	test("documents target-root operation and same-slug reject rework", async () => {
		const directory = await temporaryDirectory();
		const result = await runCli(directory, ["proto", "--help"], process.env);
		const plantHelp = await runCli(
			directory,
			["proto", "plant", "--help"],
			process.env,
		);
		const cleanupHelp = await runCli(
			directory,
			["proto", "cleanup", "--help"],
			process.env,
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/cleanup/);
		expect(plantHelp.stdout).toMatch(/target project root/i);
		expect(plantHelp.stdout).toMatch(/reject.+feedback.+same slug/is);
		expect(cleanupHelp.stdout).toMatch(/target project root/i);
	});
});
