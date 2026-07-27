import {
	MAILBOX_REASON_CODES,
	preflightMailboxValue,
	type MailboxReasonCode,
} from "@dg/common";
import { isValidMailboxScopedAlias } from "../privacy";
import { deriveMailboxCohortsFromValidatedInventoryAsync } from "../planning/cohorts";
import { createMailboxCleanupChoicesFromValidatedInventoryAsync } from "../planning/planner";
import {
	invokeMailboxAbort,
	raceMailboxAbort,
	throwIfMailboxAborted,
	yieldMailboxTask,
} from "./abort";
import {
	consumeMailboxCaptureChunks,
	MailboxCaptureStreamError,
} from "./chunks";
import {
	MAILBOX_CAPTURE_LIMITS,
	MailboxCoordinatorProviderError,
	type MailboxBodyChecks,
	type MailboxBodyCheckConsent,
	type MailboxCaptureCoordinator,
	type MailboxCaptureCoordinatorDeps,
	type MailboxCaptureCounts,
	type MailboxCaptureMetadata,
	type MailboxCaptureRequest,
	type MailboxCaptureResult,
	type MailboxCoordinatorState,
	type MailboxProviderCaptureResult,
	type MailboxProviderProbeResult,
	type RawMailboxBodyResult,
} from "./contracts";
import { validateBoundedMailboxInventory } from "./inventory";

type FailureStatus = Extract<
	MailboxCaptureResult,
	{ reasonCode: MailboxReasonCode }
>["status"];

class MailboxCoordinatorError extends Error {
	override readonly name = "MailboxCoordinatorError";

	constructor(
		readonly status: FailureStatus,
		readonly reasonCode: MailboxReasonCode,
	) {
		super(`Mailbox coordinator rejected: ${reasonCode}`);
	}
}

function fail(
	status: FailureStatus,
	reasonCode: MailboxReasonCode,
): never {
	throw new MailboxCoordinatorError(status, reasonCode);
}

function exactObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	preflightMailboxValue(value);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail("refused", "provider_refused");
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	if (
		required.some((key) => !Object.hasOwn(input, key)) ||
		keys.some((key) => !required.includes(key) && !optional.includes(key))
	) {
		fail("refused", "provider_refused");
	}
	return input;
}

function validateRequest(value: MailboxCaptureRequest): MailboxCaptureRequest {
	const input = exactObject(value, [
		"schemaVersion",
		"providerId",
		"surface",
		"accountAlias",
		"runAlias",
		"revisionAlias",
		"bodyMessageAliases",
	]);
	if (
		input.schemaVersion !== 1 ||
		typeof input.providerId !== "string" ||
		!/^[a-z][a-z0-9-]{0,63}$/.test(input.providerId) ||
		typeof input.surface !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(input.surface) ||
		!isValidMailboxScopedAlias(input.accountAlias, "acct") ||
		!isValidMailboxScopedAlias(input.runAlias, "run") ||
		!isValidMailboxScopedAlias(input.revisionAlias, "rev") ||
		!Array.isArray(input.bodyMessageAliases) ||
		new Set(input.bodyMessageAliases).size !==
			input.bodyMessageAliases.length ||
		input.bodyMessageAliases.some(
			(alias) => !isValidMailboxScopedAlias(alias, "msg"),
		)
	) {
		fail("refused", "provider_refused");
	}
	return Object.freeze({
		schemaVersion: 1,
		providerId: input.providerId,
		surface: input.surface,
		accountAlias: input.accountAlias,
		runAlias: input.runAlias,
		revisionAlias: input.revisionAlias,
		bodyMessageAliases: Object.freeze([...input.bodyMessageAliases]),
	});
}

function providerRequest(request: MailboxCaptureRequest) {
	return Object.freeze({
		providerId: request.providerId,
		surface: request.surface,
		accountAlias: request.accountAlias,
		runAlias: request.runAlias,
		revisionAlias: request.revisionAlias,
	});
}

