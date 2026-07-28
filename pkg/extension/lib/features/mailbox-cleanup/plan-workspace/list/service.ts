import { validateMailboxPlanRevision } from "@dg/common";
import { isValidMailboxScopedAlias } from "../../privacy";
import type {
	MailboxPlanBindingContext,
	MailboxPlanListActionResult,
	MailboxPlanListCommand,
	MailboxPlanListQuery,
	MailboxPlanListResult,
	MailboxPlanListRow,
	MailboxPlanListService,
	MailboxPlanListServiceDeps,
	MailboxPlanStaleReason,
} from "./contracts";

const REGISTRY_KEY = "dg:mailbox-plan-list:v1";
const MAX_ROWS = 10_000;
const MAX_REQUESTS_PER_PLAN = 1_024;
const MAX_CAS_ATTEMPTS = 32;
const ADMISSION_TTL_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DRAFT_RETENTION_MS = 30 * DAY_MS;
const MAX_DISPLAY_EXPIRY_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE = /^[a-z][a-z0-9_-]{0,63}$/;
const REQUEST_ALIAS = /^req_[a-f0-9]{32}$/;

type StoredCheck = Readonly<{
	planAlias: string;
	revisionAlias: string;
	status: "ready" | "failed";
	reason?: Exclude<MailboxPlanStaleReason, "none" | "check_required">;
}>;

type StoredRestart = Readonly<{
	planAlias: string;
	revisionAlias: string;
	requestAlias: string;
	status: "fencing" | "active" | "failed" | "completed";
	reason?: Exclude<MailboxPlanStaleReason, "none" | "check_required">;
	candidateRevisionAlias?: string;
	desiredState?: "draft" | "approved" | "in_flight";
}>;

type StoredRequest = Readonly<{
	planAlias: string;
	revisionAlias: string;
	requestAlias: string;
	expiresAt: number;
}>;

type StoredAdmission = Readonly<{
	planAlias: string;
	revisionAlias: string;
	owner: string;
	expiresAt: number;
}>;

type Registry = Readonly<{
	schemaVersion: 1;
	contexts: readonly MailboxPlanBindingContext[];
	checks: readonly StoredCheck[];
	restarts: readonly StoredRestart[];
	requests: readonly StoredRequest[];
	admissions: readonly StoredAdmission[];
}>;

export class MailboxPlanListError extends Error {
	override readonly name = "MailboxPlanListError";

	constructor(
		readonly code:
			| "invalid_input"
			| "storage_failure"
			| "not_found"
			| "invalid_action"
			| "replay"
			| "conflict",
	) {
		super(`Mailbox plan list failed safely: ${code}`);
	}
}

function fail(code: MailboxPlanListError["code"]): never {
	throw new MailboxPlanListError(code);
}

function plain(value: unknown): Record<string, unknown> | undefined {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
		? value as Record<string, unknown>
		: undefined;
}

function exact(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		keys.every((key) => allowed.has(key))
	);
}

function context(value: unknown): MailboxPlanBindingContext {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(input, [
			"schemaVersion",
			"planAlias",
			"revisionAlias",
			"providerId",
			"surface",
			"accountAlias",
			"runAlias",
		]) ||
		input.schemaVersion !== 1 ||
		typeof input.providerId !== "string" ||
		!PROVIDER_ID.test(input.providerId) ||
		typeof input.surface !== "string" ||
		!SURFACE.test(input.surface) ||
		typeof input.planAlias !== "string" ||
		!isValidMailboxScopedAlias(input.planAlias, "plan") ||
		typeof input.revisionAlias !== "string" ||
		!isValidMailboxScopedAlias(input.revisionAlias, "rev") ||
		typeof input.accountAlias !== "string" ||
		!isValidMailboxScopedAlias(input.accountAlias, "acct") ||
		typeof input.runAlias !== "string" ||
		!isValidMailboxScopedAlias(input.runAlias, "run")
	) {
		fail("storage_failure");
	}
	return Object.freeze({
		schemaVersion: 1,
		planAlias: input.planAlias,
		revisionAlias: input.revisionAlias,
		providerId: input.providerId,
		surface: input.surface,
		accountAlias: input.accountAlias,
		runAlias: input.runAlias,
	});
}

function identity(planAlias: string, revisionAlias: string): string {
	return `${planAlias}:${revisionAlias}`;
}

function bindingScope(value: MailboxPlanBindingContext) {
	return Object.freeze({
		planAlias: value.planAlias,
		providerId: value.providerId,
		surface: value.surface,
		accountAlias: value.accountAlias,
		runAlias: value.runAlias,
		revisionAlias: value.revisionAlias,
	});
}

function validDataAlias(value: string): boolean {
	const prefix = value.split("_", 1)[0];
	return (
		(prefix === "msg" ||
			prefix === "fld" ||
			prefix === "lbl" ||
			prefix === "flt") &&
		isValidMailboxScopedAlias(value, prefix)
	);
}

