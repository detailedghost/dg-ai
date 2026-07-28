import {
	MAILBOX_REASON_CODES,
	MAILBOX_RESULT_STATUSES,
	validateCanonicalMailboxAction,
} from "@dg/common";
import {
	type MailboxDebriefCommand,
	type MailboxDebriefDownload,
	type MailboxDebriefDownloadState,
	type MailboxDebriefResult,
	type MailboxDebriefService,
} from "./contracts";

const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REVISION_ALIAS = /^rev_[a-f0-9]{32}$/;
const SAFE_ALIAS =
	/^(acct|run|rev|msg|fld|lbl|flt|act|coh|plan)_[a-f0-9]{32}$/;
const SAFE_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FINAL_OBSERVATION_AGE_MS = 5 * 60 * 1_000;
const MAX_REPORT_BYTES = 1_048_576;

type PlainRecord = Record<string, unknown>;

type SafeResult = Readonly<{
	index: number;
	actionAlias: string;
	type: string;
	status: string;
	reasonCode?: string;
	affectedCount: number;
	targets: readonly string[];
}>;

type SafeTerminalInput = Readonly<{
	planAlias: string;
	revisionAlias: string;
	terminalStatus: "completed" | "failed" | "canceled";
	results: readonly SafeResult[];
	finalInboxObservation?: Readonly<{
		status: string;
		count: number;
		observedAt?: string;
	}>;
}>;

type DurableReport = Readonly<{
	schemaVersion: 1;
	filename: string;
	mimeType: "text/plain;charset=utf-8";
	content: string;
	byteLength: number;
	sha256: string;
	inputSha256: string;
	delivery:
		| Readonly<{ status: "retryable" }>
		| Readonly<{ status: "pending"; downloadId: number }>
		| Readonly<{ status: "available"; downloadId: number }>;
}>;

function exact(
	value: PlainRecord,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !allowed.has(key))
	) {
		throw new Error("Invalid mailbox debrief input");
	}
}

function record(value: unknown): PlainRecord {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Invalid mailbox debrief input");
	}
	return value as PlainRecord;
}

function safeAlias(value: unknown, pattern = SAFE_ALIAS): string {
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new Error("Invalid mailbox debrief alias");
	}
	const separator = value.indexOf("_");
	const digest = value.slice(separator + 1);
	if (new Set(digest).size < 4) {
		throw new Error("Invalid mailbox debrief alias");
	}
	return value;
}

function safeToken(value: unknown): string {
	if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
		throw new Error("Invalid mailbox debrief token");
	}
	return value;
}

function safeResult(value: unknown): SafeResult {
	const input = record(value);
	exact(
		input,
		["schemaVersion", "index", "action", "status", "affectedCount"],
		["reasonCode"],
	);
	const index = input.index;
	const affectedCount = input.affectedCount;
	if (
		input.schemaVersion !== 1 ||
		typeof index !== "number" ||
		!Number.isSafeInteger(index) ||
		index < 0 ||
		typeof affectedCount !== "number" ||
		!Number.isSafeInteger(affectedCount) ||
		affectedCount < 0
	) {
		throw new Error("Invalid mailbox debrief result");
	}
	if (
		typeof input.status !== "string" ||
		!MAILBOX_RESULT_STATUSES.includes(
			input.status as (typeof MAILBOX_RESULT_STATUSES)[number],
		) ||
		input.reasonCode !== undefined &&
			(typeof input.reasonCode !== "string" ||
				!MAILBOX_REASON_CODES.includes(
					input.reasonCode as (typeof MAILBOX_REASON_CODES)[number],
				))
	) {
		throw new Error("Invalid mailbox debrief result");
	}
	let action;
	try {
		action = validateCanonicalMailboxAction(input.action);
	} catch {
		throw new Error("Invalid mailbox debrief action");
	}
	const type = action.type;
	const targetFields = new Set([
		"messageAlias",
		"folderAlias",
		"replacementFolderAlias",
		"labelAlias",
		"replacementLabelAlias",
		"filterAlias",
		"replacementFilterAlias",
	]);
	const targets = Object.entries(action).flatMap(([field, candidate]) =>
		targetFields.has(field) ? [safeAlias(candidate)] : [],
	);
	return Object.freeze({
		index,
		actionAlias: safeAlias(action.actionAlias, /^act_[a-f0-9]{32}$/),
		type,
		status: input.status,
		...(input.reasonCode === undefined
			? {}
			: { reasonCode: input.reasonCode }),
		affectedCount,
		targets: Object.freeze(targets),
	});
}