function validateProbeResult(
	value: unknown,
	request: ReturnType<typeof providerRequest>,
): MailboxProviderProbeResult {
	preflightMailboxValue(value);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail("refused", "provider_refused");
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	switch (input.status) {
		case "ready":
			if (
				keys.length !== 3 ||
				!Object.hasOwn(input, "status") ||
				!Object.hasOwn(input, "accountAlias") ||
				!Object.hasOwn(input, "surface")
			) {
				fail("refused", "provider_refused");
			}
			if (
				input.accountAlias !== request.accountAlias ||
				input.surface !== request.surface
			) {
				return Object.freeze({ status: "wrong_account" });
			}
			return Object.freeze({
				status: "ready",
				accountAlias: request.accountAlias,
				surface: request.surface,
			});
		case "signed_out":
		case "security_prompt":
		case "wrong_account":
		case "ambiguous_surface":
		case "worker_suspended":
		case "blocked_prompt": {
			if (
				!Object.hasOwn(input, "status") ||
				keys.some(
					(key) => key !== "status" && key !== "reasonCode",
				) ||
				(input.reasonCode !== undefined &&
					(typeof input.reasonCode !== "string" ||
						!MAILBOX_REASON_CODES.includes(
							input.reasonCode as MailboxReasonCode,
						)))
			) {
				fail("refused", "provider_refused");
			}
			return Object.freeze({
				status: input.status,
				...(input.reasonCode === undefined
					? {}
					: {
							reasonCode:
								input.reasonCode as MailboxReasonCode,
						}),
			});
		}
		default:
			fail("refused", "provider_refused");
	}
}

