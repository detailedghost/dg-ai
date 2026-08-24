import { constants } from "node:fs";
import {
	access,
	copyFile,
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	assembleAnswerPage,
	type ProtoPlan,
	sanitizeVariationHtml,
	type Verdict,
	validateProtoIdentifier,
	validateProtoPlan,
	validateProtoRenderLimits,
	validateStyleGuide,
	validateVerdict,
} from "@dg/common";
import { tryOpen } from "@dg/common/node";
import type { Command } from "commander";
import { addProtoMarker, protoPayloadFits } from "../utils/proto-marker";
import {
	answerPagePath,
	dgProtoPath,
	pollForFile,
	protoScratchPath,
	protoSlug,
	resolveDownloadsDir,
} from "../utils/proto-paths";

const DEFAULT_TIMEOUT_MS = 45_000;

type ScrapeOptions = {
	timeoutMs?: number;
};

type PlantOptions = {
	timeoutMs?: number;
};

/** Injectable filesystem operations used by the guarded answer exporter. */
export type AnswerExportSeams = {
	answerPath(slug: string, file: string): string;
	copy(source: string, destination: string): Promise<void>;
	ensureSafePaths(paths: string[], createDirectories: boolean): Promise<void>;
	readText(path: string): Promise<string>;
	removeFile(path: string): Promise<void>;
	writeText(path: string, contents: string): Promise<void>;
};

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const ANSWER_WRITE_FLAGS =
	constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | NO_FOLLOW;

function isContainedBy(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot !== "" &&
		pathFromRoot !== ".." &&
		!pathFromRoot.startsWith(`..${sep}`) &&
		!isAbsolute(pathFromRoot)
	);
}

async function lstatIfExists(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

function unsafeAnswerPath(path: string, detail: string): Error {
	return new Error(`Refusing prototype answer export: ${path} ${detail}.`);
}

async function ensureSafeAnswerPaths(
	paths: string[],
	createDirectories: boolean,
): Promise<void> {
	if (paths.length === 0) {
		throw new TypeError("prototype answer export requires output paths");
	}

	const projectRoot = resolve(process.cwd());
	const answerDirectory = dirname(paths[0]);
	if (
		!paths.every(
			(path) => path === resolve(path) && dirname(path) === answerDirectory,
		) ||
		!isContainedBy(projectRoot, answerDirectory)
	) {
		throw unsafeAnswerPath(
			answerDirectory,
			"is outside the target project's answer directory",
		);
	}

	const relativeDirectory = relative(projectRoot, answerDirectory);
	let currentDirectory = projectRoot;
	let directoryExists = true;
	for (const component of relativeDirectory.split(sep)) {
		currentDirectory = join(currentDirectory, component);
		let info = directoryExists
			? await lstatIfExists(currentDirectory)
			: undefined;
		if (!info && createDirectories) {
			try {
				await mkdir(currentDirectory);
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						(error as NodeJS.ErrnoException).code === "EEXIST"
					)
				) {
					throw error;
				}
			}
			info = await lstat(currentDirectory);
		}
		if (!info) {
			directoryExists = false;
			continue;
		}
		if (info.isSymbolicLink()) {
			throw unsafeAnswerPath(currentDirectory, "is a symbolic link");
		}
		if (!info.isDirectory()) {
			throw unsafeAnswerPath(currentDirectory, "is not a directory");
		}
	}

	if (directoryExists) {
		const [realProjectRoot, realAnswerDirectory] = await Promise.all([
			realpath(projectRoot),
			realpath(answerDirectory),
		]);
		if (!isContainedBy(realProjectRoot, realAnswerDirectory)) {
			throw unsafeAnswerPath(
				answerDirectory,
				"resolves outside the target project",
			);
		}
	}

	for (const path of paths) {
		const info = await lstatIfExists(path);
		if (!info) continue;
		if (info.isSymbolicLink()) {
			throw unsafeAnswerPath(path, "is a symbolic link");
		}
		if (!info.isFile()) {
			throw unsafeAnswerPath(path, "is not a regular file");
		}
	}
}

