import {
	type MailboxAction,
	type MailboxProviderObservation,
	type MailboxReasonCode,
} from "@dg/common";
import {
	MAILBOX_CAPTURE_LIMITS,
	MailboxCoordinatorProviderError,
	computeMailboxCaptureChunkDigest,
	type MailboxCaptureChunk,
	type MailboxCoordinatorProviderSeams,
	type MailboxProviderCaptureResult,
	type MailboxProviderProbeResult,
	type RawMailboxBodyResult,
} from "../../coordinator";
import type { RawMailboxInventory } from "../../privacy";
import {
	defineMailboxProvider,
	type MailboxProvider,
	type MailboxProviderCaptureRequest,
	type MailboxProviderMutationRequest,
	type MailboxProviderVerificationRequest,
} from "../index";

type FakeFailureStage =
	| "locale"
	| "layout"
	| "probe"
	| "capture"
	| "captureResult"
	| "readBodies"
	| "apply"
	| "observe"
	| "verify";

export type FakeMailboxFailureScript = Partial<
	Readonly<Record<FakeFailureStage, MailboxReasonCode>>
>;

export type FakeMailboxProviderScript = Readonly<{
	now?: () => string;
	accountAlias?: string;
	rawInventory?: RawMailboxInventory;
	chunks?: readonly MailboxCaptureChunk[];
	captureStatus?: "complete" | "partial";
	bodyResults?: readonly RawMailboxBodyResult[];
	probeResult?: MailboxProviderProbeResult;
	failures?: FakeMailboxFailureScript;
	bindings?: Readonly<Record<string, string>>;
}>;

type FakeCallLog = Readonly<{
	probe: unknown[];
	capture: unknown[];
	captureResult: unknown[];
	readBodies: unknown[];
	observe: unknown[];
	apply: unknown[];
	verify: unknown[];
}>;

export type FakeMailboxCoordinatorSeams =
	MailboxCoordinatorProviderSeams &
		Required<
			Pick<
				MailboxCoordinatorProviderSeams,
				"observe" | "captureResult"
			>
		>;

export type FakeMailboxProviderHarness = Readonly<{
	provider: MailboxProvider;
	coordinatorSeams: FakeMailboxCoordinatorSeams;
	calls: FakeCallLog;
}>;

class FakeMailboxProviderError extends Error {
	override readonly name = "FakeMailboxProviderError";

	constructor(readonly reasonCode: MailboxReasonCode) {
		super(`Fake mailbox provider failure: ${reasonCode}`);
	}
}

type MutableRawItem = Record<string, unknown>;

type FakeMessageState = {
	raw: MutableRawItem;
	read: boolean;
	archived: boolean;
	folderId?: string;
	labelIds: Set<string>;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new MailboxCoordinatorProviderError("canceled");
	}
}

function failure(
	script: FakeMailboxProviderScript,
	stage: FakeFailureStage,
): MailboxReasonCode | undefined {
	return script.failures?.[stage];
}

function failProvider(
	script: FakeMailboxProviderScript,
	stage: FakeFailureStage,
): void {
	const reason = failure(script, stage);
	if (reason !== undefined) throw new FakeMailboxProviderError(reason);
}

function failCoordinator(
	script: FakeMailboxProviderScript,
	stage: FakeFailureStage,
): void {
	const reason = failure(script, stage);
	if (reason !== undefined) {
		throw new MailboxCoordinatorProviderError(reason);
	}
}

function now(script: FakeMailboxProviderScript): string {
	return script.now?.() ?? new Date().toISOString();
}

function observation(
	aliases: readonly string[],
	code: MailboxProviderObservation["code"],
	observedAt: string,
): MailboxProviderObservation {
	return {
		schemaVersion: 1,
		code,
		aliases,
		count: aliases.length,
		observedAt,
	};
}

function rawItems(
	inventory: RawMailboxInventory,
	key: "messages" | "folders" | "labels" | "filters",
): MutableRawItem[] {
	const value = inventory[key];
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is MutableRawItem =>
			item !== null &&
			typeof item === "object" &&
			!Array.isArray(item),
	);
}

function indexRawItems(items: readonly MutableRawItem[]): Map<string, MutableRawItem> {
	const result = new Map<string, MutableRawItem>();
	for (const item of items) {
		if (typeof item.id === "string") result.set(item.id, item);
	}
	return result;
}

async function* normalizeChunks(
	chunks: readonly MailboxCaptureChunk[],
): AsyncIterable<MailboxCaptureChunk> {
	if (
		chunks.every(
			(chunk) =>
				chunk.payload.items.length <=
				MAILBOX_CAPTURE_LIMITS.chunkItems,
		)
	) {
		for (const chunk of chunks) yield chunk;
		return;
	}
	const declaredTotal = chunks.reduce(
		(total, chunk) =>
			total +
			Math.ceil(
				chunk.payload.items.length /
					MAILBOX_CAPTURE_LIMITS.chunkItems,
			),
		0,
	);
	let sequence = 0;
	for (const chunk of chunks) {
		for (
			let offset = 0;
			offset < chunk.payload.items.length;
			offset += MAILBOX_CAPTURE_LIMITS.chunkItems
		) {
			const payload = {
				kind: chunk.payload.kind,
				items: chunk.payload.items.slice(
					offset,
					offset + MAILBOX_CAPTURE_LIMITS.chunkItems,
				),
			};
			const envelope = {
				schemaVersion: 1 as const,
				runAlias: chunks[0]?.runAlias ?? "",
				sequence,
				declaredTotal,
				itemCount: payload.items.length,
				payload,
			};
			yield {
				...envelope,
				digest:
					await computeMailboxCaptureChunkDigest(envelope),
			};
			sequence += 1;
		}
	}
}