function validateRegistry(value: unknown): Registry {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(input, [
			"schemaVersion",
			"contexts",
			"checks",
			"restarts",
			"requests",
		], ["admissions"]) ||
		input.schemaVersion !== 1 ||
		!Array.isArray(input.contexts) ||
		!Array.isArray(input.checks) ||
		!Array.isArray(input.restarts) ||
		!Array.isArray(input.requests) ||
		(input.admissions !== undefined &&
			!Array.isArray(input.admissions)) ||
		input.contexts.length > MAX_ROWS ||
		input.checks.length > MAX_ROWS ||
		input.restarts.length > MAX_ROWS ||
		(Array.isArray(input.admissions) &&
			input.admissions.length > MAX_ROWS) ||
		input.requests.length > MAX_ROWS * MAX_REQUESTS_PER_PLAN
	) {
		fail("storage_failure");
	}
	const contexts = input.contexts.map(context);
	if (
		new Set(
			contexts.map((item) =>
				identity(item.planAlias, item.revisionAlias),
			),
		).size !== contexts.length
	) {
		fail("storage_failure");
	}
	const checks = input.checks.map((value): StoredCheck => {
		const item = plain(value);
		if (
			item === undefined ||
			!exact(
				item,
				["planAlias", "revisionAlias", "status"],
				["reason"],
			) ||
			typeof item.planAlias !== "string" ||
			!isValidMailboxScopedAlias(item.planAlias, "plan") ||
			typeof item.revisionAlias !== "string" ||
			!isValidMailboxScopedAlias(item.revisionAlias, "rev") ||
			(item.status !== "ready" && item.status !== "failed") ||
			(item.status === "ready" && item.reason !== undefined) ||
			(item.status === "failed" &&
				![
					"fingerprint_mismatch",
					"account_mismatch",
					"layout_mismatch",
					"preflight_failed",
					"storage_failure",
				].includes(String(item.reason)))
		) {
			fail("storage_failure");
		}
		return Object.freeze({
			planAlias: item.planAlias,
			revisionAlias: item.revisionAlias,
			status: item.status,
			...(item.reason === undefined
				? {}
				: {
						reason:
							item.reason as StoredCheck["reason"],
					}),
		});
	});
	const restarts = input.restarts.map((value): StoredRestart => {
		const item = plain(value);
		if (
			item === undefined ||
			!exact(
				item,
				[
					"planAlias",
					"revisionAlias",
					"requestAlias",
					"status",
				],
				["reason", "candidateRevisionAlias", "desiredState"],
			) ||
			typeof item.planAlias !== "string" ||
			!isValidMailboxScopedAlias(item.planAlias, "plan") ||
			typeof item.revisionAlias !== "string" ||
			!isValidMailboxScopedAlias(item.revisionAlias, "rev") ||
			typeof item.requestAlias !== "string" ||
			!REQUEST_ALIAS.test(item.requestAlias) ||
				!["fencing", "active", "failed", "completed"].includes(
					String(item.status),
				) ||
			(item.candidateRevisionAlias !== undefined &&
				(typeof item.candidateRevisionAlias !== "string" ||
					!isValidMailboxScopedAlias(
						item.candidateRevisionAlias,
						"rev",
					))) ||
			(item.desiredState !== undefined &&
				!["draft", "approved", "in_flight"].includes(
					String(item.desiredState),
				))
		) {
			fail("storage_failure");
		}
		return Object.freeze({
			planAlias: item.planAlias,
			revisionAlias: item.revisionAlias,
			requestAlias: item.requestAlias,
			status: item.status as StoredRestart["status"],
			...(item.reason === undefined
				? {}
				: {
						reason:
							item.reason as StoredRestart["reason"],
					}),
			...(item.candidateRevisionAlias === undefined
				? {}
				: {
						candidateRevisionAlias:
							item.candidateRevisionAlias,
					}),
			...(item.desiredState === undefined
				? {}
				: {
						desiredState:
							item.desiredState as StoredRestart["desiredState"],
					}),
		});
	});
	const requests = input.requests.map((value): StoredRequest => {
		const item = plain(value);
		if (
			item === undefined ||
			!exact(item, [
				"planAlias",
				"revisionAlias",
				"requestAlias",
				"expiresAt",
			]) ||
			typeof item.planAlias !== "string" ||
			!isValidMailboxScopedAlias(item.planAlias, "plan") ||
			typeof item.revisionAlias !== "string" ||
			!isValidMailboxScopedAlias(item.revisionAlias, "rev") ||
			typeof item.requestAlias !== "string" ||
			!REQUEST_ALIAS.test(item.requestAlias) ||
			typeof item.expiresAt !== "number" ||
			!Number.isSafeInteger(item.expiresAt)
		) {
			fail("storage_failure");
		}
		return Object.freeze({
			planAlias: item.planAlias,
			revisionAlias: item.revisionAlias,
			requestAlias: item.requestAlias,
			expiresAt: item.expiresAt,
		});
	});
	const admissionValues: unknown[] = Array.isArray(input.admissions)
		? input.admissions
		: [];
	const admissions = admissionValues.map(
		(value): StoredAdmission => {
			const item = plain(value);
			if (
				item === undefined ||
				!exact(item, [
					"planAlias",
					"revisionAlias",
					"owner",
					"expiresAt",
				]) ||
				typeof item.planAlias !== "string" ||
				!isValidMailboxScopedAlias(item.planAlias, "plan") ||
				typeof item.revisionAlias !== "string" ||
				!isValidMailboxScopedAlias(item.revisionAlias, "rev") ||
				typeof item.owner !== "string" ||
				!/^exec_[a-f0-9]{32}$/.test(item.owner) ||
				typeof item.expiresAt !== "number" ||
				!Number.isSafeInteger(item.expiresAt)
			) {
				fail("storage_failure");
			}
			return Object.freeze({
				planAlias: item.planAlias,
				revisionAlias: item.revisionAlias,
				owner: item.owner,
				expiresAt: item.expiresAt,
			});
		},
	);
	if (
		new Set(checks.map((item) => identity(item.planAlias, item.revisionAlias)))
			.size !== checks.length ||
		new Set(
			restarts.map((item) => identity(item.planAlias, item.revisionAlias)),
		).size !== restarts.length ||
		new Set(requests.map((item) => item.requestAlias)).size !==
			requests.length ||
		new Set(
			admissions.map((item) =>
				identity(item.planAlias, item.revisionAlias),
			),
		).size !== admissions.length ||
		[...new Set(requests.map((item) => item.planAlias))].some(
			(planAlias) =>
				requests.filter((item) => item.planAlias === planAlias).length >
				MAX_REQUESTS_PER_PLAN,
		)
	) {
		fail("storage_failure");
	}
	return Object.freeze({
		schemaVersion: 1,
		contexts: Object.freeze(contexts),
		checks: Object.freeze(checks),
		restarts: Object.freeze(restarts),
		requests: Object.freeze(requests),
		admissions: Object.freeze(admissions),
	});
}

const emptyRegistry = (): Registry =>
	Object.freeze({
		schemaVersion: 1,
		contexts: Object.freeze([]),
		checks: Object.freeze([]),
		restarts: Object.freeze([]),
		requests: Object.freeze([]),
		admissions: Object.freeze([]),
	});

