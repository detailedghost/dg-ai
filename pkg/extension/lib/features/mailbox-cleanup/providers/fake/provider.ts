import {
	MAILBOX_EXECUTION_ACTION_TYPES,
	type MailboxAction,
	type MailboxCanonicalAction,
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
	type MailboxProviderCoordinatorSeams,
	type MailboxProviderDispatchRequest,
	type MailboxProviderMutationRequest,
	type MailboxProviderObserveRequest,
	type MailboxProviderVerificationRequest,
} from "../index";

type FakeFailureStage =
	| "locale"
	| "layout"
	| "probe"
	| "capture"
	| "captureResult"
	| "readBodies"
	| "preflight"
	| "dispatch"
	| "apply"
	| "observe"
	| "verifyFresh"
	| "observeInbox"
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
	preflight: unknown[];
	dispatch: unknown[];
	verifyFresh: unknown[];
	observeInbox: unknown[];
	apply: unknown[];
	verify: unknown[];
}>;

export type FakeMailboxCoordinatorSeams =
	MailboxProviderCoordinatorSeams &
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

function changedAliases(
	action: MailboxCanonicalAction,
): readonly string[] {
	const aliases = (() => {
		switch (action.type) {
			case "archive":
			case "mark_read":
				return [action.messageAlias];
			case "move_to_folder":
				return [action.messageAlias, action.folderAlias];
			case "apply_label":
			case "apply_category":
				return [action.messageAlias, action.labelAlias];
			case "create_folder":
			case "create_label":
			case "create_category":
			case "create_filter":
				return [];
			case "rename_folder":
				return [action.folderAlias];
			case "rename_label":
			case "rename_category":
				return [action.labelAlias];
			case "deactivate_filter":
				return [action.filterAlias];
			case "change_filter":
				return [action.filterAlias];
		}
	})();
	return Object.freeze([...aliases].sort());
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

async function scopeChunks(
	chunks: readonly MailboxCaptureChunk[],
	runAlias: string,
	sourceChunks: readonly MailboxCaptureChunk[] = chunks,
): Promise<readonly MailboxCaptureChunk[]> {
	return Promise.all(
		chunks.map(async (chunk, index) => {
			const envelope = {
				schemaVersion: chunk.schemaVersion,
				runAlias,
				sequence: chunk.sequence,
				itemCount: chunk.itemCount,
				payload: chunk.payload,
				...(chunk.declaredTotal === undefined
					? {}
					: { declaredTotal: chunk.declaredTotal }),
				...(chunk.final === undefined ? {} : { final: chunk.final }),
			};
			const source = sourceChunks[index];
			const sourceEnvelope =
				source === undefined
					? undefined
					: {
							schemaVersion: source.schemaVersion,
							runAlias: source.runAlias,
							sequence: source.sequence,
							itemCount: source.itemCount,
							payload: source.payload,
							...(source.declaredTotal === undefined
								? {}
								: { declaredTotal: source.declaredTotal }),
							...(source.final === undefined
								? {}
								: { final: source.final }),
						};
			const sourceDigestValid =
				source === undefined ||
				(sourceEnvelope !== undefined &&
					source.digest ===
						await computeMailboxCaptureChunkDigest(
							sourceEnvelope,
						).catch(() => ""));
			return Object.freeze({
				...envelope,
				digest: sourceDigestValid
					? await computeMailboxCaptureChunkDigest(envelope)
					: source.digest,
			});
		}),
	);
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
		preflight: [],
		dispatch: [],
		verifyFresh: [],
		observeInbox: [],
		apply: [],
		verify: [],
	};
	const bindings = new Map(Object.entries(script.bindings ?? {}));
	const liveInventory = structuredClone(
		script.rawInventory ?? { messages: [] },
	);
	const liveFolders = rawItems(liveInventory, "folders");
	const liveLabels = rawItems(liveInventory, "labels");
	const liveFilters = rawItems(liveInventory, "filters");
	const rawMessages = indexRawItems(rawItems(liveInventory, "messages"));
	const rawFolders = indexRawItems(liveFolders);
	const rawLabels = indexRawItems(liveLabels);
	const rawFilters = indexRawItems(liveFilters);
	const initialMessageFolderIds = new Map(
		[...rawMessages].map(([id, raw]) => [
			id,
			typeof raw.folderId === "string" ? raw.folderId : undefined,
		]),
	);
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

	const liveCaptureChunks = (): readonly MailboxCaptureChunk[] => {
		const projected = (script.chunks ?? []).map((chunk) => {
			const items = chunk.payload.items.flatMap((candidate) => {
				if (
					candidate === null ||
					typeof candidate !== "object" ||
					Array.isArray(candidate) ||
					typeof (candidate as { alias?: unknown }).alias !==
						"string"
				) {
					return [candidate];
				}
				const item = candidate as Record<string, unknown> & {
					alias: string;
				};
				const rawId = bindings.get(item.alias);
				if (rawId === undefined) return [structuredClone(item)];
				switch (chunk.payload.kind) {
					case "messages": {
						const raw = rawMessages.get(rawId);
						if (raw === undefined) {
							return [structuredClone(item)];
						}
						if (
							raw.archived === true ||
							raw.folderId !== initialMessageFolderIds.get(rawId)
						) {
							return [];
						}
						return [{
							...structuredClone(item),
							read: raw.read === true,
							hasAttachments: raw.hasAttachments === true,
							...(typeof raw.receivedAt === "string"
								? { receivedAt: raw.receivedAt }
								: {}),
							...(typeof raw.category === "string"
								? { category: raw.category }
								: {}),
						}];
					}
					case "folders": {
						const raw = rawFolders.get(rawId);
						return raw === undefined
							? [structuredClone(item)]
							: [{
									alias: item.alias,
									...(typeof raw.messageCount === "number"
										? { messageCount: raw.messageCount }
										: {}),
								}];
					}
					case "labels":
					case "tags":
					case "categories": {
						const raw = rawLabels.get(rawId);
						return raw === undefined
							? [structuredClone(item)]
							: [{
									alias: item.alias,
									...(typeof raw.messageCount === "number"
										? { messageCount: raw.messageCount }
										: {}),
								}];
					}
					case "filters": {
						const raw = rawFilters.get(rawId);
						return raw === undefined
							? [structuredClone(item)]
							: [{
									alias: item.alias,
									active: raw.active !== false,
								}];
					}
					default:
						return [structuredClone(item)];
				}
			});
			return {
				...chunk,
				itemCount:
					items.length === chunk.payload.items.length
						? chunk.itemCount
						: items.length,
				payload: {
					kind: chunk.payload.kind,
					items,
				},
			};
		});
		const cardinalityChanged = projected.some(
			(chunk, index) =>
				chunk.payload.items.length !==
				(script.chunks?.[index]?.payload.items.length ?? 0),
		);
		if (!cardinalityChanged) return projected;
		const retained = projected.filter(
			(chunk) =>
				chunk.payload.items.length > 0 ||
				chunk.payload.kind === "messages",
		);
		const summaryChanged = projected.some(
			(chunk, index) =>
				chunk.payload.kind === "messages" &&
				chunk.payload.items.length !==
					(script.chunks?.[index]?.payload.items.length ?? 0),
		);
		if (!summaryChanged) return projected;
		return retained.map((chunk, sequence) => ({
			...chunk,
			sequence,
			declaredTotal: retained.length,
			final: undefined,
		}));
	};

	const boundRaw = (alias: string): string => {
		const rawId = bindings.get(alias);
		if (rawId === undefined) throw new FakeMailboxProviderError("stale_binding");
		return rawId;
	};
	const messageFor = (
		alias: string,
		resolve: (alias: string) => string = boundRaw,
	): FakeMessageState => {
		const state = messageStates.get(resolve(alias));
		if (state === undefined) throw new FakeMailboxProviderError("stale_binding");
		return state;
	};
	const targetFor = (
		alias: string,
		items: ReadonlyMap<string, MutableRawItem>,
		resolve: (alias: string) => string = boundRaw,
	): string => {
		const rawId = resolve(alias);
		if (!items.has(rawId)) throw new FakeMailboxProviderError("stale_binding");
		return rawId;
	};
	const adjustCount = (
		item: MutableRawItem | undefined,
		delta: -1 | 1,
	): void => {
		if (item === undefined) return;
		const current =
			typeof item.messageCount === "number" &&
			Number.isSafeInteger(item.messageCount) &&
			item.messageCount >= 0
				? item.messageCount
				: 0;
		item.messageCount = Math.max(0, current + delta);
	};
	const primaryAlias = (
		action: MailboxAction | MailboxCanonicalAction,
	): string => {
		if ("messageAlias" in action) return action.messageAlias;
		if ("folderAlias" in action) return action.folderAlias;
		if ("labelAlias" in action) return action.labelAlias;
		return action.filterAlias;
	};
	const assertRawTarget = (
		request:
			| MailboxProviderMutationRequest
			| MailboxProviderVerificationRequest,
	): void => {
		if (boundRaw(primaryAlias(request.action)) !== request.rawTarget) {
			throw new FakeMailboxProviderError("stale_binding");
		}
	};

	const applyAction = (
		action: MailboxAction | MailboxCanonicalAction,
		resolve: (alias: string) => string = boundRaw,
	): void => {
		switch (action.type) {
			case "archive": {
				const message = messageFor(action.messageAlias, resolve);
				message.archived = true;
				message.raw.archived = true;
				break;
			}
			case "mark_read": {
				const message = messageFor(action.messageAlias, resolve);
				message.read = true;
				message.raw.read = true;
				break;
			}
			case "move_to_folder": {
				const message = messageFor(action.messageAlias, resolve);
				const nextFolderId = targetFor(
					action.folderAlias,
					rawFolders,
					resolve,
				);
				if (message.folderId !== nextFolderId) {
					adjustCount(
						message.folderId === undefined
							? undefined
							: rawFolders.get(message.folderId),
						-1,
					);
					adjustCount(rawFolders.get(nextFolderId), 1);
				}
				message.folderId = nextFolderId;
				message.raw.folderId = message.folderId;
				break;
			}
			case "create_folder": {
				const rawId = resolve(action.folderAlias);
				if (rawFolders.has(rawId)) {
					throw new FakeMailboxProviderError("provider_refused");
				}
				const raw = { id: rawId, messageCount: 0 };
				rawFolders.set(rawId, raw);
				liveFolders.push(raw);
				break;
			}
			case "rename_folder": {
				const rawId = targetFor(
					action.folderAlias,
					rawFolders,
					resolve,
				);
				const raw = rawFolders.get(rawId);
				if (raw !== undefined) {
					raw.name = resolve(action.replacementFolderAlias);
				}
				break;
			}
			case "create_label":
			case "create_category": {
				const rawId = resolve(action.labelAlias);
				if (rawLabels.has(rawId)) {
					throw new FakeMailboxProviderError("provider_refused");
				}
				const raw = {
					id: rawId,
					messageCount: 0,
					kind:
						action.type === "create_category"
							? "category"
							: "label",
				};
				rawLabels.set(rawId, raw);
				liveLabels.push(raw);
				break;
			}
			case "rename_label":
			case "rename_category": {
				const rawId = targetFor(
					action.labelAlias,
					rawLabels,
					resolve,
				);
				const raw = rawLabels.get(rawId);
				if (raw !== undefined) {
					raw.name = resolve(action.replacementLabelAlias);
				}
				break;
			}
			case "apply_label": {
				const message = messageFor(action.messageAlias, resolve);
				const labelId = targetFor(
					action.labelAlias,
					rawLabels,
					resolve,
				);
				if (!message.labelIds.has(labelId)) {
					message.labelIds.add(labelId);
					adjustCount(rawLabels.get(labelId), 1);
				}
				message.raw.labelIds = [...message.labelIds];
				break;
			}
			case "apply_category": {
				const message = messageFor(action.messageAlias, resolve);
				const labelId = targetFor(
					action.labelAlias,
					rawLabels,
					resolve,
				);
				if (!message.labelIds.has(labelId)) {
					message.labelIds.add(labelId);
					adjustCount(rawLabels.get(labelId), 1);
				}
				message.raw.labelIds = [...message.labelIds];
				break;
			}
			case "remove_label": {
				const message = messageFor(action.messageAlias, resolve);
				message.labelIds.delete(
					targetFor(action.labelAlias, rawLabels, resolve),
				);
				message.raw.labelIds = [...message.labelIds];
				break;
			}
			case "create_filter": {
				const rawId = resolve(action.filterAlias);
				if (rawFilters.has(rawId)) {
					throw new FakeMailboxProviderError("provider_refused");
				}
				const raw = { id: rawId, active: true };
				rawFilters.set(rawId, raw);
				liveFilters.push(raw);
				filterStates.set(rawId, true);
				break;
			}
			case "change_filter": {
				const rawId = targetFor(
					action.filterAlias,
					rawFilters,
					resolve,
				);
				const raw = rawFilters.get(rawId);
				if (raw !== undefined) {
					raw.configuration = resolve(
						action.replacementFilterAlias,
					);
				}
				break;
			}
			case "deactivate_filter": {
				const rawId = targetFor(
					action.filterAlias,
					rawFilters,
					resolve,
				);
				filterStates.set(rawId, false);
				const raw = rawFilters.get(rawId);
				if (raw !== undefined) raw.active = false;
				break;
			}
		}
	};

	const actionApplied = (
		action: MailboxAction | MailboxCanonicalAction,
		resolve: (alias: string) => string = boundRaw,
	): boolean => {
		switch (action.type) {
			case "archive":
				return messageFor(action.messageAlias, resolve).archived;
			case "mark_read":
				return messageFor(action.messageAlias, resolve).read;
			case "move_to_folder":
				return (
					messageFor(action.messageAlias, resolve).folderId ===
					targetFor(action.folderAlias, rawFolders, resolve)
				);
			case "create_folder":
				return rawFolders.has(resolve(action.folderAlias));
			case "rename_folder":
				return (
					rawFolders.get(
						targetFor(action.folderAlias, rawFolders, resolve),
					)?.name === resolve(action.replacementFolderAlias)
				);
			case "create_label":
			case "create_category":
				return rawLabels.has(resolve(action.labelAlias));
			case "rename_label":
			case "rename_category":
				return (
					rawLabels.get(
						targetFor(action.labelAlias, rawLabels, resolve),
					)?.name === resolve(action.replacementLabelAlias)
				);
			case "apply_label":
			case "apply_category":
				return messageFor(action.messageAlias, resolve).labelIds.has(
					targetFor(action.labelAlias, rawLabels, resolve),
				);
			case "remove_label":
				return !messageFor(action.messageAlias, resolve).labelIds.has(
					targetFor(action.labelAlias, rawLabels, resolve),
				);
			case "create_filter":
				return rawFilters.has(resolve(action.filterAlias));
			case "change_filter":
				return (
					rawFilters.get(
						targetFor(action.filterAlias, rawFilters, resolve),
					)?.configuration ===
					resolve(action.replacementFilterAlias)
				);
			case "deactivate_filter":
				return (
					filterStates.get(
						targetFor(action.filterAlias, rawFilters, resolve),
					) === false
				);
		}
	};

	let coordinatorSeams!: FakeMailboxCoordinatorSeams;
	const coordinatorProxy: MailboxProviderCoordinatorSeams = Object.freeze({
		probe: (request, signal) => coordinatorSeams.probe(request, signal),
		capture: (request, signal) => coordinatorSeams.capture(request, signal),
		readBodies: (request, signal) =>
			coordinatorSeams.readBodies(request, signal),
		captureResult: (request, signal) =>
			coordinatorSeams.captureResult(request, signal),
		bindings: (request, signal) =>
			coordinatorSeams.bindings(request, signal),
		observe: (request, signal) =>
			coordinatorSeams.observe(request, signal),
	});
	const provider = defineMailboxProvider({
		id: "fake-mail",
		surfaces: ["inbox"],
		coordinator: coordinatorProxy,
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
		preflight(request) {
			calls.preflight.push(request);
			failProvider(script, "preflight");
			return {
				status: "ready",
				providerId: "fake-mail",
				surface: request.surface,
				accountAlias:
					script.accountAlias ?? request.accountAlias,
				locale: "en-US",
				layout: "supported",
				capabilities: MAILBOX_EXECUTION_ACTION_TYPES,
				targets: "available",
			};
		},
		dispatch(request: MailboxProviderDispatchRequest) {
			calls.dispatch.push(request);
			failProvider(script, "dispatch");
			const resolve = (alias: string): string => {
				const raw = request.rawTargets[alias];
				if (raw === undefined) {
					throw new FakeMailboxProviderError("stale_binding");
				}
				return raw;
			};
			applyAction(request.action, resolve);
			return { status: "dispatched" };
		},
		observe(request: MailboxProviderObserveRequest) {
			calls.observe.push(request);
			const reason = failure(script, "observe");
			if (reason !== undefined) {
				return {
					status: "ambiguous",
					reasonCode: reason,
				};
			}
			const resolve = (alias: string): string => {
				const raw = request.rawTargets[alias];
				if (raw === undefined) {
					throw new FakeMailboxProviderError("stale_binding");
				}
				return raw;
			};
			return actionApplied(request.action, resolve)
				? { status: "observed", observedAt: now(script) }
				: {
						status: "ambiguous",
						reasonCode: "verification_mismatch",
					};
		},
		verifyFresh(request: MailboxProviderObserveRequest) {
			calls.verifyFresh.push(request);
			const reason = failure(script, "verifyFresh");
			if (reason !== undefined) {
				return {
					status:
						reason === "provider_timeout"
							? "timeout"
							: "ambiguous",
					reasonCode: reason,
				};
			}
			const resolve = (alias: string): string => {
				const raw = request.rawTargets[alias];
				if (raw === undefined) {
					throw new FakeMailboxProviderError("stale_binding");
				}
				return raw;
			};
			return actionApplied(request.action, resolve)
				? {
						status: "verified",
						verifiedAt: now(script),
						delta: {
							schemaVersion: 1,
							scope: "entire_fingerprint",
							actionAlias: request.action.actionAlias,
							changedAliases: changedAliases(request.action),
						},
					}
				: {
						status: "mismatch",
						reasonCode: "verification_mismatch",
					};
		},
		observeInbox(request: MailboxProviderCaptureRequest) {
			calls.observeInbox.push(request);
			const reason = failure(script, "observeInbox");
			if (reason !== undefined) {
				return {
					status:
						reason === "provider_timeout"
							? "timeout"
							: "ambiguous",
					reasonCode: reason,
				};
			}
			const count = [...messageStates.values()].filter(
				(message) => !message.archived,
			).length;
			return {
				status: "observed",
				count,
				observedAt: now(script),
			};
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

	coordinatorSeams = Object.freeze({
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
			for await (const chunk of normalizeChunks(
				await scopeChunks(
					liveCaptureChunks(),
					request.runAlias,
					script.chunks,
				),
			)) {
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
		async bindings(request, signal) {
			throwIfAborted(signal);
			if (
				completedCaptureScope === undefined ||
				completedCaptureScope !== scopeKey(request)
			) {
				throw new MailboxCoordinatorProviderError("malformed_stream");
			}
			return Object.freeze({ ...(script.bindings ?? {}) });
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
