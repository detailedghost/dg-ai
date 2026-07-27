import {
	MAILBOX_REASON_CODES,
	preflightMailboxValue,
	validateMailboxInventory,
	validateMailboxPlanRevision,
	type MailboxPlanRevision,
	type MailboxReasonCode,
} from "@dg/common";
import { MAILBOX_CAPTURE_LIMITS } from "../coordinator";
import { deriveMailboxCohorts } from "../planning";
import { isValidMailboxScopedAlias } from "../privacy";
import {
	MAILBOX_CHAT_MESSAGE_TYPES,
	type MailboxChatBridge,
	type MailboxChatBridgeDeps,
	type MailboxChatMarker,
	type MailboxChatSubmission,
	type MailboxChatSubmitMessage,
	type MailboxChatSubmitResult,
} from "./contracts";

const DEFAULT_TIMEOUT_MS = 30_000;
const NONCE = /^[a-f0-9]{32}$/;

type Waiting = Readonly<{
	resolve: (result: MailboxChatSubmitResult) => void;
	reject: (error: MailboxChatBridgeError) => void;
}>;

export class MailboxChatBridgeError extends Error {
	override readonly name = "MailboxChatBridgeError";

	constructor(
		readonly code:
			| "invalid_marker"
			| "invalid_submission"
			| "invalid_message"
			| "scope_mismatch"
			| "timeout"
			| "disconnected"
			| "replay"
			| "closed"
			| "one_shot",
	) {
		super(`Mailbox chat bridge rejected: ${code}`);
	}
}

function fail(code: MailboxChatBridgeError["code"]): never {
	throw new MailboxChatBridgeError(code);
}

