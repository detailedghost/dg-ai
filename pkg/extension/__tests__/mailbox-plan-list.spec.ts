import {
	type MailboxPlanRevision,
	validateMailboxPlanRevision,
} from "@dg/common";
import { describe, expect, it } from "bun:test";
import {
	createMailboxPlanListService,
	type MailboxPlanBindingContext,
	type MailboxPlanListService,
	type MailboxPlanListServiceDeps,
	type MailboxPlanListState,
	type MailboxPlanRestartCapture,
	type MailboxPlanRestartCheckpoint,
} from "../lib/features/mailbox-cleanup/plan-workspace/list";
import type {
	MailboxRevisionRecord,
	MailboxStoredPlan,
	RawBindingStatus,
} from "../lib/features/mailbox-cleanup/storage";
import { createSessionAliasRegistry } from "../lib/features/mailbox-cleanup/privacy";
import { fingerprint, NOW_MS } from "./mailbox-plan-page-fixtures";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const RAW_SENTINEL = "raw-provider-message:alice@example.test";

function opaqueAlias(
	prefix:
		| "plan"
		| "rev"
		| "acct"
		| "run"
		| "act"
		| "msg"
		| "req"
		| "exec",
	seed: number,
): string {
	return `${prefix}_${seed.toString(16).padStart(32, "0")}`;
}

type BuiltPlan = Readonly<{
	revision: MailboxPlanRevision;
	context: MailboxPlanBindingContext;
	messageAlias: string;
}>;

type PlanFactory = Readonly<{
	make(
		state: MailboxPlanListState,
		overrides?: Partial<MailboxPlanRevision>,
		actionCount?: number,
	): BuiltPlan;
}>;

const planContexts = new WeakMap<
	MailboxPlanRevision,
	MailboxPlanBindingContext
>();
const planFactories = new WeakMap<MailboxPlanRevision, PlanFactory>();

function planFactory(seed: number): PlanFactory {
	let entropyIndex = 0;
	let revisionNumber = 0;
	let planAlias: string | undefined;
	const registry = createSessionAliasRegistry({
		randomBytes: () => {
			entropyIndex += 1;
			return Uint8Array.from(
				{ length: 16 },
				(_unused, index) =>
					(seed * 37 + entropyIndex * 29 + index * 13) % 256,
			);
		},
	});
	const providerId = "fake-mail";
	const surface = "inbox";
	const accountScope = { providerId, surface };
	const accountAlias = registry.bind(
		accountScope,
		"account",
		`account-${seed}`,
	);

	const factory: PlanFactory = {
		make(state, overrides = {}, actionCount = 1) {
			revisionNumber += 1;
			const runScope = { ...accountScope, accountAlias };
			const runAlias = registry.bind(
				runScope,
				"run",
				`run-${seed}-${revisionNumber}`,
			);
			const revisionScope = { ...runScope, runAlias };
			const revisionAlias = registry.bind(
				revisionScope,
				"revision",
				`revision-${seed}-${revisionNumber}`,
			);
			const scope = { ...revisionScope, revisionAlias };
			const actionFixtures = Array.from(
				{ length: actionCount },
				(_unused, index) => ({
					messageAlias: registry.bind(
						scope,
						"message",
						`message-${seed}-${revisionNumber}-${index}`,
					),
					actionAlias: registry.bind(
						scope,
						"action",
						`action-${seed}-${revisionNumber}-${index}`,
					),
				}),
			);
			const messageAlias = actionFixtures[0]?.messageAlias;
			if (messageAlias === undefined) {
				throw new Error("Exact plan fixture needs at least one action");
			}
			const cohortKey = `cohort-${seed}-${revisionNumber}`;
			planAlias ??= registry.bind(scope, "plan", `plan-${seed}`);
			const actions =
				state === "draft"
					? actionFixtures.map(({ messageAlias: alias }) => ({
							type: "archive" as const,
							messageAlias: alias,
						}))
					: actionFixtures.map(
							({ actionAlias, messageAlias: alias }) => ({
								schemaVersion: 1 as const,
								actionAlias,
								type: "archive" as const,
								messageAlias: alias,
							}),
						);
			const value = validateMailboxPlanRevision({
				schemaVersion: 1,
				state,
				restartRequired: false,
				createdAt: new Date(
					NOW_MS + seed * 1_000 + revisionNumber,
				).toISOString(),
				inventoryFingerprint: fingerprint(),
				cohorts: [
					{
						schemaVersion: 1,
						cohortKey,
						category: "other",
						ageBucket: "recent",
						messageAliases: actionFixtures.map(
							(item) => item.messageAlias,
						),
						suggestedActions: [],
					},
				],
				targets: {
					folderAliases: [],
					labelAliases: [],
					filterAliases: [],
				},
				actions,
				...overrides,
				planAlias,
				revisionAlias,
				revisionNumber,
			});
			const bindingContext: MailboxPlanBindingContext = {
				schemaVersion: 1,
				planAlias,
				revisionAlias,
				providerId,
				surface,
				accountAlias,
				runAlias,
			};
			planContexts.set(value, bindingContext);
			planFactories.set(value, factory);
			return { revision: value, context: bindingContext, messageAlias };
		},
	};
	return factory;
}

function revision(
	seed: number,
	state: MailboxPlanListState,
	overrides: Partial<MailboxPlanRevision> = {},
): MailboxPlanRevision {
	return planFactory(seed).make(state, overrides).revision;
}

function context(
	value: MailboxPlanRevision,
	_seed: number,
): MailboxPlanBindingContext {
	const result = planContexts.get(value);
	if (result === undefined) throw new Error("Missing exact plan fixture context");
	return result;
}

function restartCapture(
	source: MailboxPlanRevision,
	seed: number,
	options: Readonly<{
		fingerprintSeed?: string;
		sameAccount?: boolean;
		preflight?: "ready" | "blocked";
	}> = {},
): MailboxPlanRestartCapture {
	const inventoryFingerprint = fingerprint(options.fingerprintSeed ?? "a");
	const factory = planFactories.get(source);
	if (factory === undefined) throw new Error("Missing exact restart fixture");
	const candidate = factory.make("draft", {
		restartRequired: false,
		createdAt: new Date(NOW_MS + seed * 1_000).toISOString(),
		inventoryFingerprint,
	});
	return {
		schemaVersion: 1,
		comparisonFingerprint: inventoryFingerprint,
		revision: candidate.revision,
		context: candidate.context,
		bindings: {
			[candidate.messageAlias]: `${RAW_SENTINEL}:${seed}`,
		},
		proof: {
			sameAccount: options.sameAccount ?? true,
			locale: "en-US",
			layout: "supported",
			preflight: options.preflight ?? "ready",
		},
	};
}

