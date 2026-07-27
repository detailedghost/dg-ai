import {
	type MailboxInventory,
	preflightMailboxValue,
} from "@dg/common";
import { isValidMailboxScopedAlias } from "../privacy";
import {
	raceMailboxAbort,
	throwIfMailboxAborted,
	yieldMailboxTask,
} from "./abort";
import {
	MAILBOX_CAPTURE_KINDS,
	type MailboxAssembledCapture,
	type MailboxCaptureChunk,
	type MailboxCaptureChunkDigestInput,
	type MailboxCaptureChunkPayload,
	type MailboxCaptureCounts,
	type MailboxCaptureKind,
	type MailboxCaptureLimits,
	type MailboxCaptureMetadataItem,
} from "./contracts";
import {
	canonicalMailboxValue,
	sha256Hex,
} from "./hash";
import { validateBoundedMailboxInventory } from "./inventory";

const DIGEST = /^[a-f0-9]{64}$/;

export class MailboxCaptureStreamError extends Error {
	override readonly name = "MailboxCaptureStreamError";
	readonly code = "malformed_stream" as const;

	constructor() {
		super("Mailbox capture rejected: malformed_stream");
	}
}

function fail(): never {
	throw new MailboxCaptureStreamError();
}

function preflightCaptureValue(value: unknown): void {
	preflightMailboxValue(value, {
		maxNodes: 100_000,
		maxKeys: 100_000,
		maxTotalStringLength: 2_000_000,
		maxTotalBytes: 4_000_000,
	});
}

function snapshotCaptureValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(snapshotCaptureValue));
	}
	if (value !== null && typeof value === "object") {
		const snapshot: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			snapshot[key] = snapshotCaptureValue(
				(value as Record<string, unknown>)[key],
			);
		}
		return Object.freeze(snapshot);
	}
	return value;
}

function exactObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail();
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	if (
		required.some((key) => !Object.hasOwn(input, key)) ||
		keys.some((key) => !required.includes(key) && !optional.includes(key))
	) {
		fail();
	}
	return input;
}

function termination(
	input: Record<string, unknown>,
): Readonly<{ declaredTotal: number } | { final: true }> {
	const hasTotal = Object.hasOwn(input, "declaredTotal");
	const hasFinal = Object.hasOwn(input, "final");
	if (
		hasTotal === hasFinal ||
		(hasTotal &&
			(!Number.isSafeInteger(input.declaredTotal) ||
				(input.declaredTotal as number) < 1)) ||
		(hasFinal && input.final !== true)
	) {
		fail();
	}
	return hasTotal
		? { declaredTotal: input.declaredTotal as number }
		: { final: true };
}

function validatePayload(value: unknown): MailboxCaptureChunkPayload {
	const input = exactObject(value, ["kind", "items"]);
	if (
		typeof input.kind !== "string" ||
		!(MAILBOX_CAPTURE_KINDS as readonly string[]).includes(input.kind) ||
		!Array.isArray(input.items)
	) {
		fail();
	}
	return Object.freeze({
		kind: input.kind,
		items: input.items,
	}) satisfies MailboxCaptureChunkPayload;
}

function chunkDigestInput(
	input: Record<string, unknown>,
	payload: MailboxCaptureChunkPayload,
): MailboxCaptureChunkDigestInput {
	if (
		input.schemaVersion !== 1 ||
		!isValidMailboxScopedAlias(input.runAlias, "run") ||
		!Number.isSafeInteger(input.sequence) ||
		(input.sequence as number) < 0 ||
		!Number.isSafeInteger(input.itemCount) ||
		(input.itemCount as number) < 0 ||
		input.itemCount !== payload.items.length
	) {
		fail();
	}
	return Object.freeze({
		schemaVersion: 1,
		runAlias: input.runAlias,
		sequence: input.sequence as number,
		itemCount: input.itemCount as number,
		payload,
		...termination(input),
	});
}

function parseDigestEnvelope(
	value: unknown,
): MailboxCaptureChunkDigestInput {
	const input = exactObject(
		value,
		["schemaVersion", "runAlias", "sequence", "itemCount", "payload"],
		["declaredTotal", "final"],
	);
	const payload = validatePayload(input.payload);
	return chunkDigestInput(input, payload);
}

export async function computeMailboxCaptureChunkDigest(
	value: MailboxCaptureChunkDigestInput,
): Promise<string> {
	preflightCaptureValue(value);
	const snapshot = snapshotCaptureValue(value);
	return sha256Hex(
		canonicalMailboxValue(parseDigestEnvelope(snapshot)),
	);
}

type ValidatedChunk = Readonly<{
	chunk: MailboxCaptureChunk;
	canonicalCharacters: number;
}>;