function exactRecord(
	value: unknown,
	keys: readonly string[],
	code: MailboxChatBridgeError["code"],
): Record<string, unknown> {
	try {
		preflightMailboxValue(value, {
			maxNodes: 100_000,
			maxKeys: 100_000,
			maxArrayLength: 20_000,
			maxTotalStringLength: MAILBOX_CAPTURE_LIMITS.chatPayloadCharacters,
			maxTotalBytes: MAILBOX_CAPTURE_LIMITS.chatPayloadCharacters * 2,
		});
	} catch {
		fail(code);
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail(code);
	}
	const input = value as Record<string, unknown>;
	const actual = Object.keys(input);
	if (
		actual.length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key)) ||
		actual.some((key) => !keys.includes(key))
	) {
		fail(code);
	}
	return input;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function opaqueHex(bytes: Uint8Array): string {
	if (
		!(bytes instanceof Uint8Array) ||
		bytes.byteLength < 16
	) {
		fail("invalid_marker");
	}
	const selected = bytes.subarray(0, 16);
	const meaningful = [...selected].filter((byte) => byte !== 0);
	if (
		new Set(selected).size < 8 ||
		meaningful.length < 8
	) {
		fail("invalid_marker");
	}
	return [...selected]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function markerFor(
	planAlias: string,
	randomBytes: () => Uint8Array,
): MailboxChatMarker {
	if (!isValidMailboxScopedAlias(planAlias, "plan")) fail("invalid_marker");
	const requestAlias = `act_${opaqueHex(randomBytes())}`;
	const nonce = opaqueHex(randomBytes());
	return Object.freeze({
		schemaVersion: 1,
		planAlias,
		requestAlias,
		nonce,
	});
}

function sameMarker(
	input: Record<string, unknown>,
	marker: MailboxChatMarker,
): boolean {
	return (
		input.schemaVersion === 1 &&
		input.planAlias === marker.planAlias &&
		input.requestAlias === marker.requestAlias &&
		input.nonce === marker.nonce
	);
}

function safeSubmission(
	value: MailboxChatSubmission,
	marker: MailboxChatMarker,
): MailboxChatSubmitMessage {
	const input = exactRecord(
		value,
		["inventory", "revision"],
		"invalid_submission",
	);
	let inventory;
	let revision;
	try {
		inventory = deepFreeze(
			validateMailboxInventory(structuredClone(input.inventory)),
		);
		revision = deepFreeze(
			validateMailboxPlanRevision(structuredClone(input.revision)),
		);
	} catch {
		fail("invalid_submission");
	}
	if (
		inventory.partial ||
		revision.planAlias !== marker.planAlias ||
		revision.state !== "draft"
	) {
		fail("invalid_submission");
	}
	const inventoryAliases = inventory.messages.map((message) => message.alias);
	const cohortAliases = revision.cohorts.flatMap(
		(cohort) => cohort.messageAliases,
	);
	if (
		new Set(cohortAliases).size !== cohortAliases.length ||
		inventoryAliases.length !== cohortAliases.length ||
		inventoryAliases.some((alias) => !cohortAliases.includes(alias)) ||
		JSON.stringify(revision.cohorts) !==
			JSON.stringify(deriveMailboxCohorts(inventory))
	) {
		fail("invalid_submission");
	}
	validateRevisionScope(revision, inventory, undefined, "invalid_submission");
	const message: MailboxChatSubmitMessage = Object.freeze({
		schemaVersion: 1,
		type: MAILBOX_CHAT_MESSAGE_TYPES.submit,
		planAlias: marker.planAlias,
		requestAlias: marker.requestAlias,
		nonce: marker.nonce,
		inventory,
		revision,
	});
	if (
		JSON.stringify(message).length >
		MAILBOX_CAPTURE_LIMITS.chatPayloadCharacters
	) {
		fail("invalid_submission");
	}
	return message;
}

function validateRevisionScope(
	revision: MailboxPlanRevision,
	inventory: ReturnType<typeof validateMailboxInventory>,
	allowedTargets:
		| MailboxPlanRevision["targets"]
		| undefined,
	code: "invalid_submission" | "invalid_message",
): void {
	const messages = new Set(
		inventory.messages.map((message) => message.alias),
	);
	const folders = new Set(inventory.folders.map((folder) => folder.alias));
	const filters = new Set(inventory.filters.map((filter) => filter.alias));
	if (
		revision.targets.folderAliases.some(
			(alias) =>
				!folders.has(alias) ||
				(allowedTargets !== undefined &&
					!allowedTargets.folderAliases.includes(alias)),
		) ||
		revision.targets.filterAliases.some(
			(alias) =>
				!filters.has(alias) ||
				(allowedTargets !== undefined &&
					!allowedTargets.filterAliases.includes(alias)),
		) ||
		(allowedTargets !== undefined &&
			revision.targets.labelAliases.some(
				(alias) => !allowedTargets.labelAliases.includes(alias),
			)) ||
		revision.actions.some((action) => {
			if ("messageAlias" in action && !messages.has(action.messageAlias)) {
				return true;
			}
			if (action.type === "move_to_folder") {
				return !revision.targets.folderAliases.includes(
					action.folderAlias,
				);
			}
			if (action.type === "apply_label" || action.type === "remove_label") {
				return !revision.targets.labelAliases.includes(action.labelAlias);
			}
			if (action.type === "deactivate_filter") {
				return !revision.targets.filterAliases.includes(
					action.filterAlias,
				);
			}
			return false;
		})
	) {
		fail(code);
	}
}

function sameSubmission(
	left: MailboxChatSubmitMessage,
	right: MailboxChatSubmitMessage,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validateProposal(
	value: unknown,
	marker: MailboxChatMarker,
	submission: MailboxChatSubmitMessage | undefined,
): MailboxPlanRevision {
	const input = exactRecord(
		value,
		[
			"schemaVersion",
			"type",
			"planAlias",
			"requestAlias",
			"nonce",
			"proposal",
		],
		"invalid_message",
	);
	if (
		input.type !== MAILBOX_CHAT_MESSAGE_TYPES.proposal ||
		!sameMarker(input, marker)
	) {
		fail("scope_mismatch");
	}
	let proposal: MailboxPlanRevision;
	try {
		proposal = deepFreeze(
			validateMailboxPlanRevision(structuredClone(input.proposal)),
		);
	} catch {
		fail("invalid_message");
	}
	if (
		submission === undefined ||
		proposal.planAlias !== marker.planAlias ||
		proposal.state !== "draft" ||
		JSON.stringify(proposal.cohorts) !==
			JSON.stringify(deriveMailboxCohorts(submission.inventory))
	) {
		fail("invalid_message");
	}
	validateRevisionScope(
		proposal,
		submission.inventory,
		submission.revision.targets,
		"invalid_message",
	);
	return proposal;
}

export function createMailboxChatBridge(
	deps: MailboxChatBridgeDeps,
): MailboxChatBridge {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		fail("invalid_marker");
	}

	let marker: MailboxChatMarker | undefined;
	let unsubscribe: (() => void) | undefined;
	let timer: unknown;
	let waiting: Waiting | undefined;
	let submission: MailboxChatSubmitMessage | undefined;
	let acknowledged = false;
	let recoverable = false;
	let opened = false;
	let openedOnce = false;
	let resumePending = false;
	let terminal = false;
	let disposed = false;

	const clearTimer = (): void => {
		if (timer === undefined) return;
		deps.clearTimeout(timer);
		timer = undefined;
	};

	const cleanup = (): void => {
		opened = false;
		clearTimer();
		unsubscribe?.();
		unsubscribe = undefined;
		try {
			void Promise.resolve(deps.transport.close()).catch(() => undefined);
		} catch {
			// The in-memory bridge state is already terminal.
		}
	};

	const finish = (result: MailboxChatSubmitResult): void => {
		if (terminal || disposed) return;
		terminal = true;
		recoverable = false;
		const current = waiting;
		waiting = undefined;
		cleanup();
		current?.resolve(result);
	};

	const rejectWaiting = (
		error: MailboxChatBridgeError,
		canReconnect: boolean,
	): void => {
		clearTimer();
		recoverable = canReconnect;
		if (canReconnect) opened = false;
		const current = waiting;
		waiting = undefined;
		if (!canReconnect) {
			terminal = true;
			cleanup();
		}
		current?.reject(error);
	};

	const armTimeout = (): void => {
		clearTimer();
		timer = deps.setTimeout(() => {
			timer = undefined;
			rejectWaiting(new MailboxChatBridgeError("timeout"), true);
		}, timeoutMs);
	};

	const onMessage = (value: unknown): void => {
		if (
			marker === undefined ||
			terminal ||
			disposed ||
			waiting === undefined
		) {
			return;
		}
		let input: Record<string, unknown>;
		try {
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				(value as Record<string, unknown>).type ===
					MAILBOX_CHAT_MESSAGE_TYPES.proposal
			) {
				if (!acknowledged) fail("invalid_message");
				finish({
					status: "proposal",
					proposal: validateProposal(value, marker, submission),
				});
				return;
			}
			const type =
				value !== null && typeof value === "object"
					? (value as Record<string, unknown>).type
					: undefined;
			if (type === MAILBOX_CHAT_MESSAGE_TYPES.ack) {
				input = exactRecord(
					value,
					[
						"schemaVersion",
						"type",
						"planAlias",
						"requestAlias",
						"nonce",
					],
					"invalid_message",
				);
				if (!sameMarker(input, marker)) fail("scope_mismatch");
				if (acknowledged) fail("replay");
				acknowledged = true;
				armTimeout();
				return;
			}
			if (type === MAILBOX_CHAT_MESSAGE_TYPES.canceled) {
				input = exactRecord(
					value,
					[
						"schemaVersion",
						"type",
						"planAlias",
						"requestAlias",
						"nonce",
					],
					"invalid_message",
				);
				if (!sameMarker(input, marker)) fail("scope_mismatch");
				finish({ status: "canceled" });
				return;
			}
			if (type === MAILBOX_CHAT_MESSAGE_TYPES.error) {
				input = exactRecord(
					value,
					[
						"schemaVersion",
						"type",
						"planAlias",
						"requestAlias",
						"nonce",
						"code",
					],
					"invalid_message",
				);
				if (!sameMarker(input, marker)) fail("scope_mismatch");
				if (
					typeof input.code !== "string" ||
					!MAILBOX_REASON_CODES.includes(
						input.code as MailboxReasonCode,
					)
				) {
					fail("invalid_message");
				}
				finish({
					status: "error",
					code: input.code as MailboxReasonCode,
				});
				return;
			}
			fail("invalid_message");
		} catch (error) {
			rejectWaiting(
				error instanceof MailboxChatBridgeError
					? error
					: new MailboxChatBridgeError("invalid_message"),
				false,
			);
		}
	};

	return Object.freeze({
		async open(planAlias) {
			if (disposed || terminal) fail("closed");
			if (marker !== undefined) fail("one_shot");
			marker = markerFor(planAlias, deps.randomBytes);
			unsubscribe = deps.transport.subscribe(onMessage);
			try {
				await deps.transport.open(marker);
				opened = true;
				openedOnce = true;
			} catch {
				recoverable = true;
				opened = false;
				throw new MailboxChatBridgeError("disconnected");
			}
			return marker;
		},
		async submit(value) {
			if (disposed || terminal) fail("replay");
			if (marker === undefined) fail("closed");
			if (!opened) fail("disconnected");
			if (waiting !== undefined) fail("one_shot");
			const safe = safeSubmission(value, marker);
			if (submission !== undefined && !sameSubmission(submission, safe)) {
				fail("replay");
			}
			if (submission === undefined) submission = safe;
			return new Promise<MailboxChatSubmitResult>((resolve, reject) => {
				waiting = { resolve, reject };
				armTimeout();
				if (resumePending) {
					resumePending = false;
					if (acknowledged) return;
				}
				void deps.transport.send(submission as MailboxChatSubmitMessage).catch(
					() => {
						rejectWaiting(
							new MailboxChatBridgeError("disconnected"),
							true,
						);
					},
				);
			});
		},
		async cancel() {
			if (disposed || terminal) return;
			if (marker === undefined) fail("closed");
			try {
				await deps.transport.cancel(marker);
			} catch {
				throw new MailboxChatBridgeError("disconnected");
			}
			finish({ status: "canceled" });
		},
		async reconnect() {
			if (
				disposed ||
				terminal ||
				marker === undefined ||
				!recoverable
			) {
				fail("closed");
			}
			if (unsubscribe === undefined) {
				unsubscribe = deps.transport.subscribe(onMessage);
			}
			if (openedOnce) {
				await deps.transport.reconnect(marker);
			} else {
				await deps.transport.open(marker);
				openedOnce = true;
			}
			opened = true;
			recoverable = false;
			resumePending = true;
		},
		isOpen() {
			return opened && !disposed && !terminal;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			const current = waiting;
			waiting = undefined;
			cleanup();
			current?.reject(new MailboxChatBridgeError("closed"));
		},
	});
}