type Seed = Readonly<{
	revision: MailboxPlanRevision;
	context: MailboxPlanBindingContext;
	expiresAt: number;
	bindingStatus?: RawBindingStatus;
	executionStatus?: "live" | "resumable" | "missing";
	bindings?: Readonly<Record<string, string>>;
}>;

function harness(initial: readonly Seed[] = []) {
	let now = NOW_MS;
	const records = new Map<string, MailboxRevisionRecord>();
	const bindingStatuses = new Map<string, RawBindingStatus>();
	const rawBindings = new Map<string, Readonly<Record<string, string>>>();
	const executionStatuses = new Map<
		string,
		"live" | "resumable" | "missing"
	>();
	const atomic = new Map<
		string,
		Readonly<{ version: number; value: unknown }>
	>();
	const checkpoints = new Map<
		string,
		readonly MailboxPlanRestartCheckpoint[]
	>();
	const events: string[] = [];
	const rescans: Parameters<MailboxPlanListServiceDeps["rescan"]>[0][] = [];
	const prepared: Parameters<
		MailboxPlanListServiceDeps["execution"]["prepareRestart"]
	>[0][] = [];
	let capture: MailboxPlanRestartCapture | undefined;
	let statusHook: (() => void) | undefined;
	let preflightResult: Awaited<
		ReturnType<MailboxPlanListServiceDeps["navigation"]["preflight"]>
	> = "ready";
	let rescanRunner:
		| MailboxPlanListServiceDeps["rescan"]
		| undefined;
	let invalidateRevisionRunner:
		| ((
				planAlias: string,
				revisionAlias: string,
				commit: () => Promise<{
					planAlias: string;
					revisionAlias: string;
				}>,
		  ) => Promise<{ planAlias: string; revisionAlias: string }>)
		| undefined;
	let transitionRunner:
		| MailboxPlanListServiceDeps["lifecycle"]["transition"]
		| undefined;
	let casRunner:
		| ((
				storageKey: string,
				expectedVersion: number | undefined,
				value: unknown,
				commit: () => boolean,
		  ) => Promise<boolean>)
		| undefined;
	let resumeOutcome: Awaited<
		ReturnType<MailboxPlanListServiceDeps["execution"]["resume"]>
	> = "completed";

	const key = (planAlias: string, revisionAlias: string) =>
		`${planAlias}:${revisionAlias}`;
	const requireRawScope = (scope: object) => {
		const keys = Object.keys(scope).sort();
		if (
			JSON.stringify(keys) !==
			JSON.stringify([
				"accountAlias",
				"planAlias",
				"providerId",
				"revisionAlias",
				"runAlias",
				"surface",
			])
		) {
			throw new Error("Expected exact raw-binding scope");
		}
	};
	const add = (seed: Seed) => {
		records.set(key(seed.revision.planAlias, seed.revision.revisionAlias), {
			schemaVersion: 1,
			key: key(seed.revision.planAlias, seed.revision.revisionAlias),
			planAlias: seed.revision.planAlias,
			revisionAlias: seed.revision.revisionAlias,
			revision: seed.revision,
			expiresAt: seed.expiresAt,
		});
		bindingStatuses.set(
			key(seed.revision.planAlias, seed.revision.revisionAlias),
			seed.bindingStatus ?? {
				available: true,
				expiresAt: now + HOUR_MS,
			},
		);
		rawBindings.set(
			key(seed.revision.planAlias, seed.revision.revisionAlias),
			seed.bindings ?? { [opaqueAlias("msg", 100)]: RAW_SENTINEL },
		);
		executionStatuses.set(
			key(seed.revision.planAlias, seed.revision.revisionAlias),
			seed.executionStatus ?? "missing",
		);
	};
	for (const seed of initial) add(seed);

	const plans = (): readonly MailboxStoredPlan[] => {
		const grouped = new Map<string, MailboxRevisionRecord[]>();
		for (const record of records.values()) {
			const revisions = grouped.get(record.planAlias) ?? [];
			revisions.push(record);
			grouped.set(record.planAlias, revisions);
		}
		return [...grouped].map(([planAlias, revisions]) => ({
			schemaVersion: 1,
			planAlias,
			revisions,
		}));
	};

	const deps: MailboxPlanListServiceDeps = {
		store: {
			async getRecord(planAlias, revisionAlias) {
				return records.get(key(planAlias, revisionAlias));
			},
			async putRevision(value, options) {
				const safe = value as MailboxPlanRevision;
				if (capture === undefined) {
					throw new Error("Missing scripted capture context");
				}
				add({
					revision: safe,
					context: capture.context,
					expiresAt: options?.expiresAt ?? now + DAY_MS,
				});
				events.push(`put:${safe.revisionAlias}`);
				return safe;
			},
			async listPlans() {
				return plans();
			},
		},
		lifecycle: {
			async reconcileAll() {
				return plans().map((plan) => ({
					schemaVersion: 1,
					planAlias: plan.planAlias,
					revisions: plan.revisions.map((record) => record.revision),
				}));
			},
			async transition(change) {
				if (transitionRunner !== undefined) {
					return transitionRunner(change);
				}
				const record = records.get(
					key(change.planAlias, change.revisionAlias),
				);
				if (record === undefined) throw new Error("missing revision");
				const next = {
					...record.revision,
					state: change.nextState,
				} as MailboxPlanRevision;
				records.set(key(change.planAlias, change.revisionAlias), {
					...record,
					revision: next,
				});
				return next;
			},
		},
		bindings: {
			async get(scope) {
				requireRawScope(scope);
				return rawBindings.get(key(scope.planAlias, scope.revisionAlias));
			},
			async put(scope, value) {
				requireRawScope(scope);
				events.push(`bind:${scope.revisionAlias}`);
				rawBindings.set(key(scope.planAlias, scope.revisionAlias), value);
				bindingStatuses.set(key(scope.planAlias, scope.revisionAlias), {
					available: true,
					expiresAt: now + HOUR_MS,
				});
			},
			async status(scope) {
				requireRawScope(scope);
				statusHook?.();
				return (
					bindingStatuses.get(key(scope.planAlias, scope.revisionAlias)) ?? {
						available: false,
						reason: "missing",
					}
				);
			},
			async invalidate(scope) {
				requireRawScope(scope);
				events.push(`invalidate:${scope.revisionAlias}`);
			},
			async invalidateRevision(planAlias, revisionAlias) {
				const commit = async () => {
					events.push(`invalidate-revision:${revisionAlias}`);
					rawBindings.delete(key(planAlias, revisionAlias));
					bindingStatuses.set(key(planAlias, revisionAlias), {
						available: false,
						reason: "invalidated",
					});
					return { planAlias, revisionAlias };
				};
				return invalidateRevisionRunner === undefined
					? commit()
					: invalidateRevisionRunner(
							planAlias,
							revisionAlias,
							commit,
						);
			},
		},
		storage: {
			async read(storageKey) {
				return atomic.get(storageKey);
			},
			async compareAndSet(storageKey, expectedVersion, value) {
				const commit = () => {
					const current = atomic.get(storageKey);
					if (current?.version !== expectedVersion) return false;
					atomic.set(storageKey, {
						version: (current?.version ?? 0) + 1,
						value: structuredClone(value),
					});
					return true;
				};
				if (casRunner !== undefined) {
					return casRunner(
						storageKey,
						expectedVersion,
						value,
						commit,
					);
				}
				return commit();
			},
		},
		execution: {
			async status(planAlias, revisionAlias) {
				return (
					executionStatuses.get(key(planAlias, revisionAlias)) ?? "missing"
				);
			},
			async focus(planAlias, revisionAlias) {
				events.push(`focus:${key(planAlias, revisionAlias)}`);
			},
			async resume(planAlias, revisionAlias) {
				events.push(`resume:${key(planAlias, revisionAlias)}`);
				return resumeOutcome;
			},
			async checkpoints(planAlias, revisionAlias) {
				return checkpoints.get(key(planAlias, revisionAlias)) ?? [];
			},
			async restartAuthority(planAlias, revisionAlias) {
				const record = records.get(key(planAlias, revisionAlias));
				if (record === undefined) {
					throw new Error("Missing restart authority revision");
				}
				return {
					fingerprint: record.revision.inventoryFingerprint,
					scope: {
						schemaVersion: 1,
						actionAliases: record.revision.actions.flatMap((action) =>
							"actionAlias" in action &&
							typeof action.actionAlias === "string"
								? [action.actionAlias]
								: [],
						),
						targets: record.revision.targets,
					},
				};
			},
			async prepareRestart(input) {
				prepared.push(structuredClone(input));
				events.push(`prepare:${input.revision.revisionAlias}`);
			},
		},
		navigation: {
			async edit(planAlias, revisionAlias) {
				events.push(`edit:${key(planAlias, revisionAlias)}`);
			},
			async preflight(planAlias, revisionAlias) {
				events.push(`preflight:${key(planAlias, revisionAlias)}`);
				return preflightResult;
			},
		},
		async rescan(input) {
			rescans.push(input);
			if (rescanRunner !== undefined) return rescanRunner(input);
			if (capture === undefined) throw new Error("missing scripted capture");
			return capture;
		},
		now: () => now,
		randomBytes: (size) => new Uint8Array(size).fill(7),
		restartTimeoutMs: 100,
	};

	const service = createMailboxPlanListService(deps);
	return {
		service,
		events,
		prepared,
		rescans,
		records,
		setNow(value: number) {
			now = value;
		},
		onStatus(value: () => void) {
			statusHook = value;
		},
		setCapture(value: MailboxPlanRestartCapture) {
			capture = value;
		},
		setPreflight(
			value: Awaited<
				ReturnType<
					MailboxPlanListServiceDeps["navigation"]["preflight"]
				>
			>,
		) {
			preflightResult = value;
		},
		setRescan(value: MailboxPlanListServiceDeps["rescan"]) {
			rescanRunner = value;
		},
		setInvalidateRevision(
			value: (
				planAlias: string,
				revisionAlias: string,
				commit: () => Promise<{
					planAlias: string;
					revisionAlias: string;
				}>,
			) => Promise<{ planAlias: string; revisionAlias: string }>,
		) {
			invalidateRevisionRunner = value;
		},
		setTransition(
			value: MailboxPlanListServiceDeps["lifecycle"]["transition"],
		) {
			transitionRunner = value;
		},
		setCas(
			value: (
				storageKey: string,
				expectedVersion: number | undefined,
				next: unknown,
				commit: () => boolean,
			) => Promise<boolean>,
		) {
			casRunner = value;
		},
		setResumeOutcome(
			value: Awaited<
				ReturnType<
					MailboxPlanListServiceDeps["execution"]["resume"]
				>
			>,
		) {
			resumeOutcome = value;
		},
		seedRequestTombstones(
			value: readonly Readonly<{
				planAlias: string;
				revisionAlias: string;
				requestAlias: string;
				expiresAt: number;
			}>[],
		) {
			const storageKey = "dg:mailbox-plan-list:v1";
			const current = atomic.get(storageKey);
			if (
				current === undefined ||
				current.value === null ||
				typeof current.value !== "object" ||
				Array.isArray(current.value)
			) {
				throw new Error("Missing plan-list registry fixture");
			}
			atomic.set(storageKey, {
				version: current.version + 1,
				value: {
					...(current.value as Record<string, unknown>),
					requests: structuredClone(value),
				},
			});
		},
		createService() {
			return createMailboxPlanListService(deps);
		},
		setCheckpoints(
			planAlias: string,
			revisionAlias: string,
			value: readonly MailboxPlanRestartCheckpoint[],
		) {
			checkpoints.set(key(planAlias, revisionAlias), value);
		},
	};
}