function validateCaptureResult(value: unknown): MailboxProviderCaptureResult {
	try {
		preflightMailboxValue(value);
	} catch {
		throw new MailboxCaptureStreamError();
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new MailboxCaptureStreamError();
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	if (input.status === "complete") {
		if (
			keys.length !== 1 ||
			!Object.hasOwn(input, "status")
		) {
			throw new MailboxCaptureStreamError();
		}
		return { status: "complete" };
	}
	if (
		keys.length === 2 &&
		Object.hasOwn(input, "status") &&
		Object.hasOwn(input, "reasonCode") &&
		input.status === "partial" &&
		input.reasonCode === "provider_partial"
	) {
		return { status: "partial", reasonCode: "provider_partial" };
	}
	throw new MailboxCaptureStreamError();
}

function validateBodyConsent(
	value: unknown,
	runAlias: string,
	messageAliases: readonly string[],
): MailboxBodyCheckConsent {
	const input = exactObject(value, [
		"granted",
		"runAlias",
		"messageAliases",
	]);
	if (
		typeof input.granted !== "boolean" ||
		input.runAlias !== runAlias ||
		!Array.isArray(input.messageAliases) ||
		input.messageAliases.length !== messageAliases.length ||
		input.messageAliases.some(
			(alias, index) => alias !== messageAliases[index],
		)
	) {
		fail("refused", "provider_refused");
	}
	return {
		granted: input.granted,
		runAlias,
		messageAliases,
	};
}

function terminalFromProbe(
	result: Exclude<MailboxProviderProbeResult, { status: "ready" }>,
): MailboxCaptureResult {
	switch (result.status) {
		case "security_prompt":
		case "blocked_prompt":
			return { status: "blocked_prompt", reasonCode: "blocked_prompt" };
		case "wrong_account":
			return { status: "wrong_account", reasonCode: "wrong_account" };
		case "worker_suspended":
			return {
				status: "worker_suspended",
				reasonCode: "worker_suspended",
			};
		case "ambiguous_surface":
			return { status: "refused", reasonCode: "layout_mismatch" };
		case "signed_out":
			return { status: "refused", reasonCode: "provider_refused" };
	}
}

const QUOTE_BOUNDARY = [
	/(?:^|\s)>/,
	/-{2,}\s*original message\s*-{2,}/i,
	/\bon .{1,2048}? wrote:/i,
	/\bam .{1,2048}? schrieb .{1,2048}?:/i,
	/\ble .{1,2048}? a écrit\s*:/i,
	/\bel .{1,2048}? escribió:/i,
	/\bop .{1,2048}? schreef .{1,2048}?:/i,
	/\bem .{1,2048}? escreveu:/i,
	/\bil .{1,2048}? ha scritto:/i,
	/(?:^|\s)(?:from|sent|to|subject|von|gesendet|de|envoyé|da|inviato|差出人|送信者)\s*:/i,
] as const;

const HTML_QUOTE_MARKERS = [
	"gmail_quote",
	"divrplyfwdmsg",
	"yahoo_quoted",
	"protonmail_quote",
	"moz-cite-prefix",
	"type=\"cite\"",
	"type='cite'",
] as const;

function quoteBoundary(line: string): number | undefined {
	let boundary: number | undefined;
	for (const pattern of QUOTE_BOUNDARY) {
		const match = pattern.exec(line);
		if (
			match !== null &&
			(boundary === undefined || match.index < boundary)
		) {
			boundary = match.index;
		}
	}
	return boundary;
}

function redactBodyLine(value: string): string {
	return value
		.replace(
			/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
			"[email]",
		)
		.replace(/\bhttps?:\/\/[^\s]+/gi, "[url]")
		.replace(/\b(?:\d[ -]?){13,19}\b/g, "[financial-data]");
}

const SAFE_HTML_TAGS = new Set([
	"a",
	"b",
	"blockquote",
	"body",
	"br",
	"code",
	"div",
	"em",
	"head",
	"hr",
	"html",
	"i",
	"li",
	"ol",
	"p",
	"pre",
	"span",
	"strong",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
]);

const VOID_HTML_TAGS = new Set(["br", "hr"]);
const BREAK_HTML_TAGS = new Set([
	"blockquote",
	"br",
	"div",
	"hr",
	"li",
	"ol",
	"p",
	"pre",
	"table",
	"td",
	"th",
	"tr",
	"ul",
]);
const INLINE_HTML_TAGS = new Set([
	"a",
	"b",
	"code",
	"em",
	"i",
	"span",
	"strong",
	"u",
]);

function decodeHtmlEntities(value: string): string {
	return value.replace(
		/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi,
		(match, entity: string) => {
			const normalized = entity.toLowerCase();
			const named: Readonly<Record<string, string>> = {
				amp: "&",
				apos: "'",
				gt: ">",
				lt: "<",
				nbsp: " ",
				quot: "\"",
			};
			if (Object.hasOwn(named, normalized)) {
				return named[normalized] ?? "";
			}
			if (!normalized.startsWith("#")) {
				fail("malformed_stream", "malformed_stream");
			}
			const hexadecimal = normalized.startsWith("#x");
			const codePoint = Number.parseInt(
				normalized.slice(hexadecimal ? 2 : 1),
				hexadecimal ? 16 : 10,
			);
			if (
				!Number.isSafeInteger(codePoint) ||
				codePoint < 0 ||
				codePoint > 0x10ffff ||
				(codePoint >= 0xd800 && codePoint <= 0xdfff)
			) {
				fail("malformed_stream", "malformed_stream");
			}
			return String.fromCodePoint(codePoint);
		},
	);
}

function appendHtmlBreak(output: string[]): void {
	if (
		output.length > 0 &&
		output[output.length - 1] !== "\n"
	) {
		output.push("\n");
	}
}

function appendInlineSpace(output: string[]): void {
	const last = output[output.length - 1];
	if (
		last !== undefined &&
		!/[ \t\n]$/.test(last)
	) {
		output.push(" ");
	}
}

function htmlToTextWithoutQuotes(value: string): string {
	if (!value.includes("<")) return decodeHtmlEntities(value);
	const output: string[] = [];
	const stack: string[] = [];
	let skipDepth = 0;
	let cursor = 0;
	while (cursor < value.length) {
		const opening = value.indexOf("<", cursor);
		if (opening < 0) {
			if (skipDepth === 0) output.push(value.slice(cursor));
			break;
		}
		if (skipDepth === 0 && opening > cursor) {
			output.push(value.slice(cursor, opening));
		}
		const closing = value.indexOf(">", opening + 1);
		if (closing < 0 || closing - opening > 2_048) {
			fail("malformed_stream", "malformed_stream");
		}
		const token = value.slice(opening, closing + 1);
		const match = /^<\s*(\/?)\s*([a-z][a-z0-9]*)([^>]*)>$/i.exec(token);
		if (match === null) fail("malformed_stream", "malformed_stream");
		const isClosing = match[1] === "/";
		const tag = (match[2] ?? "").toLowerCase();
		const attributes = match[3] ?? "";
		if (!SAFE_HTML_TAGS.has(tag) || attributes.includes("<")) {
			fail("malformed_stream", "malformed_stream");
		}
		if (isClosing) {
			if (attributes.trim().length > 0 || stack.pop() !== tag) {
				fail("malformed_stream", "malformed_stream");
			}
			if (skipDepth > 0) skipDepth -= 1;
			else if (BREAK_HTML_TAGS.has(tag)) appendHtmlBreak(output);
			else if (INLINE_HTML_TAGS.has(tag)) appendInlineSpace(output);
			cursor = closing + 1;
			continue;
		}
		const selfClosing = /\/\s*$/.test(attributes);
		const isVoid = selfClosing || VOID_HTML_TAGS.has(tag);
		const lowerAttributes = attributes.toLowerCase();
		const beginsQuote =
			tag === "blockquote" ||
			HTML_QUOTE_MARKERS.some((marker) =>
				lowerAttributes.includes(marker),
			);
		if (skipDepth > 0) {
			if (!isVoid) {
				stack.push(tag);
				skipDepth += 1;
			}
		} else if (beginsQuote) {
			if (!isVoid) {
				stack.push(tag);
				skipDepth = 1;
			}
		} else {
			if (BREAK_HTML_TAGS.has(tag)) appendHtmlBreak(output);
			else if (INLINE_HTML_TAGS.has(tag)) appendInlineSpace(output);
			if (!isVoid) stack.push(tag);
		}
		cursor = closing + 1;
	}
	if (stack.length > 0 || skipDepth > 0) {
		fail("malformed_stream", "malformed_stream");
	}
	return decodeHtmlEntities(output.join(""))
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
}

function appendBounded(
	output: string[],
	value: string,
	currentCount: number,
	limit: number,
): number {
	let count = currentCount;
	for (const _character of value) {
		count += 1;
		if (count > limit) fail("malformed_stream", "malformed_stream");
	}
	output.push(value);
	return count;
}

function scrubCurrentBody(
	value: string,
	characterLimit: number,
): Readonly<{ text: string; characterCount: number }> {
	const currentBody = htmlToTextWithoutQuotes(value);
	const output: string[] = [];
	let characterCount = 0;
	let cursor = 0;
	while (cursor <= currentBody.length) {
		const newline = currentBody.indexOf("\n", cursor);
		const end = newline < 0 ? currentBody.length : newline;
		if (end - cursor > 8_192) {
			fail("malformed_stream", "malformed_stream");
		}
		const line = currentBody
			.slice(cursor, end)
			.replace(/\r$/, "");
		const boundary = quoteBoundary(line);
		const current =
			boundary === undefined
				? line
				: line.slice(0, boundary).trimEnd();
		if (current.length > 0) {
			if (output.length > 0) {
				characterCount = appendBounded(
					output,
					"\n",
					characterCount,
					characterLimit,
				);
			}
			characterCount = appendBounded(
				output,
				redactBodyLine(current),
				characterCount,
				characterLimit,
			);
		}
		if (boundary !== undefined || newline < 0) break;
		cursor = newline + 1;
	}
	return Object.freeze({
		text: output.join(""),
		characterCount,
	});
}

function sanitizeBodies(
	values: readonly RawMailboxBodyResult[],
	allowedAliases: readonly string[],
	characterLimit: number,
	totalLimit: number,
): MailboxBodyChecks {
	preflightMailboxValue(values, {
		maxStringLength: totalLimit,
		maxTotalStringLength: totalLimit * 4,
	});
	const allowed = new Set(allowedAliases);
	const seen = new Set<string>();
	const results = [];
	let total = 0;
	for (const value of values) {
		const keys =
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value)
				? Object.keys(value)
				: [];
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			!Object.hasOwn(value, "messageAlias") ||
			!Object.hasOwn(value, "text") ||
			keys.some(
				(key) =>
					key !== "messageAlias" &&
					key !== "text" &&
					key !== "attachments" &&
					key !== "quotedHistory",
			) ||
			typeof value.messageAlias !== "string" ||
			!allowed.has(value.messageAlias) ||
			seen.has(value.messageAlias) ||
			typeof value.text !== "string"
		) {
			fail("malformed_stream", "malformed_stream");
		}
		seen.add(value.messageAlias);
		const scrubbed = scrubCurrentBody(value.text, characterLimit);
		total += scrubbed.characterCount;
		if (total > totalLimit) fail("malformed_stream", "malformed_stream");
		results.push(
			Object.freeze({
				messageAlias: value.messageAlias,
				...scrubbed,
			}),
		);
	}
	if (
		results.length !== allowed.size ||
		allowedAliases.some((alias) => !seen.has(alias))
	) {
		fail("malformed_stream", "malformed_stream");
	}
	return Object.freeze({ results: Object.freeze(results) });
}