function scopeKey(request: MailboxProviderCaptureRequest): string {
	return [
		request.providerId,
		request.surface,
		request.accountAlias,
		request.runAlias,
		request.revisionAlias,
	]
		.map((value) => `${value.length}:${value}`)
		.join("|");
}

export function createFakeMailboxProviderHarness(
	script: FakeMailboxProviderScript = {},
): FakeMailboxProviderHarness {
	const calls: FakeCallLog = {
		probe: [],
		capture: [],
		captureResult: [],
		readBodies: [],
		observe: [],
		apply: [],
		verify: [],
	};
	const bindings = new Map(Object.entries(script.bindings ?? {}));
	const liveInventory = structuredClone(
		script.rawInventory ?? { messages: [] },
	);
	const rawMessages = indexRawItems(rawItems(liveInventory, "messages"));
	const rawFolders = indexRawItems(rawItems(liveInventory, "folders"));
	const rawLabels = indexRawItems(rawItems(liveInventory, "labels"));
	const rawFilters = indexRawItems(rawItems(liveInventory, "filters"));
	const messageStates = new Map<string, FakeMessageState>();
	for (const [id, raw] of rawMessages) {
		messageStates.set(id, {
			raw,
			read: raw.read === true,
			archived: raw.archived === true,
			...(typeof raw.folderId === "string"
				? { folderId: raw.folderId }
				: {}),
			labelIds: new Set(
				Array.isArray(raw.labelIds)
					? raw.labelIds.filter(
							(value): value is string =>
								typeof value === "string",
						)
					: [],
			),
		});
	}
	const capturedMessageAliases = new Set(
		(script.chunks ?? []).flatMap((chunk) =>
			chunk.payload.kind === "messages"
				? chunk.payload.items.flatMap((item) => {
						if (
							item !== null &&
							typeof item === "object" &&
							!Array.isArray(item) &&
							typeof (item as { alias?: unknown }).alias ===
								"string"
						) {
							return [(item as { alias: string }).alias];
						}
						return [];
					})
				: [],
		),
	);
	const filterStates = new Map(
		[...rawFilters].map(([id, raw]) => [id, raw.active !== false]),
	);
	let completedCaptureScope: string | undefined;

	const boundRaw = (alias: string): string => {
		const rawId = bindings.get(alias);
		if (rawId === undefined) throw new FakeMailboxProviderError("stale_binding");
		return rawId;
	};
	const messageFor = (alias: string): FakeMessageState => {
		const state = messageStates.get(boundRaw(alias));
		if (state === undefined) throw new FakeMailboxProviderError("stale_binding");
		return state;
	};
	const targetFor = (
		alias: string,
		items: ReadonlyMap<string, MutableRawItem>,
	): string => {
		const rawId = boundRaw(alias);
		if (!items.has(rawId)) throw new FakeMailboxProviderError("stale_binding");
		return rawId;
	};
	const primaryAlias = (action: MailboxAction): string =>
		"messageAlias" in action
			? action.messageAlias
			: action.filterAlias;
	const assertRawTarget = (
		request:
			| MailboxProviderMutationRequest
			| MailboxProviderVerificationRequest,
	): void => {
		if (boundRaw(primaryAlias(request.action)) !== request.rawTarget) {
			throw new FakeMailboxProviderError("stale_binding");
		}
	};

	const applyAction = (action: MailboxAction): void => {
		switch (action.type) {
			case "archive": {
				const message = messageFor(action.messageAlias);
				message.archived = true;
				message.raw.archived = true;
				break;
			}
			case "mark_read": {
				const message = messageFor(action.messageAlias);
				message.read = true;
				message.raw.read = true;
				break;
			}
			case "move_to_folder": {
				const message = messageFor(action.messageAlias);
				message.folderId = targetFor(action.folderAlias, rawFolders);
				message.raw.folderId = message.folderId;
				break;
			}
			case "apply_label": {
				const message = messageFor(action.messageAlias);
				message.labelIds.add(targetFor(action.labelAlias, rawLabels));
				message.raw.labelIds = [...message.labelIds];
				break;
			}
			case "remove_label": {
				const message = messageFor(action.messageAlias);
				message.labelIds.delete(targetFor(action.labelAlias, rawLabels));
				message.raw.labelIds = [...message.labelIds];
				break;
			}
			case "deactivate_filter": {
				const rawId = targetFor(action.filterAlias, rawFilters);
				filterStates.set(rawId, false);
				const raw = rawFilters.get(rawId);
				if (raw !== undefined) raw.active = false;
				break;
			}
		}
	};

	const actionApplied = (action: MailboxAction): boolean => {
		switch (action.type) {
			case "archive":
				return messageFor(action.messageAlias).archived;
			case "mark_read":
				return messageFor(action.messageAlias).read;
			case "move_to_folder":
				return (
					messageFor(action.messageAlias).folderId ===
					targetFor(action.folderAlias, rawFolders)
				);
			case "apply_label":
				return messageFor(action.messageAlias).labelIds.has(
					targetFor(action.labelAlias, rawLabels),
				);
			case "remove_label":
				return !messageFor(action.messageAlias).labelIds.has(
					targetFor(action.labelAlias, rawLabels),
				);
			case "deactivate_filter":
				return (
					filterStates.get(
						targetFor(action.filterAlias, rawFilters),
					) === false
				);
		}
	};

	const provider = defineMailboxProvider({
		id: "fake-mail",
		surfaces: ["inbox"],
		readLocale() {
			failProvider(script, "locale");
			return "en-US";
		},
		hasPositiveLayoutSignature(surface) {
			failProvider(script, "layout");
			return surface === "inbox";
		},
		capture(request: MailboxProviderCaptureRequest) {
			calls.capture.push(request);
			failProvider(script, "capture");
			return structuredClone(liveInventory);
		},
		apply(request: MailboxProviderMutationRequest) {
			calls.apply.push(request);
			failProvider(script, "apply");
			assertRawTarget(request);
			applyAction(request.action);
			const aliases = [primaryAlias(request.action)];
			return observation(aliases, "changed", now(script));
		},
		verify(request: MailboxProviderVerificationRequest) {
			calls.verify.push(request);
			failProvider(script, "verify");
			assertRawTarget(request);
			const aliases = [primaryAlias(request.action)];
			const verified = actionApplied(request.action);
			return {
				schemaVersion: 1,
				action: request.action,
				status: verified ? "completed" : "failed",
				...(verified
					? {}
					: { reasonCode: "verification_mismatch" as const }),
				affectedCount: verified ? 1 : 0,
				observations: [
					observation(
						aliases,
						verified ? "verified" : "verification_mismatch",
						now(script),
					),
				],
			};
		},
	});

	const coordinatorSeams: FakeMailboxCoordinatorSeams = Object.freeze({
		async probe(request, signal) {
			throwIfAborted(signal);
			calls.probe.push(request);
			const reason = failure(script, "probe");
			if (reason !== undefined) {
				switch (reason) {
					case "blocked_prompt":
						return { status: "blocked_prompt", reasonCode: reason };
					case "wrong_account":
						return { status: "wrong_account", reasonCode: reason };
					case "worker_suspended":
						return { status: "worker_suspended", reasonCode: reason };
					case "provider_refused":
						return { status: "signed_out", reasonCode: reason };
					default:
						throw new MailboxCoordinatorProviderError(reason);
				}
			}
			if (script.probeResult !== undefined) return script.probeResult;
			return {
				status: "ready",
				accountAlias: script.accountAlias ?? request.accountAlias,
				surface: request.surface,
			};
		},
		async *capture(request, signal) {
			throwIfAborted(signal);
			failCoordinator(script, "capture");
			calls.capture.push(request);
			completedCaptureScope = undefined;
			for await (const chunk of normalizeChunks(script.chunks ?? [])) {
				throwIfAborted(signal);
				yield chunk;
			}
			throwIfAborted(signal);
			completedCaptureScope = scopeKey(request);
		},
		async captureResult(request, signal): Promise<MailboxProviderCaptureResult> {
			if (request == null || signal == null) {
				throw new MailboxCoordinatorProviderError("malformed_stream");
			}
			throwIfAborted(signal);
			failCoordinator(script, "captureResult");
			calls.captureResult.push(request);
			if (
				completedCaptureScope === undefined ||
				completedCaptureScope !== scopeKey(request)
			) {
				throw new MailboxCoordinatorProviderError("malformed_stream");
			}
			return script.captureStatus === "partial"
				? {
						status: "partial",
						reasonCode: "provider_partial",
					}
				: { status: "complete" };
		},
		async readBodies(request, signal) {
			throwIfAborted(signal);
			failCoordinator(script, "readBodies");
			for (const alias of request.messageAliases) {
				if (!capturedMessageAliases.has(alias)) messageFor(alias);
			}
			calls.readBodies.push(request);
			return structuredClone(script.bodyResults ?? []);
		},
		async observe(request, signal) {
			throwIfAborted(signal);
			calls.observe.push(request);
			const reason = failure(script, "observe");
			if (
				reason !== undefined &&
				reason !== "verification_mismatch"
			) {
				throw new MailboxCoordinatorProviderError(reason);
			}
			const matched = request.messageAliases.every((alias) => {
				try {
					messageFor(alias);
					return true;
				} catch {
					return false;
				}
			});
			return observation(
				request.messageAliases,
				reason === "verification_mismatch" || !matched
					? "verification_mismatch"
					: "matched",
				now(script),
			);
		},
	});

	return Object.freeze({
		provider,
		coordinatorSeams,
		calls,
	});
}
