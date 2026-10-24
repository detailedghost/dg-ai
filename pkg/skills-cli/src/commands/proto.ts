import { constants } from "node:fs";
import {
	access,
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
	PROTO_MAX_TIMEOUT_MS,
	type ProtoBrowserData,
	type ProtoCliResult,
	type ProtoNotReadyError,
	type ProtoPlan,
	sanitizeVariationHtml,
	type Verdict,
	validateProtoBrowserData,
	validateProtoIdentifier,
	validateProtoPlan,
	validateProtoRenderLimits,
	validateStyleGuide,
	validateVerdict,
} from "@dg/common";
import { CliClient, resolveCliSession } from "@dg/common/node";
import { Command } from "commander";
import { USAGE as PROTOTYPE_USAGE, main as runPrototype } from "../prototype";
import { DEFAULT_TIMEOUT_SEC } from "../prototype/args";
import { assertExtensionInstalled } from "../utils/cli-only";
import { registerRawCommand } from "../utils/legacy-command";
import { addProtoMarker, protoPayloadFits } from "../utils/proto-marker";
import { answerPagePath, protoScratchPath, protoSlug } from "../utils/proto-paths";

const DEFAULT_TIMEOUT_MS = 45_000;
/** A human deciding on a planted page, not a download; same wait as local mode's `wait` default. */
const DEFAULT_PLANT_TIMEOUT_MS = DEFAULT_TIMEOUT_SEC * 1000;

type ScrapeOptions = {
	timeoutMs?: number;
	session?: string;
};

type PlantOptions = {
	timeoutMs?: number;
	session?: string;
};

/** A typed not-ready failure the extension reported instead of scraping or planting. */
export class ProtoNotReadyFailure extends Error {
	constructor(readonly notReady: ProtoNotReadyError) {
		super(
			`Prototype ${notReady.code === "mount-missing" ? "plant" : "scrape/plant"} is not ready (${notReady.code}): ${notReady.message} It landed on ${notReady.landedUrl}.`,
		);
		this.name = "ProtoNotReadyFailure";
	}
}

function isProtoCliResult(
	value: unknown,
	requestId: string,
): value is ProtoCliResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "cli-proto-result" &&
		"requestId" in value &&
		value.requestId === requestId
	);
}

/**
 * Run one scrape or plant through the daemon relay: the extension opens the
 * marked URL in a paired browser and hands its result back over the same
 * authenticated session the CLI connects with. Never touches the filesystem
 * or a browser directly.
 */