function query(value: MailboxPlanListQuery | undefined): MailboxPlanListQuery {
	if (value === undefined) return Object.freeze({});
	const input = plain(value);
	if (
		input === undefined ||
		!exact(
			input,
			[],
			["states", "stale", "providerId", "surface", "accountAlias"],
		) ||
		(input.states !== undefined &&
			(!Array.isArray(input.states) ||
				input.states.length > 4 ||
				new Set(input.states).size !== input.states.length ||
				input.states.some(
					(state) =>
						![
							"draft",
							"approved",
							"in_flight",
							"completed",
						].includes(String(state)),
				))) ||
		(input.stale !== undefined &&
			!["all", "only", "exclude"].includes(String(input.stale))) ||
		(input.providerId !== undefined &&
			(typeof input.providerId !== "string" ||
				!PROVIDER_ID.test(input.providerId))) ||
		(input.surface !== undefined &&
			(typeof input.surface !== "string" ||
				!SURFACE.test(input.surface))) ||
		(input.accountAlias !== undefined &&
			(typeof input.accountAlias !== "string" ||
				!isValidMailboxScopedAlias(input.accountAlias, "acct")))
	) {
		fail("invalid_input");
	}
	return Object.freeze({
		...(input.states === undefined
			? {}
			: {
					states: Object.freeze(
						input.states as MailboxPlanListQuery["states"],
					),
				}),
		...(input.stale === undefined
			? {}
			: { stale: input.stale as MailboxPlanListQuery["stale"] }),
		...(input.providerId === undefined
			? {}
			: { providerId: input.providerId as string }),
		...(input.surface === undefined
			? {}
			: { surface: input.surface as string }),
		...(input.accountAlias === undefined
			? {}
			: { accountAlias: input.accountAlias as string }),
	});
}

function command(value: MailboxPlanListCommand): MailboxPlanListCommand {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(input, [
			"schemaVersion",
			"type",
			"planAlias",
			"revisionAlias",
			"requestAlias",
		]) ||
		input.schemaVersion !== 1 ||
		!["edit", "preflight", "focus", "resume", "restart"].includes(
			String(input.type),
		) ||
		typeof input.planAlias !== "string" ||
		!isValidMailboxScopedAlias(input.planAlias, "plan") ||
		typeof input.revisionAlias !== "string" ||
		!isValidMailboxScopedAlias(input.revisionAlias, "rev") ||
		typeof input.requestAlias !== "string" ||
		!REQUEST_ALIAS.test(input.requestAlias)
	) {
		fail("invalid_input");
	}
	return Object.freeze({
		schemaVersion: 1,
		type: input.type as MailboxPlanListCommand["type"],
		planAlias: input.planAlias,
		revisionAlias: input.revisionAlias,
		requestAlias: input.requestAlias,
	});
}

function completed(
	input: MailboxPlanListCommand,
	revisionAlias = input.revisionAlias,
	lifecycleState: MailboxPlanListRow["lifecycleState"] = "draft",
	preservedApproval = false,
): MailboxPlanListActionResult {
	return Object.freeze({
		schemaVersion: 1,
		status: "completed",
		requestAlias: input.requestAlias,
		action: input.type,
		planAlias: input.planAlias,
		revisionAlias,
		lifecycleState,
		preservedApproval,
	});
}

function blocked(
	input: MailboxPlanListCommand,
	reason: Exclude<MailboxPlanStaleReason, "none" | "check_required">,
): MailboxPlanListActionResult {
	return Object.freeze({
		schemaVersion: 1,
		status: "blocked",
		requestAlias: input.requestAlias,
		action: input.type,
		reason,
	});
}