type ChunkConstraints = Readonly<{
	runAlias: string;
	sequence: number;
	maximumItems: number;
	maximumChunks: number;
	maximumCanonicalCharacters: number;
}>;

async function validateChunk(
	value: unknown,
	constraints?: ChunkConstraints,
): Promise<ValidatedChunk> {
	preflightCaptureValue(value);
	const snapshot = snapshotCaptureValue(value);
	const input = exactObject(
		snapshot,
		[
			"schemaVersion",
			"runAlias",
			"sequence",
			"itemCount",
			"digest",
			"payload",
		],
		["declaredTotal", "final"],
	);
	const payload = validatePayload(input.payload);
	const envelope = chunkDigestInput(input, payload);
	if (
		constraints !== undefined &&
		(envelope.runAlias !== constraints.runAlias ||
			envelope.sequence !== constraints.sequence ||
			envelope.itemCount > constraints.maximumItems ||
			envelope.sequence >= constraints.maximumChunks ||
			(envelope.declaredTotal !== undefined &&
				envelope.declaredTotal > constraints.maximumChunks))
	) {
		fail();
	}
	const canonical = canonicalMailboxValue(envelope);
	if (
		constraints !== undefined &&
		canonical.length > constraints.maximumCanonicalCharacters
	) {
		fail();
	}
	if (
		typeof input.digest !== "string" ||
		!DIGEST.test(input.digest) ||
		input.digest !== await sha256Hex(canonical) ||
		(envelope.itemCount === 0 && envelope.final !== true)
	) {
		fail();
	}
	return {
		chunk: Object.freeze({
			...envelope,
			digest: input.digest,
		}),
		canonicalCharacters: canonical.length,
	};
}

export async function validateMailboxCaptureChunk(
	value: unknown,
): Promise<MailboxCaptureChunk> {
	return (await validateChunk(value)).chunk;
}

type ConsumeOptions = Readonly<{
	runAlias: string;
	limits: MailboxCaptureLimits;
	signal?: AbortSignal;
	onChunk?: (chunk: MailboxCaptureChunk) => void;
}>;

function validateMetadataItems(
	items: readonly unknown[],
): readonly MailboxCaptureMetadataItem[] {
	return items.map((item) => {
		const input = exactObject(item, ["alias"], ["messageCount"]);
		if (
			!isValidMailboxScopedAlias(input.alias, "lbl") ||
			(input.messageCount !== undefined &&
				(!Number.isSafeInteger(input.messageCount) ||
					(input.messageCount as number) < 0))
		) {
			fail();
		}
		return Object.freeze({
			alias: input.alias,
			...(input.messageCount === undefined
				? {}
				: { messageCount: input.messageCount as number }),
		});
	});
}

function validateItems(
	kind: MailboxCaptureKind,
	items: readonly unknown[],
): readonly unknown[] {
	if (kind === "tags" || kind === "categories") {
		return validateMetadataItems(items);
	}
	const inventory = validateBoundedMailboxInventory({
		schemaVersion: 1,
		providerId: "capture-validator",
		surface: "inbox",
		accountAlias: "acct_00112233445566778899aabbccddeeff",
		runAlias: "run_102132435465768798a9bacbdcedfe0f",
		capturedAt: "2026-01-01T00:00:00.000Z",
		partial: false,
		messages:
			kind === "messages"
				? (items as MailboxInventory["messages"])
				: [],
		folders:
			kind === "folders"
				? (items as MailboxInventory["folders"])
				: [],
		labels:
			kind === "labels"
				? (items as MailboxInventory["labels"])
				: [],
		filters:
			kind === "filters"
				? (items as MailboxInventory["filters"])
				: [],
	});
	return Object.freeze(
		inventory[
			kind as "messages" | "folders" | "labels" | "filters"
		].map((item) => Object.freeze(item)),
	) as readonly unknown[];
}

function emptyCounts(): Record<MailboxCaptureKind, number> {
	return {
		messages: 0,
		folders: 0,
		labels: 0,
		tags: 0,
		categories: 0,
		filters: 0,
	};
}

function iteratorFor(
	stream: Iterable<unknown> | AsyncIterable<unknown>,
): AsyncIterator<unknown> | Iterator<unknown> {
	if (Symbol.asyncIterator in stream) {
		return stream[Symbol.asyncIterator]();
	}
	if (Symbol.iterator in stream) return stream[Symbol.iterator]();
	fail();
}