function safeInput(value: unknown): SafeTerminalInput {
	const input = record(value);
	exact(
		input,
		[
			"schemaVersion",
			"planAlias",
			"revisionAlias",
			"terminalStatus",
			"results",
		],
		["finalInboxObservation"],
	);
	if (
		input.schemaVersion !== 1 ||
		!Array.isArray(input.results) ||
		!["completed", "failed", "canceled"].includes(
			String(input.terminalStatus),
		)
	) {
		throw new Error("Invalid mailbox debrief input");
	}
	const final = input.finalInboxObservation;
	let finalInboxObservation: SafeTerminalInput["finalInboxObservation"];
	if (final !== undefined) {
		const observation = record(final);
		exact(observation, ["status", "count"], ["observedAt"]);
		if (
			typeof observation.count !== "number" ||
			!Number.isSafeInteger(observation.count) ||
			observation.count < 0
		) {
			throw new Error("Invalid mailbox debrief inbox observation");
		}
		if (
			observation.observedAt !== undefined &&
			(typeof observation.observedAt !== "string" ||
				!TIMESTAMP.test(observation.observedAt) ||
				new Date(observation.observedAt).toISOString() !==
					observation.observedAt)
		) {
			throw new Error("Invalid mailbox debrief inbox observation");
		}
		finalInboxObservation = Object.freeze({
			status: safeToken(observation.status),
			count: observation.count,
			...(typeof observation.observedAt === "string"
				? { observedAt: observation.observedAt }
				: {}),
		});
	}
	const results = input.results.map(safeResult).sort(
		(left, right) => left.index - right.index,
	);
	if (new Set(results.map((result) => result.index)).size !== results.length) {
		throw new Error("Invalid mailbox debrief result order");
	}
	return Object.freeze({
		planAlias: safeAlias(input.planAlias, PLAN_ALIAS),
		revisionAlias: safeAlias(input.revisionAlias, REVISION_ALIAS),
		terminalStatus: input.terminalStatus as SafeTerminalInput["terminalStatus"],
		results: Object.freeze(results),
		...(finalInboxObservation === undefined
			? {}
			: { finalInboxObservation }),
	});
}

function resultLine(result: SafeResult): string {
	const reason =
		result.reasonCode === undefined ? "" : ` reason=${result.reasonCode}`;
	const targets =
		result.targets.length === 0
			? ""
			: ` targets=${result.targets.join(",")}`;
	return `- ${result.index + 1}. ${result.actionAlias} ${result.type} status=${result.status} affected=${result.affectedCount}${reason}${targets}`;
}

function sectionLines(
	results: readonly SafeResult[],
	types: ReadonlySet<string>,
): readonly string[] {
	const lines = results
		.filter((result) => types.has(result.type))
		.map(resultLine);
	return lines.length === 0 ? ["- None"] : lines;
}

function render(
	input: SafeTerminalInput,
	generatedAt: string,
): string {
	const counts = {
		completed: 0,
		skipped: 0,
		needs_review: 0,
		failed: 0,
	};
	for (const result of input.results) {
		if (Object.hasOwn(counts, result.status)) {
			counts[result.status as keyof typeof counts] += 1;
		}
	}
	const actionLines =
		input.results.length === 0
			? ["- None"]
			: input.results.map(resultLine);
	const generatedAtMilliseconds = Date.parse(generatedAt);
	const observedAtMilliseconds = Date.parse(
		input.finalInboxObservation?.observedAt ?? "",
	);
	const freshFinalObservation =
		input.finalInboxObservation?.status === "observed" &&
		Number.isFinite(generatedAtMilliseconds) &&
		Number.isFinite(observedAtMilliseconds) &&
		generatedAtMilliseconds >= observedAtMilliseconds &&
		generatedAtMilliseconds - observedAtMilliseconds <=
			MAX_FINAL_OBSERVATION_AGE_MS;
	const inbox =
		freshFinalObservation &&
		input.finalInboxObservation.count === 0
			? "Inbox Zero complete — fresh visible inbox observation found 0 messages."
			: freshFinalObservation
				? `Fresh visible inbox observation found ${input.finalInboxObservation.count} messages.`
				: "Inbox completion was not claimed because no fresh unambiguous visible observation was available.";

	return [
		"Mailbox Cleanup Debrief",
		`Plan: ${input.planAlias}`,
		`Revision: ${input.revisionAlias}`,
		`Terminal status: ${input.terminalStatus}`,
		`Generated: ${generatedAt}`,
		"",
		"Summary",
		`completed=${counts.completed} skipped=${counts.skipped} needs_review=${counts.needs_review} failed=${counts.failed}`,
		"",
		"Actions",
		...actionLines,
		"",
		"Folders",
		...sectionLines(
			input.results,
			new Set(["move_to_folder", "create_folder", "rename_folder"]),
		),
		"",
		"Labels and categories",
		...sectionLines(
			input.results,
			new Set([
				"create_label",
				"rename_label",
				"apply_label",
				"create_category",
				"rename_category",
				"apply_category",
			]),
		),
		"",
		"Filters Added",
		...sectionLines(input.results, new Set(["create_filter"])),
		"",
		"Filters Changed",
		...sectionLines(input.results, new Set(["change_filter"])),
		"",
		"Filters Deactivated",
		...sectionLines(input.results, new Set(["deactivate_filter"])),
		"",
		"Inbox",
		inbox,
		"",
		"Scope note",
		"Filters are deactivated, not deleted. This report contains sanitized aliases and typed outcomes only.",
		"",
		"Retention notice",
		"Downloaded reports are outside extension TTL cleanup. Store or delete this file according to your own retention policy.",
		"",
	].join("\n");
}