export function createMailboxPlanListService(
	deps: MailboxPlanListServiceDeps,
): MailboxPlanListService {
	const activeRequests = new Map<string, Promise<MailboxPlanListActionResult>>();
	const planQueues = new Map<string, Promise<void>>();

	const readRegistry = async (): Promise<{
		registry: Registry;
		version?: number;
		corrupt: boolean;
	}> => {
		try {
			const record = await deps.storage.read(REGISTRY_KEY);
			return record === undefined
				? { registry: emptyRegistry(), corrupt: false }
				: {
						registry: validateRegistry(record.value),
						version: record.version,
						corrupt: false,
					};
		} catch {
			return { registry: emptyRegistry(), corrupt: true };
		}
	};

	const mutateRegistry = async (
		operation: (registry: Registry) => Registry,
	): Promise<Registry> => {
		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
			const current = await readRegistry();
			if (current.corrupt) fail("storage_failure");
			const next = validateRegistry(operation(current.registry));
			try {
				if (
					await deps.storage.compareAndSet(
						REGISTRY_KEY,
						current.version,
						next,
					)
				) {
					return next;
				}
			} catch {
				fail("storage_failure");
			}
		}
		fail("conflict");
	};

	const serialized = <T>(
		planAlias: string,
		operation: () => Promise<T>,
	): Promise<T> => {
		const previous = planQueues.get(planAlias) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		planQueues.set(planAlias, settled);
		return result.finally(() => {
			if (planQueues.get(planAlias) === settled) {
				planQueues.delete(planAlias);
			}
		});
	};

	const updateRestart = (
		registry: Registry,
		source: Readonly<{ planAlias: string; revisionAlias: string }>,
		next: StoredRestart,
		extraContexts: readonly MailboxPlanBindingContext[] = [],
	): Registry => {
		const sourceKey = identity(source.planAlias, source.revisionAlias);
		const currentRestart = registry.restarts.find(
			(item) =>
				identity(item.planAlias, item.revisionAlias) === sourceKey,
		);
		if (
			currentRestart !== undefined &&
			currentRestart.requestAlias !== next.requestAlias
		) {
			fail("conflict");
		}
		if (
			currentRestart !== undefined &&
			next.status !== "failed" &&
			currentRestart.status !== "active" &&
			!(
				currentRestart.status === "fencing" &&
				next.status === "active"
			)
		) {
			fail("conflict");
		}
		const contexts = [...registry.contexts];
		for (const candidate of extraContexts) {
			const candidateKey = identity(
				candidate.planAlias,
				candidate.revisionAlias,
			);
			const existing = contexts.find(
				(item) =>
					identity(item.planAlias, item.revisionAlias) ===
					candidateKey,
			);
			if (
				existing !== undefined &&
				JSON.stringify(existing) !== JSON.stringify(candidate)
			) {
				fail("conflict");
			}
			if (existing === undefined) contexts.push(candidate);
		}
		return {
			...registry,
			contexts: Object.freeze(contexts),
			restarts: Object.freeze([
				...registry.restarts.filter(
					(item) =>
						identity(item.planAlias, item.revisionAlias) !==
						sourceKey,
				),
				next,
			]),
		};
	};

	const assertCurrentSource = async (
		expected: Readonly<{
			revision: ReturnType<typeof validateMailboxPlanRevision>;
			expiresAt: number;
		}>,
	): Promise<void> => {
		const current = await deps.store.getRecord(
			expected.revision.planAlias,
			expected.revision.revisionAlias,
		);
		if (
			current === undefined ||
			deps.now() >= current.expiresAt ||
			current.expiresAt !== expected.expiresAt ||
			JSON.stringify(validateMailboxPlanRevision(current.revision)) !==
				JSON.stringify(expected.revision)
		) {
			fail("storage_failure");
		}
	};

	const waitForExecutionDrain = async (
		planAlias: string,
		revisionAlias: string,
		signal?: AbortSignal,
	): Promise<void> => {
		const deadline = Date.now() + ADMISSION_TTL_MS + 5_000;
		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			const stored = await readRegistry();
			if (stored.corrupt) fail("storage_failure");
			const live = stored.registry.admissions.some(
				(item) =>
					item.planAlias === planAlias &&
					item.revisionAlias === revisionAlias &&
					deps.now() < item.expiresAt,
			);
			if (!live) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		fail("conflict");
	};

	const transitionCandidate = async (
		planAlias: string,
		revisionAlias: string,
		desiredState: "draft" | "approved" | "in_flight",
	): Promise<void> => {
		const current = await deps.store.getRecord(planAlias, revisionAlias);
		if (current === undefined) fail("storage_failure");
		let state = current.revision.state;
		if (state === desiredState) return;
		if (state === "draft" && desiredState !== "draft") {
			await deps.lifecycle.transition({
				planAlias,
				revisionAlias,
				expectedState: "draft",
				nextState: "approved",
			});
			state = "approved";
		}
		if (state === "approved" && desiredState === "in_flight") {
			await deps.lifecycle.transition({
				planAlias,
				revisionAlias,
				expectedState: "approved",
				nextState: "in_flight",
			});
			state = "in_flight";
		}
		if (state !== desiredState) fail("storage_failure");
	};

	const validCheckpoints = (
		values: readonly import("./contracts").MailboxPlanRestartCheckpoint[],
		source: ReturnType<typeof validateMailboxPlanRevision>,
	): readonly import("./contracts").MailboxPlanRestartCheckpoint[] => {
		if (!Array.isArray(values) || values.length > source.actions.length) {
			fail("storage_failure");
		}
		const actionAliases = new Set(
			source.actions.flatMap((action) =>
				"actionAlias" in action &&
				typeof action.actionAlias === "string"
					? [action.actionAlias]
					: [],
			),
		);
		const seen = new Set<string>();
		return Object.freeze(
			values.map((value) => {
				const item = plain(value);
				if (
					item === undefined ||
					!exact(item, ["actionAlias", "state"]) ||
					typeof item.actionAlias !== "string" ||
					!/^act_[a-f0-9]{32}$/.test(item.actionAlias) ||
					seen.has(item.actionAlias) ||
					!actionAliases.has(item.actionAlias) ||
					![
						"verified",
						"needs_review",
						"skipped",
						"pending",
					].includes(String(item.state))
				) {
					fail("storage_failure");
				}
				seen.add(item.actionAlias);
				return Object.freeze({
					actionAlias: item.actionAlias,
					state:
						item.state as import("./contracts").MailboxPlanRestartCheckpoint["state"],
				});
			}),
		);
	};

	const failRestart = async (
		source: Readonly<{ planAlias: string; revisionAlias: string }>,
		requestAlias: string,
		reason: Exclude<MailboxPlanStaleReason, "none" | "check_required">,
	): Promise<void> => {
		const current = await readRegistry();
		const restart = current.registry.restarts.find(
			(item) =>
				identity(item.planAlias, item.revisionAlias) ===
				identity(source.planAlias, source.revisionAlias),
		);
		if (restart?.candidateRevisionAlias !== undefined) {
			const candidateContext = current.registry.contexts.find(
				(item) =>
					item.planAlias === source.planAlias &&
					item.revisionAlias === restart.candidateRevisionAlias,
			);
			if (candidateContext !== undefined) {
				await deps.bindings
					.invalidateRevision(
						source.planAlias,
						restart.candidateRevisionAlias,
						"restart_required",
					)
					.catch(() => undefined);
			}
		}
		await mutateRegistry((registry) =>
			updateRestart(registry, source, {
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias,
				status: "failed",
				reason,
				...(restart?.candidateRevisionAlias === undefined
					? {}
					: {
							candidateRevisionAlias:
								restart.candidateRevisionAlias,
						}),
			}),
		);
	};

	const restart = async (
		input: MailboxPlanListCommand,
		signal?: AbortSignal,
	): Promise<MailboxPlanListActionResult> =>
		serialized(input.planAlias, async () => {
			const sourceRecord = await deps.store.getRecord(
				input.planAlias,
				input.revisionAlias,
			);
			if (sourceRecord === undefined || deps.now() >= sourceRecord.expiresAt) {
				return blocked(input, "storage_failure");
			}
			const source = validateMailboxPlanRevision(sourceRecord.revision);
			const initial = await readRegistry();
			if (initial.corrupt) return blocked(input, "storage_failure");
			const sourceContext = initial.registry.contexts.find(
				(item) =>
					item.planAlias === input.planAlias &&
					item.revisionAlias === input.revisionAlias,
			);
			if (sourceContext === undefined) {
				return blocked(input, "storage_failure");
			}
			try {
				await mutateRegistry((registry) => {
					const existing = registry.restarts.find(
						(item) =>
							item.planAlias === input.planAlias &&
							item.revisionAlias === input.revisionAlias,
					);
					if (
						existing?.status === "active" ||
						existing?.status === "fencing"
					) fail("conflict");
					if (existing?.status === "completed") fail("replay");
					const liveAdmissions = registry.admissions.filter(
						(item) => deps.now() < item.expiresAt,
					);
					const admitted = liveAdmissions.some(
						(item) =>
							item.planAlias === input.planAlias &&
							item.revisionAlias === input.revisionAlias,
					);
					if (admitted) fail("conflict");
					return updateRestart(
						{
							...registry,
							admissions: Object.freeze(liveAdmissions),
							restarts: Object.freeze(
								registry.restarts.filter(
									(item) =>
										item.planAlias !== input.planAlias ||
										item.revisionAlias !== input.revisionAlias,
								),
							),
						},
						input,
						{
							planAlias: input.planAlias,
							revisionAlias: input.revisionAlias,
							requestAlias: input.requestAlias,
							status: "active",
						},
					);
				});
			} catch {
				return blocked(input, "interrupted_restart");
			}
			if (
				deps.execution.fenceRestart !== undefined &&
				(source.state === "approved" ||
					source.state === "in_flight")
			) {
				await deps.execution.fenceRestart(
					input.planAlias,
					input.revisionAlias,
					signal,
				);
			}
			const claimed = await readRegistry();
			const claim = claimed.registry.restarts.find(
				(item) =>
					item.planAlias === input.planAlias &&
					item.revisionAlias === input.revisionAlias &&
					item.requestAlias === input.requestAlias,
			);
			if (claim?.status !== "active") {
				return blocked(input, "interrupted_restart");
			}
			let previousBindings: Readonly<Record<string, string>> | undefined;
			try {
				previousBindings = await deps.bindings.get(
					bindingScope(sourceContext),
				);
			} catch {
				await failRestart(
					input,
					input.requestAlias,
					"storage_failure",
				);
				return blocked(input, "storage_failure");
			}
			if (
				previousBindings !== undefined &&
				Object.keys(previousBindings).length === 0
			) {
				previousBindings = undefined;
			}
			const owned = await readRegistry();
			if (
				owned.corrupt ||
				!owned.registry.restarts.some(
					(item) =>
						item.planAlias === input.planAlias &&
						item.revisionAlias === input.revisionAlias &&
						item.requestAlias === input.requestAlias &&
						item.status === "active",
				)
			) {
				return blocked(input, "interrupted_restart");
			}
			await deps.bindings.invalidateRevision(
				input.planAlias,
				input.revisionAlias,
				"restart_required",
			);
			const invalidatedOwner = await readRegistry();
			if (
				invalidatedOwner.corrupt ||
				!invalidatedOwner.registry.restarts.some(
					(item) =>
						item.planAlias === input.planAlias &&
						item.revisionAlias === input.revisionAlias &&
						item.requestAlias === input.requestAlias &&
						item.status === "active",
				)
			) {
				return blocked(input, "interrupted_restart");
			}
			const controller = new AbortController();
			const timeoutMs = deps.restartTimeoutMs ?? 30_000;
			if (
				!Number.isSafeInteger(timeoutMs) ||
				timeoutMs < 10 ||
				timeoutMs > 120_000
			) {
				await failRestart(input, input.requestAlias, "storage_failure");
				return blocked(input, "storage_failure");
			}
			const onAbort = (): void => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) controller.abort();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let candidateContext: MailboxPlanBindingContext | undefined;
			try {
				await assertCurrentSource(sourceRecord);
				const checkpoints =
					source.state === "in_flight"
						? validCheckpoints(
								await deps.execution.checkpoints(
									input.planAlias,
									input.revisionAlias,
								),
								source,
							)
						: Object.freeze([]);
				const comparisonAuthority =
					source.state === "in_flight" &&
						deps.execution.restartAuthority !== undefined
						? await deps.execution.restartAuthority(
								input.planAlias,
								input.revisionAlias,
							)
						: undefined;
				const captured = await deps.rescan({
					sourceRevision: source,
					sourceContext,
					previousBindings,
					checkpoints,
					...(comparisonAuthority === undefined
						? {}
						: { comparisonAuthority }),
					signal: controller.signal,
				});
				if (controller.signal.aborted) {
					throw new DOMException("Aborted", "AbortError");
				}
				const candidate = validateMailboxPlanRevision(captured.revision);
				await assertCurrentSource(sourceRecord);
				candidateContext = context(captured.context);
				if (
					candidate.planAlias !== source.planAlias ||
					candidate.revisionAlias === source.revisionAlias ||
					candidate.revisionNumber <= source.revisionNumber ||
					candidate.state !== "draft" ||
					candidate.restartRequired ||
					candidateContext.planAlias !== source.planAlias ||
					candidateContext.revisionAlias !== candidate.revisionAlias ||
					candidateContext.providerId !== sourceContext.providerId ||
					candidateContext.surface !== sourceContext.surface ||
					candidateContext.accountAlias !== sourceContext.accountAlias ||
					candidateContext.runAlias === sourceContext.runAlias
				) {
					throw new MailboxPlanListError("storage_failure");
				}
				if (!captured.proof.sameAccount) {
					await failRestart(
						input,
						input.requestAlias,
						"account_mismatch",
					);
					return blocked(input, "account_mismatch");
				}
				if (captured.proof.layout !== "supported") {
					await failRestart(
						input,
						input.requestAlias,
						"layout_mismatch",
					);
					return blocked(input, "layout_mismatch");
				}
				if (captured.proof.preflight !== "ready") {
					await failRestart(
						input,
						input.requestAlias,
						"preflight_failed",
					);
					return blocked(input, "preflight_failed");
				}
				const oldAliases = new Set(
					Object.keys(previousBindings ?? {}),
				);
				const freshAliases = Object.keys(captured.bindings);
				if (
					freshAliases.length > MAX_ROWS ||
					freshAliases.some(
						(alias) =>
							oldAliases.has(alias) ||
							!validDataAlias(alias),
					)
				) {
					throw new MailboxPlanListError("storage_failure");
				}
				const priorAliasMap =
					captured.priorToFreshAliases === undefined
						? undefined
						: plain(captured.priorToFreshAliases);
				if (
					captured.priorToFreshAliases !== undefined &&
					(priorAliasMap === undefined ||
						Object.keys(priorAliasMap).length > MAX_ROWS ||
						Object.entries(priorAliasMap).some(
							([prior, fresh]) =>
								!validDataAlias(prior) ||
								typeof fresh !== "string" ||
								!validDataAlias(fresh) ||
								prior === fresh,
						) ||
						new Set(Object.values(priorAliasMap)).size !==
							Object.keys(priorAliasMap).length)
				) {
					throw new MailboxPlanListError("storage_failure");
				}
				await mutateRegistry((registry) =>
					updateRestart(
						registry,
						input,
						{
							planAlias: input.planAlias,
							revisionAlias: input.revisionAlias,
							requestAlias: input.requestAlias,
							status: "active",
							candidateRevisionAlias:
								candidate.revisionAlias,
						},
						[candidateContext!],
					),
				);
				await assertCurrentSource(sourceRecord);
				await deps.bindings.put(
					bindingScope(candidateContext),
					captured.bindings,
				);
				await deps.store.putRevision(candidate, {
					expiresAt: deps.now() + DRAFT_RETENTION_MS,
				});
				const unchanged =
					captured.comparisonFingerprint?.digest ===
					(comparisonAuthority?.fingerprint.digest ??
						source.inventoryFingerprint.digest);
				const desiredState =
					unchanged && source.state === "approved"
						? "approved" as const
						: unchanged && source.state === "in_flight"
							? "in_flight" as const
							: "draft" as const;
				if (desiredState !== "draft") {
					await assertCurrentSource(sourceRecord);
					await deps.execution.prepareRestart({
						sourcePlanAlias: source.planAlias,
						sourceRevisionAlias: source.revisionAlias,
						revision: candidate,
						checkpoints,
						...(priorAliasMap === undefined
							? {}
							: {
									priorToFreshAliases:
										priorAliasMap as Readonly<
											Record<string, string>
										>,
								}),
					});
				}
				await mutateRegistry((registry) =>
					updateRestart(registry, input, {
						planAlias: input.planAlias,
						revisionAlias: input.revisionAlias,
						requestAlias: input.requestAlias,
						status: "active",
						candidateRevisionAlias: candidate.revisionAlias,
						desiredState,
					}),
				);
				await assertCurrentSource(sourceRecord);
				await transitionCandidate(
					input.planAlias,
					candidate.revisionAlias,
					desiredState,
				);
				await assertCurrentSource(sourceRecord);
				await mutateRegistry((registry) =>
					updateRestart(registry, input, {
						planAlias: input.planAlias,
						revisionAlias: input.revisionAlias,
						requestAlias: input.requestAlias,
						status: "completed",
						candidateRevisionAlias: candidate.revisionAlias,
						desiredState,
					}),
				);
				return completed(
					input,
					candidate.revisionAlias,
					desiredState,
					desiredState !== "draft",
				);
			} catch (error) {
				const canceled = signal?.aborted === true;
				const interrupted =
					error instanceof MailboxPlanListError &&
					error.code === "conflict";
				if (!interrupted) {
					await failRestart(
						input,
						input.requestAlias,
						canceled
							? "interrupted_restart"
							: "storage_failure",
					);
				}
				return canceled
					? Object.freeze({
							schemaVersion: 1,
							status: "canceled",
							requestAlias: input.requestAlias,
							action: input.type,
						})
					: blocked(
							input,
							interrupted
								? "interrupted_restart"
								: "storage_failure",
						);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		});

	const list = async (
		request?: MailboxPlanListQuery,
	): Promise<MailboxPlanListResult> => {
		const safeQuery = query(request);
		const reconciled = await deps.lifecycle.reconcileAll();
		const activePlans = new Set(
			reconciled.map((plan) => plan.planAlias),
		);
		const plans = await deps.store.listPlans();
		const stored = await readRegistry();
		const contextByRevision = new Map(
			stored.registry.contexts.map((item) => [
				identity(item.planAlias, item.revisionAlias),
				item,
			]),
		);
		const checkByRevision = new Map(
			stored.registry.checks.map((item) => [
				identity(item.planAlias, item.revisionAlias),
				item,
			]),
		);
		const restartByRevision = new Map(
			stored.registry.restarts.map((item) => [
				identity(item.planAlias, item.revisionAlias),
				item,
			]),
		);
		const rows: MailboxPlanListRow[] = [];
		for (const plan of plans) {
			if (!activePlans.has(plan.planAlias)) continue;
			for (const record of plan.revisions) {
				const revision = validateMailboxPlanRevision(record.revision);
				if (
					revision.state === "canceled" ||
					![
						"draft",
						"approved",
						"in_flight",
						"completed",
					].includes(revision.state) ||
					deps.now() >= record.expiresAt
				) {
					continue;
				}
				const key = identity(plan.planAlias, revision.revisionAlias);
				const bindingContext = contextByRevision.get(key);
				const restart = restartByRevision.get(key);
				const checked = checkByRevision.get(key);
				if (restart?.status === "completed") continue;
				let stale = false;
				let staleReason: MailboxPlanStaleReason = "none";
				let executionStatus: "live" | "resumable" | "missing" =
					"missing";
				if (stored.corrupt || bindingContext === undefined) {
					stale = true;
					staleReason = "storage_failure";
				} else if (
					restart?.status === "fencing" ||
					restart?.status === "active" ||
					restart?.status === "failed"
				) {
					stale = true;
					staleReason =
						restart.reason ?? "interrupted_restart";
				} else if (revision.restartRequired) {
					stale = true;
					staleReason = "restart_required";
				} else if (revision.state !== "completed") {
					let status;
					try {
						status = await deps.bindings.status(
							bindingScope(bindingContext),
						);
					} catch {
						status = {
							available: false as const,
							reason: "storage_failure" as const,
						};
					}
					if (deps.now() >= record.expiresAt) continue;
					if (!status.available) {
						stale = true;
						staleReason =
							status.reason === "corrupt" ||
							status.reason === "storage_failure"
								? "storage_failure"
								: "missing_session";
					}
					if (
						!stale &&
						revision.state === "in_flight"
					) {
						try {
							executionStatus = await deps.execution.status(
								revision.planAlias,
								revision.revisionAlias,
							);
						} catch {
							executionStatus = "missing";
						}
						if (executionStatus === "missing") {
							stale = true;
							staleReason = "missing_session";
						}
					}
					if (
						!stale &&
						(revision.state === "approved" ||
							revision.state === "in_flight")
					) {
						if (checked?.status === "failed") {
							stale = true;
							staleReason =
								checked.reason ??
								"preflight_failed";
						} else if (checked?.status !== "ready") {
							staleReason = "check_required";
						}
					}
				}
				if (deps.now() >= record.expiresAt) continue;
				const nextAction =
					revision.state === "completed"
						? Object.freeze({ type: "view" as const })
						: stale
							? Object.freeze({
									type: "restart" as const,
								})
							: revision.state === "draft"
								? Object.freeze({
										type: "edit" as const,
									})
								: revision.state === "approved"
									? Object.freeze({
											type: "preflight" as const,
										})
									: Object.freeze({
											type:
												executionStatus === "live"
													? "focus" as const
													: "resume" as const,
										});
				rows.push(Object.freeze({
					schemaVersion: 1,
					planAlias: revision.planAlias,
					revisionAlias: revision.revisionAlias,
					providerId:
						bindingContext?.providerId ?? "unavailable",
					surface: bindingContext?.surface ?? "unavailable",
					accountAlias:
						bindingContext?.accountAlias ?? null,
					lifecycleState: revision.state,
					stale,
					staleReason,
					updatedAt: revision.createdAt,
					expiresAt: new Date(
						Math.min(record.expiresAt, MAX_DISPLAY_EXPIRY_MS),
					).toISOString(),
					nextAction,
				}));
			}
		}
		const filtered = rows
			.filter((row) =>
				safeQuery.states === undefined
					? true
					: safeQuery.states.includes(row.lifecycleState),
			)
			.filter((row) =>
				safeQuery.stale === "only"
					? row.stale
					: safeQuery.stale === "exclude"
						? !row.stale
						: true,
			)
			.filter(
				(row) =>
					safeQuery.providerId === undefined ||
					row.providerId === safeQuery.providerId,
			)
			.filter(
				(row) =>
					safeQuery.surface === undefined ||
					row.surface === safeQuery.surface,
			)
			.filter(
				(row) =>
					safeQuery.accountAlias === undefined ||
					row.accountAlias === safeQuery.accountAlias,
			)
			.sort((left, right) => {
				const updated =
					Date.parse(right.updatedAt) -
					Date.parse(left.updatedAt);
				if (updated !== 0) return updated;
				const planOrder =
					left.planAlias.localeCompare(right.planAlias);
				return planOrder !== 0
					? planOrder
					: left.revisionAlias.localeCompare(
							right.revisionAlias,
						);
			});
		return Object.freeze({
			schemaVersion: 1,
			rows: Object.freeze(filtered.slice(0, MAX_ROWS)),
		});
	};

	const performInternal = async (
		input: MailboxPlanListCommand,
		signal?: AbortSignal,
	): Promise<MailboxPlanListActionResult> => {
		const requestRecord = await deps.store.getRecord(
			input.planAlias,
			input.revisionAlias,
		);
		if (
			requestRecord === undefined ||
			deps.now() >= requestRecord.expiresAt
		) {
			fail("not_found");
		}
		await mutateRegistry((registry) => {
			const activeRequests = registry.requests.filter(
				(item) => deps.now() < item.expiresAt,
			);
			if (
				activeRequests.some(
					(item) => item.requestAlias === input.requestAlias,
				)
			) {
				fail("replay");
			}
			if (
				activeRequests.filter(
					(item) => item.planAlias === input.planAlias,
				).length >= MAX_REQUESTS_PER_PLAN
			) {
				fail("conflict");
			}
			return {
				...registry,
				requests: Object.freeze([
					...activeRequests,
					{
						planAlias: input.planAlias,
						revisionAlias: input.revisionAlias,
						requestAlias: input.requestAlias,
						expiresAt: requestRecord.expiresAt,
					},
				]),
			};
		});
		const row = (await list()).rows.find(
			(candidate) =>
				candidate.planAlias === input.planAlias &&
				candidate.revisionAlias === input.revisionAlias,
		);
		if (row === undefined) fail("not_found");
		if (input.type === "edit" && row.nextAction.type === "edit") {
			await deps.navigation.edit(input.planAlias, input.revisionAlias);
			return completed(input, input.revisionAlias, "draft");
		}
		if (
			input.type === "preflight" &&
			row.nextAction.type === "preflight"
		) {
			const preflight = await deps.navigation.preflight(
				input.planAlias,
				input.revisionAlias,
			);
			const ready =
				preflight === "ready" ||
				(typeof preflight === "object" &&
					preflight.status === "ready" &&
					preflight.fingerprintMatches);
			const failureReason =
				!ready &&
				typeof preflight === "object" &&
				preflight.status === "blocked"
					? preflight.reason
					: "preflight_failed";
			await mutateRegistry((registry) => ({
				...registry,
				checks: Object.freeze([
					...registry.checks.filter(
						(item) =>
							identity(
								item.planAlias,
								item.revisionAlias,
							) !==
							identity(
								input.planAlias,
								input.revisionAlias,
							),
					),
					{
						planAlias: input.planAlias,
						revisionAlias: input.revisionAlias,
						status: ready ? "ready" as const : "failed" as const,
						...(ready
							? {}
							: {
									reason:
										failureReason,
								}),
					},
				]),
			}));
			if (!ready) {
				return Object.freeze({
					schemaVersion: 1,
					status: "blocked",
					requestAlias: input.requestAlias,
					action: input.type,
					reason:
						failureReason,
				});
			}
			return completed(input, input.revisionAlias, "approved", true);
		}
		if (input.type === "focus" && row.nextAction.type === "focus") {
			await deps.execution.focus(input.planAlias, input.revisionAlias);
			return completed(input, input.revisionAlias, "in_flight", true);
		}
		if (input.type === "resume" && row.nextAction.type === "resume") {
			const outcome = await deps.execution.resume(
				input.planAlias,
				input.revisionAlias,
				signal,
			);
			if (outcome !== undefined && outcome !== "completed") {
				return blocked(input, outcome);
			}
			return completed(input, input.revisionAlias, "in_flight", true);
		}
		if (input.type === "restart" && row.nextAction.type === "restart") {
			return restart(input, signal);
		}
		fail("invalid_action");
	};

	return Object.freeze({
		async register(value, bindingContext) {
			const revision = validateMailboxPlanRevision(value);
			const safeContext = context(bindingContext);
			if (
				revision.planAlias !== safeContext.planAlias ||
				revision.revisionAlias !== safeContext.revisionAlias
			) {
				fail("invalid_input");
			}
			await mutateRegistry((registry) => {
				const key = identity(
					revision.planAlias,
					revision.revisionAlias,
				);
				const current = registry.contexts.find(
					(item) =>
						identity(item.planAlias, item.revisionAlias) === key,
				);
				if (
					current !== undefined &&
					JSON.stringify(current) !== JSON.stringify(safeContext)
				) {
					fail("conflict");
				}
				return current === undefined
					? {
							...registry,
							contexts: Object.freeze([
								...registry.contexts,
								safeContext,
							]),
						}
					: registry;
			});
		},
		list,
		perform(value, options) {
			const safe = command(value);
			const current = activeRequests.get(safe.requestAlias);
			if (current !== undefined) return current;
			const running = performInternal(safe, options?.signal).finally(() => {
				activeRequests.delete(safe.requestAlias);
			});
			activeRequests.set(safe.requestAlias, running);
			return running;
		},
		async recoverRestarts() {
			const stored = await readRegistry();
			if (stored.corrupt) return Object.freeze([]);
			const results: import("./contracts").MailboxPlanRestartRecoveryResult[] =
				[];
			for (const active of stored.registry.restarts.filter(
				(item) =>
					item.status === "active" ||
					item.status === "fencing",
			)) {
				await serialized(active.planAlias, async () => {
					const latest = await readRegistry();
					const restartState = latest.registry.restarts.find(
						(item) =>
							item.planAlias === active.planAlias &&
							item.revisionAlias === active.revisionAlias,
					);
					if (
						restartState?.status !== "active" &&
						restartState?.status !== "fencing"
					) return;
					const candidateContext =
						restartState.candidateRevisionAlias === undefined
							? undefined
							: latest.registry.contexts.find(
									(item) =>
										item.planAlias === active.planAlias &&
										item.revisionAlias ===
											restartState.candidateRevisionAlias,
								);
					let recoverable = false;
					await deps.bindings
						.invalidateRevision(
							active.planAlias,
							active.revisionAlias,
							"restart_required",
						)
						.catch(() => undefined);
					const source = await deps.store.getRecord(
						active.planAlias,
						active.revisionAlias,
					);
					if (
						source === undefined ||
						deps.now() >= source.expiresAt
					) {
						recoverable = false;
					}
					if (
						source !== undefined &&
						deps.now() < source.expiresAt &&
						candidateContext !== undefined &&
						restartState.desiredState !== undefined
					) {
						try {
							const candidate = await deps.store.getRecord(
								active.planAlias,
								candidateContext.revisionAlias,
							);
							const status = await deps.bindings.status(
								bindingScope(candidateContext),
							);
							recoverable =
								candidate !== undefined &&
								deps.now() < candidate.expiresAt &&
								status.available;
							if (recoverable) {
								const latestSource = await deps.store.getRecord(
									active.planAlias,
									active.revisionAlias,
								);
								if (
									latestSource === undefined ||
									deps.now() >= latestSource.expiresAt ||
									JSON.stringify(latestSource) !==
										JSON.stringify(source)
								) {
									fail("storage_failure");
								}
								await transitionCandidate(
									active.planAlias,
									candidateContext.revisionAlias,
									restartState.desiredState,
								);
								const commitSource = await deps.store.getRecord(
									active.planAlias,
									active.revisionAlias,
								);
								if (
									commitSource === undefined ||
									deps.now() >= commitSource.expiresAt ||
									JSON.stringify(commitSource) !==
										JSON.stringify(source)
								) {
									fail("storage_failure");
								}
								await mutateRegistry((registry) =>
									updateRestart(registry, active, {
										...restartState,
										status: "completed",
									}),
								);
								results.push(Object.freeze({
									schemaVersion: 1,
									planAlias: active.planAlias,
									revisionAlias: active.revisionAlias,
									status: "recovered",
									candidateRevisionAlias:
										candidateContext.revisionAlias,
								}));
							}
						} catch {
							recoverable = false;
						}
					}
					if (recoverable) return;
					if (candidateContext !== undefined) {
						await deps.bindings
							.invalidateRevision(
								active.planAlias,
								candidateContext.revisionAlias,
								"restart_required",
							)
							.catch(() => undefined);
					}
					await mutateRegistry((registry) =>
						updateRestart(registry, active, {
							planAlias: active.planAlias,
							revisionAlias: active.revisionAlias,
							requestAlias: active.requestAlias,
							status: "failed",
							reason: "interrupted_restart",
							...(restartState.candidateRevisionAlias === undefined
								? {}
								: {
										candidateRevisionAlias:
											restartState.candidateRevisionAlias,
									}),
						}),
					);
					results.push(Object.freeze({
						schemaVersion: 1,
						planAlias: active.planAlias,
						revisionAlias: active.revisionAlias,
						status: "blocked",
						...(restartState.candidateRevisionAlias === undefined
							? {}
							: {
									candidateRevisionAlias:
										restartState.candidateRevisionAlias,
								}),
					}));
				});
			}
			return Object.freeze(results);
		},
		async hasActiveRestart(planAlias, revisionAlias) {
			const stored = await readRegistry();
			if (stored.corrupt) return true;
			return stored.registry.restarts.some(
				(item) =>
					item.planAlias === planAlias &&
					(item.revisionAlias === revisionAlias ||
						item.candidateRevisionAlias === revisionAlias) &&
					(item.status === "fencing" ||
						item.status === "active"),
			);
		},
		async acquireExecutionAdmission(planAlias, revisionAlias, owner) {
			await mutateRegistry((registry) => {
				const admissions = registry.admissions.filter(
					(item) => deps.now() < item.expiresAt,
				);
				const blockedByRestart = registry.restarts.some(
					(item) =>
						(item.revisionAlias === revisionAlias
							? item.planAlias === planAlias
							: item.planAlias === planAlias &&
								item.candidateRevisionAlias === revisionAlias &&
								item.status !== "completed"),
				);
				if (blockedByRestart) fail("conflict");
				const current = admissions.find(
					(item) =>
						item.planAlias === planAlias &&
						item.revisionAlias === revisionAlias,
				);
				if (current !== undefined) fail("conflict");
				return {
					...registry,
					admissions: Object.freeze([
						...admissions.filter(
							(item) =>
								item.planAlias !== planAlias ||
								item.revisionAlias !== revisionAlias,
						),
						{
							planAlias,
							revisionAlias,
							owner,
							expiresAt: deps.now() + ADMISSION_TTL_MS,
						},
					]),
				};
			});
		},
		async assertExecutionAdmission(planAlias, revisionAlias, owner) {
			await mutateRegistry((registry) => {
				const current = registry.admissions.find(
					(item) =>
						item.planAlias === planAlias &&
						item.revisionAlias === revisionAlias &&
						item.owner === owner &&
						deps.now() < item.expiresAt,
				);
				const fenced = registry.restarts.some(
					(item) =>
						item.planAlias === planAlias &&
						(item.revisionAlias === revisionAlias ||
							(item.candidateRevisionAlias === revisionAlias &&
								item.status !== "completed")),
				);
				if (current === undefined || fenced) fail("conflict");
				return {
					...registry,
					admissions: Object.freeze([
						...registry.admissions.filter(
							(item) => item !== current,
						),
						{
							...current,
							expiresAt: deps.now() + ADMISSION_TTL_MS,
						},
					]),
				};
			});
		},
		async releaseExecutionAdmission(planAlias, revisionAlias, owner) {
			await mutateRegistry((registry) => {
				const current = registry.admissions.find(
					(item) =>
						item.planAlias === planAlias &&
						item.revisionAlias === revisionAlias,
				);
				if (current === undefined) return registry;
				if (current.owner !== owner) fail("conflict");
				return {
					...registry,
					admissions: Object.freeze(
						registry.admissions.filter(
							(item) => item !== current,
						),
					),
				};
			});
		},
		waitForExecutionDrain,
	});
}