async function writeTextNoFollow(
	path: string,
	contents: string,
): Promise<void> {
	const handle = await open(path, ANSWER_WRITE_FLAGS, 0o666);
	try {
		await handle.writeFile(contents, "utf8");
	} finally {
		await handle.close();
	}
}

async function copyNoFollow(
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	const source = await open(sourcePath, constants.O_RDONLY);
	let destination: Awaited<ReturnType<typeof open>> | undefined;
	try {
		destination = await open(destinationPath, ANSWER_WRITE_FLAGS, 0o666);
		await destination.writeFile(await source.readFile());
	} finally {
		await Promise.all([source.close(), destination?.close()]);
	}
}

const DEFAULT_ANSWER_EXPORT_SEAMS: AnswerExportSeams = {
	answerPath: answerPagePath,
	copy: copyNoFollow,
	ensureSafePaths: ensureSafeAnswerPaths,
	readText: (path) => readFile(path, "utf8"),
	removeFile: async (path) => {
		await rm(path, { force: true });
	},
	writeText: writeTextNoFollow,
};

function isMissingFile(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function answerQuestionMarker(question: string | undefined): string {
	const encoded = Buffer.from(
		JSON.stringify(question ?? null),
		"utf8",
	).toString("base64url");
	return `<!-- dg-proto-question: ${encoded} -->`;
}

function answerNotes(plan: ProtoPlan, verdict: Verdict): string {
	const question = plan.question?.trim() || "_No question provided._";
	return [
		answerQuestionMarker(plan.question),
		"# Prototype answer",
		"",
		"## Question",
		"",
		question,
		"",
		"## Verdict",
		"",
		"```json",
		JSON.stringify(verdict, null, 2),
		"```",
		"",
		"## Editing",
		"",
		"`index.html` is the self-contained answer. Edits to `styles.css` do not propagate back into `index.html`; apply intended changes to both files.",
		"",
	].join("\n");
}

type AnswerPaths = {
	index: string;
	notes: string;
	preview: string;
	styles: string;
};

function answerPaths(plan: ProtoPlan, seams: AnswerExportSeams): AnswerPaths {
	return {
		index: seams.answerPath(plan.slug, "index.html"),
		styles: seams.answerPath(plan.slug, "styles.css"),
		preview: seams.answerPath(plan.slug, "preview.png"),
		notes: seams.answerPath(plan.slug, "NOTES.md"),
	};
}

function answerPathList(paths: AnswerPaths): string[] {
	return [paths.index, paths.styles, paths.preview, paths.notes];
}

async function assertAnswerTargetBelongsToPlan(
	plan: ProtoPlan,
	seams: AnswerExportSeams = DEFAULT_ANSWER_EXPORT_SEAMS,
	paths: AnswerPaths = answerPaths(plan, seams),
): Promise<void> {
	await seams.ensureSafePaths(answerPathList(paths), false);
	let notes: string;
	try {
		notes = await seams.readText(paths.notes);
	} catch (error) {
		if (isMissingFile(error)) return;
		throw error;
	}

	if (!notes.includes(answerQuestionMarker(plan.question))) {
		throw new Error(
			`Refusing to overwrite unrelated prototype answer at ${dirname(paths.notes)}: NOTES.md records a different question.`,
		);
	}
}

/** Export the approved variation and optional preview into the target project. */
export async function exportApprovedAnswer(
	plan: ProtoPlan,
	verdict: Extract<Verdict, { action: "approve" }>,
	previewDownloadPath: string,
	overrides: Partial<AnswerExportSeams> = {},
): Promise<string> {
	const seams = { ...DEFAULT_ANSWER_EXPORT_SEAMS, ...overrides };
	const paths = answerPaths(plan, seams);
	await assertAnswerTargetBelongsToPlan(plan, seams, paths);
	const selected = plan.variations.find(
		(variation) => variation.key === verdict.selectedKey,
	);
	if (!selected) {
		throw new TypeError(
			"verdict.selectedKey does not belong to the prototype plan",
		);
	}

	await seams.ensureSafePaths(answerPathList(paths), true);

	// NOTES.md is the export-complete marker. Remove it and any stale optional
	// preview before beginning a same-slug overwrite.
	await Promise.all([
		seams.removeFile(paths.notes),
		seams.removeFile(paths.preview),
	]);

	// Keep this order fixed: NOTES.md must only appear after every answer file.
	await seams.writeText(
		paths.index,
		assembleAnswerPage(selected, {
			scrapedAt: verdict.ts,
			question: plan.question,
		}),
	);
	await seams.writeText(paths.styles, selected.css);
	try {
		await seams.copy(previewDownloadPath, paths.preview);
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	await seams.writeText(paths.notes, answerNotes(plan, verdict));
	return paths.index;
}

/** Open a marked page, wait for its style guide download, and persist a stable copy. */
export async function scrapePrototype(
	url: string,
	options: ScrapeOptions = {},
): Promise<string> {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new TypeError("proto scrape requires an http(s) URL");
	}

	const slug = protoSlug(url);
	const downloadPath = join(
		resolveDownloadsDir(),
		dgProtoPath(slug, "style-guide.json"),
	);
	const partialPath = `${downloadPath}.crdownload`;
	await Promise.all([
		rm(downloadPath, { force: true }),
		rm(partialPath, { force: true }),
	]);

	const markedUrl = addProtoMarker(url, { phase: "scrape", slug });
	if (!(await tryOpen(markedUrl))) {
		throw new Error(`Could not open the browser for ${url}`);
	}

	const value = await pollForFile(downloadPath, {
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
	try {
		validateStyleGuide(value);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Invalid style guide downloaded at ${downloadPath}: ${detail}`,
		);
	}

	const outputPath = protoScratchPath(slug, "style-guide.json");
	await mkdir(dirname(outputPath), { recursive: true });
	await copyFile(downloadPath, outputPath);
	return outputPath;
}

/**
 * Open a validated prototype plan on the page recorded by its stable style
 * guide, then wait for the extension to return a fresh validated verdict.
 */
export async function plantPrototype(
	planPath: string,
	options: PlantOptions = {},
): Promise<string> {
	const plan = validateProtoRenderLimits(
		validateProtoPlan(JSON.parse(await readFile(planPath, "utf8"))),
	);
	await assertAnswerTargetBelongsToPlan(plan);
	const styleGuidePath = protoScratchPath(plan.slug, "style-guide.json");
	const styleGuide = validateStyleGuide(
		JSON.parse(await readFile(styleGuidePath, "utf8")),
	);
	const sourceUrl = new URL(styleGuide.meta.url);
	if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
		throw new TypeError("prototype style guide requires an http(s) source URL");
	}

	// This dependency-free pass reduces marker size and obvious risk. The
	// extension repeats sanitization with DOMParser at the render boundary.
	const sanitizedPlan: ProtoPlan = validateProtoRenderLimits(
		validateProtoPlan({
			...plan,
			variations: plan.variations.map((variation) => ({
				...variation,
				html: sanitizeVariationHtml(variation.html),
			})),
		}),
	);
	const payload = {
		phase: "plant" as const,
		slug: sanitizedPlan.slug,
		plan: sanitizedPlan,
	};
	if (!protoPayloadFits(styleGuide.meta.url, payload)) {
		throw new RangeError(
			"Prototype marker exceeds the 32K URL limit; trim your variations and retry.",
		);
	}

	const downloadPath = join(
		resolveDownloadsDir(),
		dgProtoPath(sanitizedPlan.slug, "verdict.json"),
	);
	const previewDownloadPath = join(
		resolveDownloadsDir(),
		dgProtoPath(sanitizedPlan.slug, "preview.png"),
	);
	await Promise.all([
		rm(downloadPath, { force: true }),
		rm(`${downloadPath}.crdownload`, { force: true }),
		rm(previewDownloadPath, { force: true }),
		rm(`${previewDownloadPath}.crdownload`, { force: true }),
	]);

	const markedUrl = addProtoMarker(styleGuide.meta.url, payload);
	if (!(await tryOpen(markedUrl))) {
		throw new Error(`Could not open the browser for ${styleGuide.meta.url}`);
	}

	const downloaded = await pollForFile(downloadPath, {
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
	let verdict: Verdict;
	try {
		verdict = validateVerdict(downloaded);
		if (verdict.slug !== sanitizedPlan.slug) {
			throw new TypeError("verdict.slug does not match the prototype plan");
		}
		if (
			!sanitizedPlan.variations.some(
				(variation) => variation.key === verdict.selectedKey,
			)
		) {
			throw new TypeError(
				"verdict.selectedKey does not belong to the prototype plan",
			);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid verdict downloaded at ${downloadPath}: ${detail}`);
	}

	const outputPath = protoScratchPath(sanitizedPlan.slug, "verdict.json");
	await mkdir(dirname(outputPath), { recursive: true });
	const json = `${JSON.stringify(verdict, null, 2)}\n`;
	await writeFile(outputPath, json);
	if (verdict.action === "reject") {
		return [
			`Prototype rejected: ${verdict.feedback}`,
			`Rework the plan and re-plant the same slug (${verdict.slug}) for a fresh verdict.`,
		].join("\n");
	}
	return exportApprovedAnswer(sanitizedPlan, verdict, previewDownloadPath);
}

/** Remove throwaway browser/scratch artifacts after a durable answer exists. */
export async function cleanupPrototype(slug: string): Promise<string> {
	validateProtoIdentifier(slug, "prototype cleanup slug");
	const markerPath = answerPagePath(slug, "NOTES.md");
	try {
		await access(markerPath);
	} catch (error) {
		if (!isMissingFile(error)) throw error;
		throw new Error(
			`no exported answer found for ${slug} — run plant to approve first`,
		);
	}

	const downloadsPath = join(resolveDownloadsDir(), dgProtoPath(slug, ""));
	const scratchPath = protoScratchPath(slug, "");
	await Promise.all([
		rm(downloadsPath, { force: true, recursive: true }),
		rm(scratchPath, { force: true, recursive: true }),
	]);
	return `Removed temporary prototype artifacts for ${slug}.`;
}

function timeoutValue(value: string): number {
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new TypeError("--timeout must be a positive number of milliseconds");
	}
	return timeout;
}

/** Register the `proto scrape`, `plant`, and `cleanup` CLI commands. */
export function registerProto(program: Command): void {
	const proto = program
		.command("proto")
		.description("prototype a live page through the dg-ai-extension")
		.addHelpText(
			"after",
			"\nRun plant and cleanup from the target project root so durable answers resolve into that project's .agents/prototype directory.\n",
		);

	proto
		.command("scrape")
		.description("collect a page style guide into stable agent scratch")
		.argument("<url>", "live http(s) page to inspect")
		.option(
			"--timeout <ms>",
			"download timeout in milliseconds",
			String(DEFAULT_TIMEOUT_MS),
		)
		.action(async (url: string, options: { timeout: string }) => {
			const output = await scrapePrototype(url, {
				timeoutMs: timeoutValue(options.timeout),
			});
			console.log(output);
		});

	proto
		.command("plant")
		.description("plant prototype variations and wait for a browser verdict")
		.argument("<plan>", "path to a prototype plan JSON file")
		.option(
			"--timeout <ms>",
			"verdict timeout in milliseconds",
			String(DEFAULT_TIMEOUT_MS),
		)
		.addHelpText(
			"after",
			"\nRun from the target project root. A reject surfaces feedback so the agent can rework and re-plant the same slug for a fresh verdict.\n",
		)
		.action(async (planPath: string, options: { timeout: string }) => {
			console.log(
				await plantPrototype(planPath, {
					timeoutMs: timeoutValue(options.timeout),
				}),
			);
		});

	proto
		.command("cleanup")
		.description(
			"remove temporary prototype downloads and scratch after approval",
		)
		.argument("<slug>", "approved prototype slug")
		.addHelpText(
			"after",
			"\nRun from the target project root. The durable .agents/prototype/<slug> answer is preserved.\n",
		)
		.action(async (slug: string) => {
			console.log(await cleanupPrototype(slug));
		});
}