function filename(command: MailboxDebriefCommand): string {
	return `mailbox-cleanup-debrief-v1-${command.planAlias}-${command.revisionAlias}.txt`;
}

function cacheKey(command: MailboxDebriefCommand): string {
	return `${command.planAlias}:${command.revisionAlias}`;
}

async function digest(content: string): Promise<Readonly<{
	byteLength: number;
	sha256: string;
}>> {
	const bytes = new TextEncoder().encode(content);
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_REPORT_BYTES) {
		throw new Error("Mailbox debrief is unavailable");
	}
	const value = await crypto.subtle.digest("SHA-256", bytes);
	return Object.freeze({
		byteLength: bytes.byteLength,
		sha256: Array.from(new Uint8Array(value), (byte) =>
			byte.toString(16).padStart(2, "0")
		).join(""),
	});
}

async function durableReport(
	report: Readonly<{ filename: string; content: string }>,
	input: SafeTerminalInput,
): Promise<DurableReport> {
	return Object.freeze({
		schemaVersion: 1,
		filename: report.filename,
		mimeType: "text/plain;charset=utf-8",
		content: report.content,
		...(await digest(report.content)),
		inputSha256: (await digest(JSON.stringify(input))).sha256,
		delivery: Object.freeze({ status: "retryable" }),
	});
}

async function validateDurableReport(
	value: unknown,
	expectedFilename: string,
	expectedInput?: SafeTerminalInput,
): Promise<DurableReport> {
	const input = record(value);
	exact(input, [
		"schemaVersion",
		"filename",
		"mimeType",
		"content",
		"byteLength",
		"sha256",
		"inputSha256",
		"delivery",
	]);
	if (
		input.schemaVersion !== 1 ||
		input.filename !== expectedFilename ||
		input.mimeType !== "text/plain;charset=utf-8" ||
		typeof input.content !== "string" ||
		typeof input.byteLength !== "number" ||
		!Number.isSafeInteger(input.byteLength) ||
		input.byteLength <= 0 ||
		input.byteLength > MAX_REPORT_BYTES ||
		typeof input.sha256 !== "string" ||
		!SHA256.test(input.sha256) ||
		typeof input.inputSha256 !== "string" ||
		!SHA256.test(input.inputSha256)
	) {
		throw new Error("Mailbox debrief is unavailable");
	}
	const delivery = record(input.delivery);
	exact(
		delivery,
		["status"],
		delivery.status === "pending" || delivery.status === "available"
			? ["downloadId"]
			: [],
	);
	if (
		!["retryable", "pending", "available"].includes(
			String(delivery.status),
		) ||
		(delivery.status !== "retryable" &&
			(typeof delivery.downloadId !== "number" ||
				!Number.isSafeInteger(delivery.downloadId) ||
				delivery.downloadId < 0))
	) {
		throw new Error("Mailbox debrief is unavailable");
	}
	const calculated = await digest(input.content);
	if (
		calculated.byteLength !== input.byteLength ||
		calculated.sha256 !== input.sha256
	) {
		throw new Error("Mailbox debrief is unavailable");
	}
	if (
		expectedInput !== undefined &&
		(await digest(JSON.stringify(expectedInput))).sha256 !== input.inputSha256
	) {
		throw new Error("Mailbox debrief is unavailable");
	}
	return Object.freeze({
		schemaVersion: 1,
		filename: input.filename,
		mimeType: "text/plain;charset=utf-8",
		content: input.content,
		byteLength: input.byteLength,
		sha256: input.sha256,
		inputSha256: input.inputSha256,
		delivery:
			delivery.status === "retryable"
				? Object.freeze({ status: "retryable" as const })
				: Object.freeze({
						status: delivery.status as "pending" | "available",
						downloadId: delivery.downloadId as number,
					}),
	});
}