function failureForReason(reasonCode: MailboxReasonCode): MailboxCaptureResult {
	switch (reasonCode) {
		case "canceled":
			return { status: "canceled", reasonCode };
		case "worker_suspended":
			return { status: "worker_suspended", reasonCode };
		case "blocked_prompt":
			return { status: "blocked_prompt", reasonCode };
		case "wrong_account":
			return { status: "wrong_account", reasonCode };
		case "malformed_stream":
			return { status: "malformed_stream", reasonCode };
		case "provider_refused":
			return { status: "refused", reasonCode };
		default:
			return { status: "refused", reasonCode };
	}
}

function resultFromError(error: unknown): MailboxCaptureResult {
	if (error instanceof MailboxCoordinatorError) {
		return { status: error.status, reasonCode: error.reasonCode };
	}
	if (error instanceof MailboxCoordinatorProviderError) {
		return failureForReason(error.reasonCode);
	}
	if (error instanceof MailboxCaptureStreamError) {
		return {
			status: "malformed_stream",
			reasonCode: "malformed_stream",
		};
	}
	return { status: "malformed_stream", reasonCode: "malformed_stream" };
}

export function createMailboxCaptureCoordinator(
	deps: MailboxCaptureCoordinatorDeps,
): MailboxCaptureCoordinator {
	const limits = deps.limits ?? MAILBOX_CAPTURE_LIMITS;
	let state: MailboxCoordinatorState = "idle";
	let controller: AbortController | undefined;
	let forcedTerminal: "canceled" | "worker_suspended" | undefined;
	let running = false;

	const update = (
		next: MailboxCoordinatorState,
		counts?: MailboxCaptureCounts,
	): void => {
		state = next;
		try {
			deps.onProgress?.({
				state: next,
				...(counts === undefined ? {} : { counts }),
			});
		} catch {
			// Progress is advisory; authoritative state stays local.
		}
	};
	const finish = (result: MailboxCaptureResult): MailboxCaptureResult => {
		update(result.status);
		return Object.freeze(result);
	};

	return Object.freeze({
		async start(value) {
			if (running) {
				return Object.freeze({
					status: "refused",
					reasonCode: "provider_refused",
				});
			}
			running = true;
			forcedTerminal = undefined;
			controller = new AbortController();
			const signal = controller.signal;
			try {
				const request = validateRequest(value);
				if (request.bodyMessageAliases.length > limits.bodyAliases) {
					fail("refused", "provider_refused");
				}
				const scope = providerRequest(request);
				update("probing");
				throwIfMailboxAborted(signal);
				const probe = validateProbeResult(
					await raceMailboxAbort(
						signal,
						() => deps.provider.probe(scope, signal),
					),
					scope,
				);
				if (probe.status !== "ready") {
					return finish(terminalFromProbe(probe));
				}
				update("binding_account");
				throwIfMailboxAborted(signal);
				update("capturing_summary");
				throwIfMailboxAborted(signal);
				const captureStream = invokeMailboxAbort(
					signal,
					() => deps.provider.capture(scope, signal),
				);
				const assembled = await consumeMailboxCaptureChunks(
					captureStream,
					{
						runAlias: request.runAlias,
						limits,
						signal,
						onChunk(chunk) {
							if (
								chunk.payload.kind !== "messages" &&
								state === "capturing_summary"
							) {
								update("capturing_metadata");
								throwIfMailboxAborted(signal);
							}
						},
					},
				);
				throwIfMailboxAborted(signal);
				if (state === "capturing_summary") {
					update("capturing_metadata", assembled.counts);
					throwIfMailboxAborted(signal);
				}
				const captureStatus = validateCaptureResult(
					await raceMailboxAbort(
						signal,
						() => deps.provider.captureResult(scope, signal),
					),
				);
				throwIfMailboxAborted(signal);
				await yieldMailboxTask(signal);
				throwIfMailboxAborted(signal);
				const metadata: MailboxCaptureMetadata = Object.freeze({
					tags: assembled.tags,
					categories: assembled.categories,
				});
				const inventoryScope = validateBoundedMailboxInventory({
					schemaVersion: 1,
					providerId: request.providerId,
					surface: request.surface,
					accountAlias: request.accountAlias,
					runAlias: request.runAlias,
					capturedAt: deps.now(),
					partial: captureStatus.status === "partial",
					messages: [],
					folders: [],
					labels: [],
					filters: [],
				});
				const inventory = Object.freeze({
					...inventoryScope,
					messages: assembled.messages,
					folders: assembled.folders,
					labels: assembled.labels,
					filters: assembled.filters,
				});
				let bodyChecks: MailboxBodyChecks | undefined;
				if (request.bodyMessageAliases.length > 0) {
					if (
						request.bodyMessageAliases.some(
							(alias) => !assembled.messageAliases.has(alias),
						) ||
						deps.requestBodyConsent === undefined
					) {
						fail("refused", "provider_refused");
					}
					update("awaiting_body_consent", assembled.counts);
					throwIfMailboxAborted(signal);
					const consent = validateBodyConsent(
						await raceMailboxAbort(
							signal,
							() =>
								deps.requestBodyConsent?.({
									runAlias: request.runAlias,
									messageAliases:
										request.bodyMessageAliases,
								}) ??
								Promise.reject(
									new MailboxCoordinatorError(
										"refused",
										"provider_refused",
									),
								),
						),
						request.runAlias,
						request.bodyMessageAliases,
					);
					if (!consent.granted) {
						fail("refused", "provider_refused");
					}
					update("checking_bodies", assembled.counts);
					throwIfMailboxAborted(signal);
					const values = await raceMailboxAbort(
						signal,
						() =>
							deps.provider.readBodies(
								{
									...scope,
									messageAliases:
										request.bodyMessageAliases,
								},
								signal,
							),
					);
					bodyChecks = sanitizeBodies(
						values,
						request.bodyMessageAliases,
						limits.bodyUnicodeCharacters,
						Math.min(
							limits.sanitizedTextCharacters,
							limits.bodyAliases *
								limits.bodyUnicodeCharacters,
						),
					);
				}
				update("deriving_cohorts", assembled.counts);
				throwIfMailboxAborted(signal);
				await yieldMailboxTask(signal);
				const cohorts =
					await deriveMailboxCohortsFromValidatedInventoryAsync(
						inventory,
						signal,
					);
				throwIfMailboxAborted(signal);
				const choices =
					await createMailboxCleanupChoicesFromValidatedInventoryAsync(
						inventory,
						metadata,
						signal,
					);
				throwIfMailboxAborted(signal);
				return finish({
					status:
						captureStatus.status === "partial"
							? "partial"
							: "complete",
					...(captureStatus.status === "partial"
						? { reasonCode: "provider_partial" as const }
						: {}),
					inventory,
					counts: assembled.counts,
					metadata,
					cohorts,
					choices,
					...(bodyChecks === undefined ? {} : { bodyChecks }),
				});
			} catch (error) {
				if (forcedTerminal === "canceled") {
					return finish({
						status: "canceled",
						reasonCode: "canceled",
					});
				}
				if (forcedTerminal === "worker_suspended") {
					return finish({
						status: "worker_suspended",
						reasonCode: "worker_suspended",
					});
				}
				if (error instanceof DOMException && error.name === "AbortError") {
					return finish({
						status: "canceled",
						reasonCode: "canceled",
					});
				}
				return finish(resultFromError(error));
			} finally {
				running = false;
				controller = undefined;
			}
		},
		cancel() {
			if (!running || controller === undefined) return;
			forcedTerminal = "canceled";
			controller.abort();
		},
		suspend() {
			if (!running || controller === undefined) return;
			forcedTerminal = "worker_suspended";
			controller.abort();
		},
		getState() {
			return state;
		},
	});
}