async function registerAll(service: MailboxPlanListService, seeds: readonly Seed[]) {
	for (const seed of seeds) {
		await service.register(seed.revision, seed.context);
	}
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for plan-list test state");
}

describe("createMailboxPlanListService", () => {
	it("composes every lifecycle filter with stale overlap and keeps Completed visible only until exact expiry", async () => {
		const states = [
			"draft",
			"approved",
			"in_flight",
			"completed",
		] as const;
		const seeds = states.map((state, index): Seed => {
			const value = revision(index + 1, state, {
				restartRequired: state === "draft" && index === 0,
			});
			return {
				revision: value,
				context: context(value, index + 1),
				expiresAt: NOW_MS + (index + 1) * HOUR_MS,
				executionStatus: state === "in_flight" ? "live" : "missing",
			};
		});
		const staleDraft = revision(20, "draft", { restartRequired: true });
		const overlap: Seed = {
			revision: staleDraft,
			context: context(staleDraft, 20),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([...seeds, overlap]);
		await registerAll(test.service, [...seeds, overlap]);

		for (const state of states) {
			const result = await test.service.list({ states: [state] });
			expect(result.rows).not.toHaveLength(0);
			expect(result.rows.every((row) => row.lifecycleState === state)).toBe(
				true,
			);
		}

		const staleDrafts = await test.service.list({
			states: ["draft"],
			stale: "only",
		});
		expect(staleDrafts.rows.map((row) => row.planAlias)).toContain(
			staleDraft.planAlias,
		);
		expect(
			staleDrafts.rows.every(
				(row) => row.lifecycleState === "draft" && row.stale,
			),
		).toBe(true);

		test.setNow(seeds[3]!.expiresAt);
		const completed = await test.service.list({ states: ["completed"] });
		expect(completed.rows).toEqual([]);
	});

	it("sorts updated time descending with plan and revision aliases as deterministic tie-breakers", async () => {
		const sameTime = new Date(NOW_MS + HOUR_MS).toISOString();
		const later = revision(3, "draft", {
			createdAt: new Date(NOW_MS + 2 * HOUR_MS).toISOString(),
		});
		const tiedB = revision(2, "draft", { createdAt: sameTime });
		const tiedFactory = planFactory(1);
		const tiedARevision2 = tiedFactory.make("draft", {
			createdAt: sameTime,
		}).revision;
		const tiedARevision1 = tiedFactory.make("draft", {
			createdAt: sameTime,
		}).revision;
		const values = [
			later,
			tiedB,
			tiedARevision2,
			tiedARevision1,
		].map(
			(value, index): Seed => ({
				revision: value,
				context: context(value, index + 1),
				expiresAt: NOW_MS + DAY_MS,
			}),
		);
		const test = harness(values);
		await registerAll(test.service, values);

		const rows = (await test.service.list({ states: ["draft"] })).rows;
		const tied = [tiedARevision1, tiedARevision2, tiedB].sort(
			(left, right) =>
				left.planAlias.localeCompare(right.planAlias) ||
				left.revisionAlias.localeCompare(right.revisionAlias),
		);
		expect(rows.map((row) => [row.planAlias, row.revisionAlias])).toEqual([
			[later.planAlias, later.revisionAlias],
			...tied.map((value) => [value.planAlias, value.revisionAlias]),
		]);
	});

	it("rechecks logical expiry after an asynchronous session read and never emits raw bindings", async () => {
		const value = revision(1, "approved");
		const expiresAt = NOW_MS + HOUR_MS;
		const seed: Seed = {
			revision: value,
			context: context(value, 1),
			expiresAt,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		test.onStatus(() => test.setNow(expiresAt));

		const result = await test.service.list();
		expect(result.rows).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(RAW_SENTINEL);
	});

	it("returns only typed next actions and routes edit, preflight, focus, resume, restart, and view without state confusion", async () => {
		const draft = revision(1, "draft");
		const approved = revision(2, "approved");
		const live = revision(3, "in_flight");
		const resumable = revision(4, "in_flight");
		const missing = revision(5, "in_flight");
		const completed = revision(6, "completed");
		const values: Seed[] = [
			{ revision: draft, context: context(draft, 1), expiresAt: NOW_MS + DAY_MS },
			{
				revision: approved,
				context: context(approved, 2),
				expiresAt: NOW_MS + DAY_MS,
			},
			{
				revision: live,
				context: context(live, 3),
				expiresAt: NOW_MS + DAY_MS,
				executionStatus: "live",
			},
			{
				revision: resumable,
				context: context(resumable, 4),
				expiresAt: NOW_MS + DAY_MS,
				executionStatus: "resumable",
			},
			{
				revision: missing,
				context: context(missing, 5),
				expiresAt: NOW_MS + DAY_MS,
				executionStatus: "missing",
			},
			{
				revision: completed,
				context: context(completed, 6),
				expiresAt: NOW_MS + DAY_MS,
			},
		];
		const test = harness(values);
		await registerAll(test.service, values);

		const rows = (await test.service.list()).rows;
		const next = new Map(
			rows.map((row) => [row.revisionAlias, row.nextAction.type]),
		);
		expect(next).toEqual(
			new Map([
				[draft.revisionAlias, "edit"],
				[approved.revisionAlias, "preflight"],
				[live.revisionAlias, "focus"],
				[resumable.revisionAlias, "resume"],
				[missing.revisionAlias, "restart"],
				[completed.revisionAlias, "view"],
			]),
		);
		expect(
			rows.every((row) =>
				["edit", "preflight", "focus", "resume", "restart", "view"].includes(
					row.nextAction.type,
				),
			),
		).toBe(true);
	});

	it("preserves Approved only after an unchanged canonical rescan, fresh aliases, and complete account/layout/preflight proof", async () => {
		const source = revision(1, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 1),
			expiresAt: NOW_MS + DAY_MS,
			bindings: {
				[source.cohorts[0]!.messageAliases[0]!]: `${RAW_SENTINEL}:old`,
			},
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const capture = restartCapture(source, 101);
		test.setCapture(capture);

		const result = await test.service.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 1),
		});

		expect(result).toEqual({
			schemaVersion: 1,
			status: "completed",
			requestAlias: opaqueAlias("req", 1),
			action: "restart",
			planAlias: source.planAlias,
			revisionAlias: capture.revision.revisionAlias,
			lifecycleState: "approved",
			preservedApproval: true,
		});
		expect(capture.revision.revisionAlias).not.toBe(source.revisionAlias);
		expect(capture.context.runAlias).not.toBe(seed.context.runAlias);
		expect(Object.keys(capture.bindings)).not.toEqual(
			Object.keys(seed.bindings ?? {}),
		);
		expect(test.events).toContain(
			`invalidate-revision:${source.revisionAlias}`,
		);
		expect(test.events).toContain(`bind:${capture.revision.revisionAlias}`);
		expect(JSON.stringify({ result, events: test.events })).not.toContain(
			RAW_SENTINEL,
		);
	});

	it("creates a new Draft when the canonical rescan changes and never carries accepted authority forward", async () => {
		const source = revision(1, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 1),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const capture = restartCapture(source, 102, { fingerprintSeed: "b" });
		test.setCapture(capture);

		const result = await test.service.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 2),
		});

		expect(result).toMatchObject({
			status: "completed",
			action: "restart",
			revisionAlias: capture.revision.revisionAlias,
			lifecycleState: "draft",
			preservedApproval: false,
		});
		const candidate = test.records.get(
			`${source.planAlias}:${capture.revision.revisionAlias}`,
		);
		expect(candidate?.revision.state).toBe("draft");
		expect(candidate?.revision.restartRequired).toBe(false);
	});

	it("blocks approval preservation when account proof or fresh preflight fails", async () => {
		const cases = [
			{
				seed: 201,
				options: { sameAccount: false },
				reason: "account_mismatch",
			},
			{
				seed: 202,
				options: { preflight: "blocked" as const },
				reason: "preflight_failed",
			},
		] as const;

		for (const testCase of cases) {
			const source = revision(testCase.seed, "approved", {
				restartRequired: true,
			});
			const seed: Seed = {
				revision: source,
				context: context(source, testCase.seed),
				expiresAt: NOW_MS + DAY_MS,
			};
			const test = harness([seed]);
			await registerAll(test.service, [seed]);
			const capture = restartCapture(
				source,
				testCase.seed + 1_000,
				testCase.options,
			);
			test.setCapture(capture);

			const result = await test.service.perform({
				schemaVersion: 1,
				type: "restart",
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias: opaqueAlias("req", testCase.seed),
			});

			expect(result).toMatchObject({
				status: "blocked",
				action: "restart",
				reason: testCase.reason,
			});
			expect(
				test.records.has(
					`${source.planAlias}:${capture.revision.revisionAlias}`,
				),
			).toBe(false);
			expect(test.events).not.toContain(
				`bind:${capture.revision.revisionAlias}`,
			);
		}
	});

	it("preserves stale in-flight checkpoints across restart without focusing, resuming, or repeating verified and ambiguous work", async () => {
		const source = planFactory(1).make(
			"in_flight",
			{ restartRequired: true },
			3,
		).revision;
		const aliases = source.actions.map((action) => {
			if (
				!("actionAlias" in action) ||
				typeof action.actionAlias !== "string"
			) {
				throw new Error("Expected canonical in-flight action");
			}
			return action.actionAlias;
		});
		const seed: Seed = {
			revision: source,
			context: context(source, 1),
			expiresAt: NOW_MS + DAY_MS,
			executionStatus: "resumable",
		};
		const saved = [
			{ actionAlias: aliases[0]!, state: "verified" },
			{ actionAlias: aliases[1]!, state: "needs_review" },
			{ actionAlias: aliases[2]!, state: "pending" },
		] as const satisfies readonly MailboxPlanRestartCheckpoint[];
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		test.setCheckpoints(source.planAlias, source.revisionAlias, saved);
		const capture = restartCapture(source, 103);
		test.setCapture(capture);

		const result = await test.service.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 4),
		});

		expect(result).toMatchObject({
			status: "completed",
			action: "restart",
			revisionAlias: capture.revision.revisionAlias,
			lifecycleState: "in_flight",
		});
		expect(test.rescans).toHaveLength(1);
		expect(test.rescans[0]?.checkpoints).toEqual(saved);
		expect(test.prepared).toHaveLength(1);
		expect(test.prepared[0]?.checkpoints).toEqual(saved);
		expect(test.events.some((event) => event.startsWith("focus:"))).toBe(false);
		expect(test.events.some((event) => event.startsWith("resume:"))).toBe(false);
	});

	it("distinguishes passive check-required, missing-session, restart-required, and typed failed-preflight stale states", async () => {
		const approved = revision(1, "approved");
		const missing = revision(2, "draft");
		const restartRequired = revision(3, "draft", {
			restartRequired: true,
		});
		const values: Seed[] = [
			{
				revision: approved,
				context: context(approved, 1),
				expiresAt: NOW_MS + DAY_MS,
			},
			{
				revision: missing,
				context: context(missing, 2),
				expiresAt: NOW_MS + DAY_MS,
				bindingStatus: { available: false, reason: "expired" },
			},
			{
				revision: restartRequired,
				context: context(restartRequired, 3),
				expiresAt: NOW_MS + DAY_MS,
			},
		];
		const test = harness(values);
		await registerAll(test.service, values);

		const initial = new Map(
			(await test.service.list()).rows.map((item) => [
				item.revisionAlias,
				item,
			]),
		);
		expect(initial.get(approved.revisionAlias)).toMatchObject({
			stale: false,
			staleReason: "check_required",
			nextAction: { type: "preflight" },
		});
		expect(initial.get(missing.revisionAlias)).toMatchObject({
			stale: true,
			staleReason: "missing_session",
			nextAction: { type: "restart" },
		});
		expect(initial.get(restartRequired.revisionAlias)).toMatchObject({
			stale: true,
			staleReason: "restart_required",
			nextAction: { type: "restart" },
		});

		for (const reason of [
			"fingerprint_mismatch",
			"account_mismatch",
			"layout_mismatch",
			"preflight_failed",
		] as const) {
			const value = revision(reason.length, "approved");
			const seed: Seed = {
				revision: value,
				context: context(value, reason.length),
				expiresAt: NOW_MS + DAY_MS,
			};
			const failed = harness([seed]);
			await registerAll(failed.service, [seed]);
			failed.setPreflight({ status: "blocked", reason });

			const result = await failed.service.perform({
				schemaVersion: 1,
				type: "preflight",
				planAlias: value.planAlias,
				revisionAlias: value.revisionAlias,
				requestAlias: opaqueAlias("req", reason.length),
			});
			expect(result).toMatchObject({ status: "blocked", reason });
			expect((await failed.service.list()).rows[0]).toMatchObject({
				stale: true,
				staleReason: reason,
				nextAction: { type: "restart" },
			});
		}
	});

	it("cancels an interrupted restart durably, rejects request replay, and leaves execution blocked", async () => {
		const source = revision(1, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 1),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const capture = restartCapture(source, 301);
		test.setRescan(
			(input) =>
				new Promise((resolve) => {
					input.signal.addEventListener(
						"abort",
						() => resolve(capture),
						{ once: true },
					);
				}),
		);
		const command = {
			schemaVersion: 1 as const,
			type: "restart" as const,
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 301),
		};
		const controller = new AbortController();
		const pending = test.service.perform(command, {
			signal: controller.signal,
		});
		await waitFor(() => test.rescans.length === 1);
		controller.abort();

		await expect(pending).resolves.toEqual({
			schemaVersion: 1,
			status: "canceled",
			requestAlias: command.requestAlias,
			action: "restart",
		});
		expect((await test.service.list()).rows[0]).toMatchObject({
			stale: true,
			staleReason: "interrupted_restart",
			nextAction: { type: "restart" },
		});
		await expect(test.service.perform(command)).rejects.toMatchObject({
			code: "replay",
		});
		expect(test.events).not.toContain(
			`bind:${capture.revision.revisionAlias}`,
		);
	});

	it("serializes concurrent restart callers and runs the external rescan exactly once", async () => {
		const source = revision(1, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 1),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const capture = restartCapture(source, 302);
		test.setCapture(capture);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		test.setRescan(async () => {
			await gate;
			return capture;
		});
		const first = test.service.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 302),
		});
		await waitFor(() => test.rescans.length === 1);
		const second = test.service.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 303),
		});
		release();

		const results = await Promise.all([first, second]);
		expect(results.filter((result) => result.status === "completed")).toHaveLength(
			1,
		);
		expect(results).toContainEqual({
			schemaVersion: 1,
			status: "blocked",
			requestAlias: opaqueAlias("req", 303),
			action: "restart",
			reason: "interrupted_restart",
		});
		expect(test.rescans).toHaveLength(1);
		expect(
			test.events.filter((event) => event.startsWith("invalidate-revision:")),
		).toHaveLength(1);
	});

	it("recovers an orphaned active restart as blocked before any candidate aliases can execute", async () => {
		const source = revision(1, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 1),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const capture = restartCapture(source, 304);
		const controller = new AbortController();
		test.setRescan(
			(input) =>
				new Promise((resolve) => {
					input.signal.addEventListener(
						"abort",
						() => resolve(capture),
						{ once: true },
					);
				}),
		);
		const pending = test.service.perform(
			{
				schemaVersion: 1,
				type: "restart",
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias: opaqueAlias("req", 304),
			},
			{ signal: controller.signal },
		);
		await waitFor(() => test.rescans.length === 1);

		await expect(test.createService().recoverRestarts()).resolves.toEqual([
			{
				schemaVersion: 1,
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				status: "blocked",
			},
		]);
		controller.abort();
		await pending;
		expect(test.events).not.toContain(
			`bind:${capture.revision.revisionAlias}`,
		);
	});

	it("fences cross-instance restart ownership before either worker can rescan or commit", async () => {
		const source = revision(401, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 401),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const peer = test.createService();
		const capture = restartCapture(source, 401);
		test.setCapture(capture);
		let ownerWrites = 0;
		let releaseOwners!: () => void;
		const ownersReady = new Promise<void>((resolve) => {
			releaseOwners = resolve;
		});
		test.setCas(async (_storageKey, _expected, value, commit) => {
			const registry = value as {
				restarts?: readonly Readonly<{
					status?: string;
					candidateRevisionAlias?: string;
				}>[];
			};
			const claimsOwnership = registry.restarts?.some(
				(item) =>
					item.status === "active" &&
					item.candidateRevisionAlias === undefined,
			);
			if (claimsOwnership && ownerWrites < 2) {
				ownerWrites += 1;
				await ownersReady;
			}
			return commit();
		});
		const command = (requestSeed: number) => ({
			schemaVersion: 1 as const,
			type: "restart" as const,
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", requestSeed),
		});
		const first = test.service.perform(command(401));
		const second = peer.perform(command(402));
		await waitFor(() => ownerWrites === 2);
		releaseOwners();

		const results = await Promise.all([first, second]);
		expect(results.filter((result) => result.status === "completed")).toHaveLength(
			1,
		);
		expect(results.filter((result) => result.status === "blocked")).toHaveLength(
			1,
		);
		expect(test.rescans).toHaveLength(1);
		expect(
			test.events.filter((event) => event.startsWith("put:")),
		).toHaveLength(1);
	});

	it("invalidates the old source and fences its crashed owner before restart recovery returns", async () => {
		const source = revision(402, "in_flight", { restartRequired: true });
		const sourceBinding = {
			[source.cohorts[0]!.messageAliases[0]!]: `${RAW_SENTINEL}:crashed`,
		};
		const seed: Seed = {
			revision: source,
			context: context(source, 402),
			expiresAt: NOW_MS + DAY_MS,
			executionStatus: "live",
			bindings: sourceBinding,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const recovering = test.createService();
		let releaseInvalidation!: () => void;
		const invalidationGate = new Promise<void>((resolve) => {
			releaseInvalidation = resolve;
		});
		let invalidations = 0;
		test.setInvalidateRevision(async (_planAlias, _revisionAlias, commit) => {
			invalidations += 1;
			if (invalidations === 1) await invalidationGate;
			return commit();
		});
		const pending = test.service.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 403),
		});
		await waitFor(async () => {
			const row = (await recovering.list()).rows[0];
			return row?.staleReason === "interrupted_restart";
		});

		await expect(recovering.recoverRestarts()).resolves.toEqual([
			{
				schemaVersion: 1,
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				status: "blocked",
			},
		]);
		expect(test.events).toContain(
			`invalidate-revision:${source.revisionAlias}`,
		);
		await expect(
			recovering.perform({
				schemaVersion: 1,
				type: "focus",
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias: opaqueAlias("req", 404),
			}),
		).rejects.toMatchObject({ code: "invalid_action" });
		releaseInvalidation();
		await expect(pending).resolves.toMatchObject({
			status: "blocked",
		});
		expect(test.events.some((event) => event.startsWith("focus:"))).toBe(false);
		expect(test.rescans).toHaveLength(0);
	});

	it("never commits a candidate when the source expires during rescan or pre-commit persistence", async () => {
		for (const phase of ["rescan", "precommit"] as const) {
			const source = revision(
				phase === "rescan" ? 410 : 411,
				"approved",
				{ restartRequired: true },
			);
			const expiresAt = NOW_MS + HOUR_MS;
			const seed: Seed = {
				revision: source,
				context: context(source, phase === "rescan" ? 410 : 411),
				expiresAt,
			};
			const test = harness([seed]);
			await registerAll(test.service, [seed]);
			const capture = restartCapture(
				source,
				phase === "rescan" ? 410 : 411,
			);
			test.setCapture(capture);
			if (phase === "rescan") {
				test.setRescan(async () => {
					test.setNow(expiresAt);
					return capture;
				});
			} else {
				test.setCas(async (_storageKey, _expected, value, commit) => {
					const registry = value as {
						restarts?: readonly Readonly<{
							candidateRevisionAlias?: string;
							status?: string;
						}>[];
					};
					if (
						registry.restarts?.some(
							(item) =>
								item.status === "active" &&
								item.candidateRevisionAlias ===
									capture.revision.revisionAlias,
						)
					) {
						test.setNow(expiresAt);
					}
					return commit();
				});
			}

			await expect(
				test.service.perform({
					schemaVersion: 1,
					type: "restart",
					planAlias: source.planAlias,
					revisionAlias: source.revisionAlias,
					requestAlias: opaqueAlias(
						"req",
						phase === "rescan" ? 410 : 411,
					),
				}),
			).resolves.toMatchObject({
				status: "blocked",
				reason: "storage_failure",
			});
			expect(
				test.records.has(
					`${source.planAlias}:${capture.revision.revisionAlias}`,
				),
			).toBe(false);
			expect(
				test.events.filter(
					(event) => event === `put:${capture.revision.revisionAlias}`,
				),
			).toEqual([]);
		}
	});

	it("blocks recovery instead of promoting a candidate after its source expires", async () => {
		const source = revision(412, "approved", { restartRequired: true });
		const expiresAt = NOW_MS + HOUR_MS;
		const seed: Seed = {
			revision: source,
			context: context(source, 412),
			expiresAt,
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		const capture = restartCapture(source, 412);
		test.setCapture(capture);
		let releaseTransition!: () => void;
		const transitionGate = new Promise<void>((resolve) => {
			releaseTransition = resolve;
		});
		test.setTransition(async (change) => {
			await transitionGate;
			const record = test.records.get(
				`${change.planAlias}:${change.revisionAlias}`,
			);
			if (record === undefined) throw new Error("missing revision");
			return {
				...record.revision,
				state: change.nextState,
			} as MailboxPlanRevision;
		});
		const pending = test.service.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 412),
		});
		await waitFor(
			() =>
				test.events.includes(`prepare:${capture.revision.revisionAlias}`),
		);
		test.setNow(expiresAt);

		await expect(test.createService().recoverRestarts()).resolves.toEqual([
			{
				schemaVersion: 1,
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				status: "blocked",
				candidateRevisionAlias: capture.revision.revisionAlias,
			},
		]);
		expect(
			(await test.createService().list({ states: ["approved", "in_flight"] }))
				.rows.some(
					(row) => row.revisionAlias === capture.revision.revisionAlias,
				),
		).toBe(false);
		releaseTransition();
		await expect(pending).resolves.toMatchObject({
			status: "blocked",
			reason: "storage_failure",
		});
	});

	it("returns a typed blocked Resume when execution pauses without completing", async () => {
		const source = revision(413, "in_flight");
		const seed: Seed = {
			revision: source,
			context: context(source, 413),
			expiresAt: NOW_MS + DAY_MS,
			executionStatus: "resumable",
		};
		const test = harness([seed]);
		await registerAll(test.service, [seed]);
		test.setResumeOutcome("missing_session");

		await expect(
			test.service.perform({
				schemaVersion: 1,
				type: "resume",
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias: opaqueAlias("req", 413),
			}),
		).resolves.toEqual({
			schemaVersion: 1,
			status: "blocked",
			requestAlias: opaqueAlias("req", 413),
			action: "resume",
			reason: "missing_session",
		});
	});

	it("lets Restart claim after a crashed execution admission expires", async () => {
		const source = revision(414, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 414),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		const peer = test.createService();
		await registerAll(test.service, [seed]);
		test.setCapture(restartCapture(source, 414));
		await test.service.acquireExecutionAdmission(
			source.planAlias,
			source.revisionAlias,
			opaqueAlias("exec", 414),
		);

		await expect(
			peer.perform({
				schemaVersion: 1,
				type: "restart",
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias: opaqueAlias("req", 414),
			}),
		).resolves.toMatchObject({
			status: "blocked",
			reason: "interrupted_restart",
		});
		expect(test.events).toEqual([]);
		await expect(
			peer.hasActiveRestart(
				source.planAlias,
				source.revisionAlias,
			),
		).resolves.toBe(false);

		test.setNow(NOW_MS + HOUR_MS);
		await expect(
			peer.perform({
				schemaVersion: 1,
				type: "restart",
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias: opaqueAlias("req", 415),
			}),
		).resolves.toMatchObject({
			status: "completed",
			action: "restart",
		});
		await expect(
			peer.acquireExecutionAdmission(
				source.planAlias,
				source.revisionAlias,
				opaqueAlias("exec", 415),
			),
		).rejects.toMatchObject({ code: "conflict" });
		expect(test.events).toContain(
			`invalidate-revision:${source.revisionAlias}`,
		);
	});

	it("linearizes a last-moment heartbeat before Restart and lets a retry claim only after release", async () => {
		const source = revision(415, "approved", { restartRequired: true });
		const seed: Seed = {
			revision: source,
			context: context(source, 415),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		const peer = test.createService();
		await registerAll(test.service, [seed]);
		const capture = restartCapture(source, 415);
		test.setCapture(capture);
		const owner = opaqueAlias("exec", 416);
		await test.service.acquireExecutionAdmission(
			source.planAlias,
			source.revisionAlias,
			owner,
		);
		test.setNow(NOW_MS + 14_999);
		let releaseHeartbeat!: () => void;
		const heartbeatGate = new Promise<void>((resolve) => {
			releaseHeartbeat = resolve;
		});
		let reportHeartbeat!: () => void;
		const heartbeatEntered = new Promise<void>((resolve) => {
			reportHeartbeat = resolve;
		});
		let gateHeartbeat = true;
		test.setCas(async (
			_storageKey,
			_expectedVersion,
			_value,
			commit,
		) => {
			if (gateHeartbeat) {
				gateHeartbeat = false;
				reportHeartbeat();
				await heartbeatGate;
			}
			return commit();
		});
		const heartbeat = test.service.assertExecutionAdmission(
			source.planAlias,
			source.revisionAlias,
			owner,
		);
		await heartbeatEntered;

		await expect(
			peer.perform({
				schemaVersion: 1,
				type: "restart",
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias: opaqueAlias("req", 416),
			}),
		).resolves.toMatchObject({
			status: "blocked",
			reason: "interrupted_restart",
		});
		expect(test.events).toEqual([]);
		await expect(
			peer.hasActiveRestart(
				source.planAlias,
				source.revisionAlias,
			),
		).resolves.toBe(false);
		releaseHeartbeat();
		await expect(heartbeat).resolves.toBeUndefined();
		await test.service.releaseExecutionAdmission(
			source.planAlias,
			source.revisionAlias,
			owner,
		);

		let releaseRescan!: () => void;
		const rescanGate = new Promise<void>((resolve) => {
			releaseRescan = resolve;
		});
		let reportRescan!: () => void;
		const rescanEntered = new Promise<void>((resolve) => {
			reportRescan = resolve;
		});
		test.setRescan(async () => {
			reportRescan();
			await rescanGate;
			return capture;
		});
		const retry = peer.perform({
			schemaVersion: 1,
			type: "restart",
			planAlias: source.planAlias,
			revisionAlias: source.revisionAlias,
			requestAlias: opaqueAlias("req", 417),
		});
		await rescanEntered;
		await expect(
			test.service.hasActiveRestart(
				source.planAlias,
				source.revisionAlias,
			),
		).resolves.toBe(true);
		await expect(
			test.service.acquireExecutionAdmission(
				source.planAlias,
				source.revisionAlias,
				opaqueAlias("exec", 417),
			),
		).rejects.toMatchObject({ code: "conflict" });
		releaseRescan();
		await expect(retry).resolves.toMatchObject({
			status: "completed",
			action: "restart",
		});
	});

	it("does not let an owner mismatch assert or release another execution admission", async () => {
		const source = revision(418, "approved");
		const seed: Seed = {
			revision: source,
			context: context(source, 418),
			expiresAt: NOW_MS + DAY_MS,
		};
		const test = harness([seed]);
		const peer = test.createService();
		await registerAll(test.service, [seed]);
		await test.service.acquireExecutionAdmission(
			source.planAlias,
			source.revisionAlias,
			opaqueAlias("exec", 416),
		);

		await expect(
			peer.acquireExecutionAdmission(
				source.planAlias,
				source.revisionAlias,
				opaqueAlias("exec", 416),
			),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			peer.assertExecutionAdmission(
				source.planAlias,
				source.revisionAlias,
				opaqueAlias("exec", 417),
			),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			peer.releaseExecutionAdmission(
				source.planAlias,
				source.revisionAlias,
				opaqueAlias("exec", 417),
			),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			test.service.assertExecutionAdmission(
				source.planAlias,
				source.revisionAlias,
				opaqueAlias("exec", 416),
			),
		).resolves.toBeUndefined();

		await test.service.releaseExecutionAdmission(
			source.planAlias,
			source.revisionAlias,
			opaqueAlias("exec", 416),
		);
		await expect(
			peer.acquireExecutionAdmission(
				source.planAlias,
				source.revisionAlias,
				opaqueAlias("exec", 418),
			),
		).resolves.toBeUndefined();
	});

	it("keeps 1,024 per-plan replay tombstones without blocking another plan and prunes only after expiry", async () => {
		const source = revision(416, "approved");
		const other = revision(417, "approved");
		const seeds: Seed[] = [source, other].map((value, index) => ({
			revision: value,
			context: context(value, 416 + index),
			expiresAt: NOW_MS + DAY_MS,
		}));
		const test = harness(seeds);
		await registerAll(test.service, seeds);
		const perform = (
			value: MailboxPlanRevision,
			requestAlias: string,
		) =>
			test.service.perform({
				schemaVersion: 1,
				type: "preflight",
				planAlias: value.planAlias,
				revisionAlias: value.revisionAlias,
				requestAlias,
			});
		const original = opaqueAlias("req", 416);
		const tombstoneExpiry = NOW_MS + HOUR_MS;
		test.seedRequestTombstones(
			Array.from({ length: 1_024 }, (_unused, index) => ({
				planAlias: source.planAlias,
				revisionAlias: source.revisionAlias,
				requestAlias:
					index === 0
						? original
						: opaqueAlias("req", 10_000 + index),
				expiresAt: tombstoneExpiry,
			})),
		);

		await expect(perform(source, original)).rejects.toMatchObject({
			code: "replay",
		});
		await expect(
			perform(source, opaqueAlias("req", 20_000)),
		).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(
			perform(other, opaqueAlias("req", 20_001)),
		).resolves.toMatchObject({
			status: "completed",
		});
		test.setNow(tombstoneExpiry);
		await expect(
			perform(source, opaqueAlias("req", 20_002)),
		).resolves.toMatchObject({
			status: "completed",
		});
	});
});