export function createMailboxDebriefService(deps: Readonly<{
	now(): string;
	download(value: MailboxDebriefDownload): Promise<number>;
	downloadState(downloadId: number): Promise<MailboxDebriefDownloadState>;
	storage: Readonly<{
		get(key: string): Promise<unknown>;
		set(key: string, value: unknown): Promise<void>;
		remove(key: string): Promise<void>;
	}>;
}>): MailboxDebriefService {
	const storageKey = (command: MailboxDebriefCommand): string =>
		`dg:mailbox-debrief:v1:${cacheKey(command)}`;

	const save = async (
		command: MailboxDebriefCommand,
		report: DurableReport,
	): Promise<void> => {
		try {
			await deps.storage.set(storageKey(command), report);
		} catch {
			throw new Error("Mailbox debrief persistence failed safely");
		}
	};

	const result = (
		report: DurableReport,
		status: MailboxDebriefResult["status"],
	): MailboxDebriefResult =>
		Object.freeze({
			status,
			filename: report.filename,
			content: report.content,
			...(report.delivery.status === "retryable"
				? {}
				: { downloadId: report.delivery.downloadId }),
		});

	async function beginDownload(
		command: MailboxDebriefCommand,
		report: DurableReport,
		inspect = true,
	): Promise<MailboxDebriefResult> {
		let downloadId: number;
		try {
			downloadId = await deps.download({
				filename: report.filename,
				mimeType: report.mimeType,
				content: report.content,
			});
			if (
				!Number.isSafeInteger(downloadId) ||
				downloadId < 0
			) {
				throw new Error("Invalid mailbox debrief download");
			}
		} catch {
			return result(report, "download_failed");
		}
		const pending = Object.freeze({
			...report,
			delivery: Object.freeze({
				status: "pending" as const,
				downloadId,
			}),
		});
		await save(command, pending);
		return inspect
			? reconcile(command, pending)
			: result(pending, "download_pending");
	}

	async function reconcile(
		command: MailboxDebriefCommand,
		report: DurableReport,
	): Promise<MailboxDebriefResult> {
		if (report.delivery.status === "available") {
			return result(report, "downloaded");
		}
		if (report.delivery.status === "retryable") {
			return beginDownload(command, report);
		}
		let state: MailboxDebriefDownloadState;
		try {
			state = await deps.downloadState(report.delivery.downloadId);
		} catch {
			state = "missing";
		}
		if (state === "in_progress") {
			return result(report, "download_pending");
		}
		if (state === "complete") {
			const available = Object.freeze({
				...report,
				delivery: Object.freeze({
					status: "available" as const,
					downloadId: report.delivery.downloadId,
				}),
			});
			await save(command, available);
			return result(available, "downloaded");
		}
		const retryable = Object.freeze({
			...report,
			delivery: Object.freeze({ status: "retryable" as const }),
		});
		await save(command, retryable);
		return beginDownload(command, retryable, false);
	}

	const load = async (
		command: MailboxDebriefCommand,
		expectedInput?: SafeTerminalInput,
	): Promise<DurableReport | undefined> => {
		let stored: unknown;
		try {
			stored = await deps.storage.get(storageKey(command));
		} catch {
			throw new Error("Mailbox debrief is unavailable");
		}
		return stored === undefined
			? undefined
			: validateDurableReport(
					stored,
					filename(command),
					expectedInput,
				);
	};

	return Object.freeze({
		async generate(value) {
			const input = safeInput(value);
			const command = Object.freeze({
				planAlias: input.planAlias,
				revisionAlias: input.revisionAlias,
			});
			let report = await load(command, input);
			if (report === undefined) {
				report = await durableReport(
					Object.freeze({
						filename: filename(input),
						content: render(input, deps.now()),
					}),
					input,
				);
				await save(command, report);
			}
			return reconcile(command, report);
		},
		async regenerate(command) {
			const planAlias = safeAlias(command.planAlias, PLAN_ALIAS);
			const revisionAlias = safeAlias(
				command.revisionAlias,
				REVISION_ALIAS,
			);
			const nextCommand = Object.freeze({ planAlias, revisionAlias });
			const report = await load(nextCommand);
			if (report === undefined) {
				throw new Error("Mailbox debrief is unavailable");
			}
			return reconcile(nextCommand, report);
		},
	});
}