export async function consumeMailboxCaptureChunks(
	stream: Iterable<unknown> | AsyncIterable<unknown>,
	options: ConsumeOptions,
): Promise<MailboxAssembledCapture> {
	if (!isValidMailboxScopedAlias(options.runAlias, "run")) fail();
	const signal = options.signal ?? new AbortController().signal;
	const iterator = iteratorFor(stream);
	const counts = emptyCounts();
	const collections = {
		messages: [] as unknown[],
		folders: [] as unknown[],
		labels: [] as unknown[],
		tags: [] as MailboxCaptureMetadataItem[],
		categories: [] as MailboxCaptureMetadataItem[],
		filters: [] as unknown[],
	};
	const aliases = new Set<string>();
	const messageAliases = new Set<string>();
	let expectedSequence = 0;
	let declaredTotal: number | undefined;
	let sawFinal = false;
	let sawSummary = false;
	let metadataStarted = false;
	let assembledItems = 0;
	let sanitizedCharacters = 0;

	try {
		while (true) {
			const step = await raceMailboxAbort(
				signal,
				() => iterator.next(),
			);
			if (step.done) break;
			throwIfMailboxAborted(signal);
			const validated = await raceMailboxAbort(
				signal,
				() =>
					validateChunk(step.value, {
						runAlias: options.runAlias,
						sequence: expectedSequence,
						maximumItems: options.limits.chunkItems,
						maximumChunks: options.limits.chunks,
						maximumCanonicalCharacters: Math.min(
							options.limits.sanitizedTextCharacters -
								sanitizedCharacters,
							options.limits.chatPayloadCharacters -
								sanitizedCharacters,
						),
					}),
			);
			const chunk = validated.chunk;
			if (
				sawFinal
			) {
				fail();
			}
			if (chunk.declaredTotal !== undefined) {
				if (
					chunk.declaredTotal > options.limits.chunks ||
					(declaredTotal !== undefined &&
						declaredTotal !== chunk.declaredTotal)
				) {
					fail();
				}
				declaredTotal = chunk.declaredTotal;
			} else {
				if (declaredTotal !== undefined) fail();
				sawFinal = true;
			}
			const kind = chunk.payload.kind as MailboxCaptureKind;
			if (
				(!sawSummary && kind !== "messages") ||
				(metadataStarted && kind === "messages")
			) {
				fail();
			}
			if (kind === "messages") sawSummary = true;
			else metadataStarted = true;

			expectedSequence += 1;
			assembledItems += chunk.itemCount;
			sanitizedCharacters += validated.canonicalCharacters;
			if (
				assembledItems > options.limits.assembledInventoryItems ||
				sanitizedCharacters > options.limits.sanitizedTextCharacters ||
				sanitizedCharacters > options.limits.chatPayloadCharacters
			) {
				fail();
			}
			const nextCount = counts[kind] + chunk.itemCount;
			if (nextCount > options.limits[kind]) fail();
			counts[kind] = nextCount;
			let safeItems: readonly unknown[];
			try {
				safeItems = validateItems(kind, chunk.payload.items);
			} catch {
				fail();
			}
			for (const item of safeItems) {
				const alias = (item as { alias?: unknown }).alias;
				if (typeof alias !== "string" || aliases.has(alias)) fail();
				aliases.add(alias);
				if (kind === "messages") messageAliases.add(alias);
			}
			switch (kind) {
				case "messages":
					collections.messages.push(...safeItems);
					break;
				case "folders":
					collections.folders.push(...safeItems);
					break;
				case "labels":
					collections.labels.push(...safeItems);
					break;
				case "tags":
					collections.tags.push(
						...(safeItems as readonly MailboxCaptureMetadataItem[]),
					);
					break;
				case "categories":
					collections.categories.push(
						...(safeItems as readonly MailboxCaptureMetadataItem[]),
					);
					break;
				case "filters":
					collections.filters.push(...safeItems);
					break;
			}
			options.onChunk?.(chunk);
			await yieldMailboxTask(signal);
		}
	} finally {
		if (typeof iterator.return === "function") {
			try {
				const returned = Promise.resolve(iterator.return());
				if (signal.aborted) void returned.catch(() => undefined);
				else await raceMailboxAbort(signal, () => returned);
			} catch (error) {
				if (!signal.aborted) throw error;
			}
		}
	}

	if (
		expectedSequence === 0 ||
		!sawSummary ||
		(declaredTotal !== undefined && expectedSequence !== declaredTotal) ||
		(declaredTotal === undefined && !sawFinal)
	) {
		fail();
	}
	return Object.freeze({
		counts: Object.freeze({ ...counts }) as MailboxCaptureCounts,
		messages: Object.freeze(
			collections.messages,
		) as unknown as MailboxAssembledCapture["messages"],
		folders: Object.freeze(
			collections.folders,
		) as unknown as MailboxAssembledCapture["folders"],
		labels: Object.freeze(
			collections.labels,
		) as unknown as MailboxAssembledCapture["labels"],
		tags: Object.freeze(collections.tags),
		categories: Object.freeze(collections.categories),
		filters: Object.freeze(
			collections.filters,
		) as unknown as MailboxAssembledCapture["filters"],
		messageAliases,
	});
}