async function runProtoBrowserRequest(input: {
	phase: "scrape" | "plant";
	slug: string;
	markedUrl: string;
	timeoutMs: number;
	session?: string;
}): Promise<ProtoBrowserData> {
	const requestId = crypto.randomUUID();
	let client: CliClient | undefined;
	try {
		const resolved = await resolveCliSession(input.session);
		client = await CliClient.connect(resolved);
	} catch (error) {
		throw new Error(
			"Prototype --ext requires a dg daemon session with a paired extension. Run dg-agent start --open, then pass --session ID (or use that session's working directory), open the printed /start#_chat= URL in the paired browser, and run dg-skills install if the binaries need updating. " +
				(error instanceof Error ? error.message : String(error)),
		);
	}
	try {
		const response = await client.request(
			{
				type: "cli-proto-request",
				requestId,
				phase: input.phase,
				slug: input.slug,
				markedUrl: input.markedUrl,
				timeoutMs: input.timeoutMs,
			},
			(value): value is ProtoCliResult => isProtoCliResult(value, requestId),
			input.timeoutMs + 5_000,
		);
		if (!response.ok) {
			if (response.notReady) throw new ProtoNotReadyFailure(response.notReady);
			throw new Error(
				response.error ?? "prototype extension request failed",
			);
		}
		try {
			return validateProtoBrowserData(response.data);
		} catch (error) {
			throw new Error(
				`Invalid response from the extension: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	} finally {
		client.close();
	}
}

/** Injectable filesystem operations used by the guarded answer exporter. */
export type AnswerExportSeams = {
	answerPath(slug: string, file: string): string;
	writeBinary(path: string, data: Uint8Array): Promise<void>;
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

async function writeBinaryNoFollow(
	path: string,
	data: Uint8Array,
): Promise<void> {
	const handle = await open(path, ANSWER_WRITE_FLAGS, 0o666);
	try {
		await handle.writeFile(data);
	} finally {
		await handle.close();
	}
}

const DEFAULT_ANSWER_EXPORT_SEAMS: AnswerExportSeams = {
	answerPath: answerPagePath,
	writeBinary: writeBinaryNoFollow,
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

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

const OPEN_STATUS_LINE = /^- status: open$/m;
const TWEAKS_FILE = "tweaks.json";

/** Round blocks from a lineage.md: one `## round-N` heading per block, no wrapper. */
function openLineageRounds(lineage: string | undefined): string[] {
	const blocks = (lineage ?? "")
		.split(/^(?=## round-\d+$)/m)
		.map((block) => block.trim())
		.filter(Boolean);
	return blocks.at(-1) && OPEN_STATUS_LINE.test(blocks.at(-1) as string)
		? blocks
		: [];
}

/**
 * Migration path for a NOTES.md written before lineage.md existed: the same
 * round blocks, nested under `## Rounds` ... `## Verdict` with `### round-N`
 * headings. Converted to the lineage.md heading level on read so both shapes
 * merge into one format going forward.
 */
function legacyOpenRounds(priorNotes: string | undefined): string[] {
	const section = priorNotes?.match(/^## Rounds\n([\s\S]*?)^## Verdict$/m)?.[1];
	const blocks = (section ?? "")
		.split(/^(?=### round-\d+$)/m)
		.map((block) => block.trim().replace(/^### round-/, "## round-"))
		.filter(Boolean);
	return blocks.at(-1) && OPEN_STATUS_LINE.test(blocks.at(-1) as string)
		? blocks
		: [];
}

function roundBlock(
	plan: ProtoPlan,
	verdict: Extract<Verdict, { action: "approve" }>,
	earlier: string[],
	tweaks: string[],
): string {
	const previousPick = earlier.at(-1)?.match(/^- picked: (.+)$/m)?.[1];
	const number = earlier.length + 1;
	return [
		`## round-${number}`,
		`- base: ${previousPick ? `round-${number - 1} ${previousPick}` : "none"}`,
		`- variants: ${plan.variations.map((variation) => variation.key).join(" ")}`,
		`- picked: ${verdict.selectedKey}`,
		...(verdict.notes ? [`- note: ${oneLine(verdict.notes)}`] : []),
		...(tweaks.length > 0
			? ["- tweaks:", ...tweaks.map((tweak) => `  - ${oneLine(tweak)}`)]
			: []),
		`- status: ${verdict.notes ? "open" : "done"}`,
	].join("\n");
}

/** Build the full lineage.md body: every earlier round closed, then the new one. */
function lineageContents(
	plan: ProtoPlan,
	verdict: Extract<Verdict, { action: "approve" }>,
	earlier: string[],
	tweaks: string[],
): string {
	const rounds = [
		...earlier.map((block) =>
			block.replace(OPEN_STATUS_LINE, "- status: done"),
		),
		roundBlock(plan, verdict, earlier, tweaks),
	];
	return `${rounds.join("\n\n")}\n`;
}

function answerNotes(
	plan: ProtoPlan,
	verdict: Extract<Verdict, { action: "approve" }>,
): string {
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
		"Round history lives in `lineage.md` next to this file.",
		"",
	].join("\n");
}

type AnswerPaths = {
	index: string;
	lineage: string;
	notes: string;
	preview: string;
	styles: string;
};

function answerPaths(plan: ProtoPlan, seams: AnswerExportSeams): AnswerPaths {
	return {
		index: seams.answerPath(plan.slug, "index.html"),
		lineage: seams.answerPath(plan.slug, "lineage.md"),
		styles: seams.answerPath(plan.slug, "styles.css"),
		preview: seams.answerPath(plan.slug, "preview.png"),
		notes: seams.answerPath(plan.slug, "NOTES.md"),
	};
}

function answerPathList(paths: AnswerPaths): string[] {
	return [paths.index, paths.lineage, paths.styles, paths.preview, paths.notes];
}

async function readVerifiedPriorNotes(
	plan: ProtoPlan,
	seams: AnswerExportSeams = DEFAULT_ANSWER_EXPORT_SEAMS,
	paths: AnswerPaths = answerPaths(plan, seams),
): Promise<string | undefined> {
	await seams.ensureSafePaths(answerPathList(paths), false);
	let notes: string;
	try {
		notes = await seams.readText(paths.notes);
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}

	if (!notes.includes(answerQuestionMarker(plan.question))) {
		throw new Error(
			`Refusing to overwrite unrelated prototype answer at ${dirname(paths.notes)}: NOTES.md records a different question.`,
		);
	}
	return notes;
}

/**
 * Prior round blocks for this slug, only once `priorNotes` confirms a
 * verified same-question NOTES.md exists — never read a same-slug lineage.md
 * left over from an unrelated question with no NOTES.md to vouch for it.
 * Reads lineage.md when present; otherwise migrates the legacy `## Rounds`
 * section of that NOTES.md, so an older chain started before lineage.md
 * existed still resumes.
 */
async function readPriorRounds(
	seams: AnswerExportSeams,
	paths: AnswerPaths,
	priorNotes: string | undefined,
): Promise<string[]> {
	if (priorNotes !== undefined) {
		try {
			return openLineageRounds(await seams.readText(paths.lineage));
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
	return legacyOpenRounds(priorNotes);
}

/** Export the approved variation and optional preview into the target project. */
export async function exportApprovedAnswer(
	plan: ProtoPlan,
	verdict: Extract<Verdict, { action: "approve" }>,
	previewDataUrl: string | undefined,
	overrides: Partial<AnswerExportSeams> = {},
	tweaks: string[] = [],
): Promise<string> {
	const seams = { ...DEFAULT_ANSWER_EXPORT_SEAMS, ...overrides };
	const paths = answerPaths(plan, seams);
	const priorNotes = await readVerifiedPriorNotes(plan, seams, paths);
	const earlierRounds = await readPriorRounds(seams, paths, priorNotes);
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
	if (previewDataUrl) {
		const base64 = previewDataUrl.slice(previewDataUrl.indexOf(",") + 1);
		await seams.writeBinary(paths.preview, Buffer.from(base64, "base64"));
	}
	await seams.writeText(
		paths.lineage,
		lineageContents(plan, verdict, earlierRounds, tweaks),
	);
	await seams.writeText(paths.notes, answerNotes(plan, verdict));
	return paths.index;
}

/**
 * Open a marked page through the daemon relay and persist a stable copy of
 * the style guide the extension hands back. Never touches Downloads or any
 * browser-process filesystem; the CLI only waits on the daemon.
 */
export async function scrapePrototype(
	url: string,
	options: ScrapeOptions = {},
): Promise<string> {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new TypeError("proto scrape requires an http(s) URL");
	}

	const slug = protoSlug(url);
	const markedUrl = addProtoMarker(url, {
		phase: "scrape",
		slug,
		expectedUrl: url,
	});
	const data = await runProtoBrowserRequest({
		phase: "scrape",
		slug,
		markedUrl,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		session: options.session,
	});
	if (data.kind !== "style-guide") {
		throw new Error(
			"The extension returned a verdict for a scrape request; re-run scrape with a fresh slug.",
		);
	}

	const outputPath = protoScratchPath(slug, "style-guide.json");
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${JSON.stringify(data.styleGuide, null, 2)}\n`);
	return outputPath;
}

/**
 * Open a validated prototype plan through the daemon relay and wait for the
 * extension to hand back a fresh validated verdict. Never touches Downloads
 * or any browser-process filesystem; the CLI only waits on the daemon.
 */
export async function plantPrototype(
	planPath: string,
	options: PlantOptions = {},
): Promise<string> {
	const plan = validateProtoRenderLimits(
		validateProtoPlan(JSON.parse(await readFile(planPath, "utf8"))),
	);
	await readVerifiedPriorNotes(plan);
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
		expectedUrl: styleGuide.meta.url,
	};
	if (!protoPayloadFits(styleGuide.meta.url, payload)) {
		throw new RangeError(
			"Prototype marker exceeds the 32K URL limit; trim your variations and retry.",
		);
	}

	const markedUrl = addProtoMarker(styleGuide.meta.url, payload);
	const data = await runProtoBrowserRequest({
		phase: "plant",
		slug: sanitizedPlan.slug,
		markedUrl,
		timeoutMs: options.timeoutMs ?? DEFAULT_PLANT_TIMEOUT_MS,
		session: options.session,
	});
	if (data.kind !== "verdict") {
		throw new Error(
			"The extension returned a style guide for a plant request; re-run plant with a fresh plan.",
		);
	}
	const verdict = data.verdict;
	if (verdict.slug !== sanitizedPlan.slug) {
		throw new Error("Invalid verdict: verdict.slug does not match the prototype plan");
	}
	if (
		!sanitizedPlan.variations.some(
			(variation) => variation.key === verdict.selectedKey,
		)
	) {
		throw new Error(
			"Invalid verdict: verdict.selectedKey does not belong to the prototype plan",
		);
	}

	const outputPath = protoScratchPath(sanitizedPlan.slug, "verdict.json");
	await mkdir(dirname(outputPath), { recursive: true });
	const json = `${JSON.stringify(verdict, null, 2)}\n`;
	await writeFile(outputPath, json);
	if (verdict.action === "tweak") {
		const tweaksPath = protoScratchPath(sanitizedPlan.slug, TWEAKS_FILE);
		const tweaks = [...(await readTweaks(tweaksPath)), verdict.notes];
		await writeFile(tweaksPath, `${JSON.stringify(tweaks, null, 2)}\n`);
		return [
			"Prototype tweak requested (refine):",
			`Selected key: ${verdict.selectedKey}`,
			`Notes: ${verdict.notes}`,
			`Apply the notes to variation ${verdict.selectedKey} in place in the current round: change only what the notes ask, build no new variations, keep the same slug, re-present it, and re-plant the same plan. Do not run cleanup until an approve with no notes.`,
		].join("\n");
	}
	if (verdict.action === "reject") {
		await rm(protoScratchPath(sanitizedPlan.slug, TWEAKS_FILE), {
			force: true,
		});
		return [
			`Prototype rejected: ${verdict.feedback}`,
			`Rework the plan and re-plant the same slug (${verdict.slug}) for a fresh verdict.`,
		].join("\n");
	}
	const tweaksPath = protoScratchPath(sanitizedPlan.slug, TWEAKS_FILE);
	const tweaks = await readTweaks(tweaksPath);
	const answerPath = await exportApprovedAnswer(
		sanitizedPlan,
		verdict,
		data.previewDataUrl,
		{},
		tweaks,
	);
	await rm(tweaksPath, { force: true });
	if (!verdict.notes) return answerPath;
	return [
		"Prototype approved with notes (refine):",
		`Selected key: ${verdict.selectedKey}`,
		`Notes: ${verdict.notes}`,
		`Exported this round to ${answerPath}.`,
		"Build the next round from this variation: N new variations that change only what the notes ask, keep the same slug, re-present, and re-plant. Do not run cleanup until an approve with no notes.",
	].join("\n");
}

async function readTweaks(path: string): Promise<string[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return [];
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			`${TWEAKS_FILE} at ${path} is not valid JSON; delete it and re-tweak`,
		);
	}
	if (
		!Array.isArray(parsed) ||
		!parsed.every((item) => typeof item === "string")
	) {
		throw new Error(
			`${TWEAKS_FILE} at ${path} must be an array of strings; delete it and re-tweak`,
		);
	}
	return parsed;
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

	const scratchPath = protoScratchPath(slug, "");
	await rm(scratchPath, { force: true, recursive: true });
	return `Removed temporary prototype scratch for ${slug}.`;
}

function timeoutValue(value: string): number {
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new TypeError("--timeout must be a positive number of milliseconds");
	}
	if (timeout > PROTO_MAX_TIMEOUT_MS) {
		throw new TypeError(
			`--timeout must be at most ${PROTO_MAX_TIMEOUT_MS}ms; the daemon relay rejects anything higher`,
		);
	}
	return timeout;
}

const EXTENSION_VERBS = ["scrape", "plant", "cleanup"];

/** Handlers for the two proto modes; local is the default and the extension flow needs `--ext`. */
export type ProtoHandlers = {
	local(argv: string[]): Promise<number | undefined> | number | undefined;
	extension(argv: string[]): Promise<number | undefined> | number | undefined;
};

/** Route proto arguments: no `--ext` runs the local prototype commands, `--ext` runs the extension flow. */
export function dispatchProto(
	argv: string[],
	handlers: ProtoHandlers,
): Promise<number | undefined> | number | undefined {
	const rest = argv.filter((arg) => arg !== "--ext");
	return (argv.includes("--ext") ? handlers.extension : handlers.local)(rest);
}

function buildExtensionProgram(): Command {
	const proto = new Command("dg-skills proto --ext")
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
			"daemon relay timeout in milliseconds",
			String(DEFAULT_TIMEOUT_MS),
		)
		.option(
			"--session <id>",
			"dg daemon session id (default: the sole session matching this working directory)",
		)
		.action(
			async (url: string, options: { timeout: string; session?: string }) => {
				const output = await scrapePrototype(url, {
					timeoutMs: timeoutValue(options.timeout),
					session: options.session,
				});
				console.log(output);
			},
		);

	proto
		.command("plant")
		.description("plant prototype variations and wait for a browser verdict")
		.argument("<plan>", "path to a prototype plan JSON file")
		.option(
			"--timeout <ms>",
			"daemon relay timeout in milliseconds",
			String(DEFAULT_PLANT_TIMEOUT_MS),
		)
		.option(
			"--session <id>",
			"dg daemon session id (default: the sole session matching this working directory)",
		)
		.addHelpText(
			"after",
			"\nRun from the target project root. A reject surfaces feedback, a tweak surfaces notes, and an approve with notes starts the next round; in each case the agent re-plants the same slug.\n",
		)
		.action(
			async (
				planPath: string,
				options: { timeout: string; session?: string },
			) => {
				console.log(
					await plantPrototype(planPath, {
						timeoutMs: timeoutValue(options.timeout),
						session: options.session,
					}),
				);
			},
		);

	proto
		.command("cleanup")
		.description("remove temporary prototype scratch after approval")
		.argument("<slug>", "approved prototype slug")
		.addHelpText(
			"after",
			"\nRun from the target project root. The durable .agents/prototype/<slug> answer is preserved.\n",
		)
		.action(async (slug: string) => {
			console.log(await cleanupPrototype(slug));
		});

	return proto;
}

async function runExtension(argv: string[]): Promise<undefined> {
	assertExtensionInstalled("dg-skills proto --ext");
	await buildExtensionProgram().parseAsync(argv, { from: "user" });
	return undefined;
}

function runLocal(argv: string[]): Promise<number | undefined> | number {
	const verb = argv[0];
	if (verb && EXTENSION_VERBS.includes(verb)) {
		process.stderr.write(
			`proto: "${verb}" is an extension command; add --ext (dg-skills proto --ext ${argv.join(" ")})\n`,
		);
		return 1;
	}
	if (!verb || verb === "--help" || verb === "-h") {
		process.stdout.write(
			`${PROTOTYPE_USAGE}\nExtension flow: dg-skills proto --ext <scrape|plant|cleanup> [--help]\n`,
		);
		return verb ? 0 : 1;
	}
	return runPrototype(argv);
}

/** Register `proto`: local prototype commands by default, the extension scrape/plant/cleanup flow behind `--ext`. */
export function registerProto(program: Command): void {
	registerRawCommand(program, {
		name: "proto",
		description:
			"prototype locally (default) or inside a live page with --ext",
		run: (argv) =>
			dispatchProto(argv, { local: runLocal, extension: runExtension }),
	});
}
