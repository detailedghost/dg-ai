import type { MailboxFingerprint } from "@dg/common";
import type { MailboxRuntimeChatReceiver } from "../features/mailbox-cleanup/bridge";
import {
	postMailboxCliTerminal,
	requestMailboxCliAuthor,
	type MailboxCliConnection,
	type MailboxCliRuntimeSender,
} from "../features/mailbox-cleanup/cli-transport";
import {
	createMailboxDebriefService,
} from "../features/mailbox-cleanup/debrief";
import {
	createMailboxExecutionCoordinator,
	createMailboxExecutionJournal,
	type MailboxExecutionCoordinator,
} from "../features/mailbox-cleanup/execution";
import type {
	MailboxExecutionAtomicStorage,
} from "../features/mailbox-cleanup/execution/contracts";
import { createMailboxLifecycle } from "../features/mailbox-cleanup/lifecycle";
import {
	createGuardedMailboxExecutionProvider,
	type MailboxProvider,
} from "../features/mailbox-cleanup/providers";
import { isValidMailboxScopedAlias } from "../features/mailbox-cleanup/privacy";
import {
	createBrowserRawBindingAlarms,
	createMailboxPlanStore,
	createRawBindingStore,
	type RawBindingScope,
	type SessionStorageSeam,
} from "../features/mailbox-cleanup/storage";
import {
	registerMailboxCleanupBackground,
	type MailboxCleanupBackgroundRegistration,
} from "./mailbox-cleanup";
import { createMailboxExecutionIndexedDbStorage } from "./mailbox-cleanup-storage";
import { createMailboxProductionOrchestrator } from "./mailbox-cleanup-orchestrator";
import { createMailboxCliAuthority } from "./mailbox-cli-authority";

type StorageArea = Readonly<{
	get(key: string): Promise<Record<string, unknown>>;
	set(value: Record<string, unknown>): Promise<void>;
	remove(key: string): Promise<void>;
}>;

export type MailboxCleanupBrowserSeam = Readonly<{
	runtime: Readonly<{
		getURL(path: string): string;
		sendMessage(value: unknown): Promise<unknown>;
		onMessage: Readonly<{
			addListener(
				listener: (
					value: unknown,
					sender?: MailboxCliRuntimeSender,
				) => unknown,
			): void;
			removeListener(
				listener: (
					value: unknown,
					sender?: MailboxCliRuntimeSender,
				) => unknown,
			): void;
		}>;
	}>;
	storage: Readonly<{
		session: StorageArea;
		local: StorageArea;
	}>;
	downloads: Readonly<{
		download(value: Readonly<{
			url: string;
			filename: string;
			saveAs: boolean;
		}>): Promise<unknown>;
		search?(query: Readonly<{ id: number }>): Promise<readonly Readonly<{
			id: number;
			state?: "in_progress" | "complete" | "interrupted";
		}>[]>;
		onChanged?: Readonly<{
			addListener(listener: (delta: Readonly<{
				id: number;
				state?: Readonly<{
					current: "in_progress" | "complete" | "interrupted";
				}>;
			}>) => void): void;
			removeListener(listener: (delta: Readonly<{
				id: number;
				state?: Readonly<{
					current: "in_progress" | "complete" | "interrupted";
				}>;
			}>) => void): void;
		}>;
	}>;
	tabs: Readonly<{
		create(value: Readonly<{ url: string }>): Promise<unknown>;
		onRemoved?: Readonly<{
			addListener(listener: (tabId: number) => void): void;
			removeListener(listener: (tabId: number) => void): void;
		}>;
	}>;
	alarms?: Readonly<{
		create(name: string, info: Readonly<{ when: number }>): Promise<void> | void;
		clear(name: string): Promise<boolean> | boolean;
		onAlarm: Readonly<{
			addListener(listener: (alarm: Readonly<{ name: string }>) => void): void;
			removeListener(listener: (alarm: Readonly<{ name: string }>) => void): void;
		}>;
	}>;
}>;

const EXECUTION_RECOVERY_ALARM = "dg:mailbox:execution-recovery:v1";
const EXECUTION_RECOVERY_INTERVAL_MS = 30_000;

export type MailboxCleanupBackgroundCompositionOptions = Readonly<{
	browser: MailboxCleanupBrowserSeam;
	indexedDB: IDBFactory;
	providers: readonly MailboxProvider[];
	executionStorage?: MailboxExecutionAtomicStorage;
	now?: () => number;
	computeFingerprint?(
		input: Readonly<Record<string, unknown>>,
	): Promise<MailboxFingerprint>;
	cliTerminal?(
		connection: MailboxCliConnection,
	): Promise<unknown>;
	fetch?(input: string, init: RequestInit): Promise<Response>;
	chatReceiver?: MailboxRuntimeChatReceiver;
}>;

function sessionStorage(area: StorageArea): SessionStorageSeam {
	return {
		async get(key) {
			return (await area.get(key))[key];
		},
		async set(key, value) {
			await area.set({ [key]: value });
		},
		async delete(key) {
			await area.remove(key);
		},
	};
}

function revisionIndexKey(planAlias: string, revisionAlias: string): string {
	const prefix = "dg:mailbox:raw-bindings:v1:revision:";
	return `${prefix}${planAlias.length}:${planAlias}|${revisionAlias.length}:${revisionAlias}:index`;
}

function scope(value: unknown, planAlias: string, revisionAlias: string): RawBindingScope {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Mailbox binding scope is unavailable");
	}
	const input = value as Record<string, unknown>;
	const keys = [
		"planAlias",
		"providerId",
		"surface",
		"accountAlias",
		"runAlias",
		"revisionAlias",
	];
	if (
		Object.keys(input).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key)) ||
		input.planAlias !== planAlias ||
		input.revisionAlias !== revisionAlias ||
		typeof input.providerId !== "string" ||
		!/^[a-z][a-z0-9-]{0,63}$/.test(input.providerId) ||
		typeof input.surface !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(input.surface) ||
		!isValidMailboxScopedAlias(input.planAlias, "plan") ||
		!isValidMailboxScopedAlias(input.accountAlias, "acct") ||
		!isValidMailboxScopedAlias(input.runAlias, "run") ||
		!isValidMailboxScopedAlias(input.revisionAlias, "rev")
	) {
		throw new Error("Mailbox binding scope is unavailable");
	}
	return Object.freeze({
		planAlias,
		providerId: input.providerId,
		surface: input.surface,
		accountAlias: input.accountAlias as string,
		runAlias: input.runAlias as string,
		revisionAlias,
	});
}

function extensionOrigin(browser: MailboxCleanupBrowserSeam): string {
	const parsed = new URL(browser.runtime.getURL(""));
	const value = `${parsed.protocol}//${parsed.host}`;
	if (!/^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/.test(value)) {
		throw new Error("Invalid mailbox extension origin");
	}
	return `${value}/`;
}

export function createMailboxCleanupBackgroundComposition(
	options: MailboxCleanupBackgroundCompositionOptions,
): Readonly<{
	execution: MailboxExecutionCoordinator;
	register(): MailboxCleanupBackgroundRegistration;
	dispose(): Promise<void>;
}> {
	const now = options.now ?? Date.now;
	const session = sessionStorage(options.browser.storage.session);
	const origin = extensionOrigin(options.browser);
	const transport = Object.freeze({
		extensionOrigin: origin,
		fetch:
			options.fetch ??
			((input: string, init: RequestInit) => fetch(input, init)),
	});
	const authority = createMailboxCliAuthority({
		extensionOrigin: origin,
		session,
		openApproval: (url) => options.browser.tabs.create({ url }),
		now,
		tabsOnRemoved: options.browser.tabs.onRemoved,
	});
	type ActiveCliSession = {
		readonly connection: MailboxCliConnection;
		planAlias?: string;
		readonly done: Promise<void>;
		finish(): void;
	};
	let activeCli: ActiveCliSession | undefined;
	const createActiveCli = (
		connection: MailboxCliConnection,
	): ActiveCliSession => {
		let resolve!: () => void;
		return {
			connection,
			done: new Promise<void>((nextResolve) => {
				resolve = nextResolve;
			}),
			finish() {
				resolve();
			},
		};
	};
	const finishActiveCli = (active: ActiveCliSession): void => {
		if (activeCli !== active) return;
		activeCli = undefined;
		active.finish();
	};
	const postActiveCliTerminal = async (
		active: ActiveCliSession,
		value: unknown,
	): Promise<void> => {
		try {
			await postMailboxCliTerminal(active.connection, value, transport);
		} finally {
			finishActiveCli(active);
		}
	};
	const alarmRegistration =
		options.browser.alarms === undefined
			? undefined
			: createBrowserRawBindingAlarms({
					alarms: options.browser.alarms,
					session: options.browser.storage.session,
				});
	const bindings = createRawBindingStore({
		session,
		now,
		alarms: alarmRegistration?.alarms,
	});
	const orchestrator = createMailboxProductionOrchestrator({
		providers: options.providers,
		session,
		bindings,
		browser: options.browser,
		now,
		async authorChat(message) {
			const active = activeCli;
			if (
				active === undefined ||
				(active.planAlias !== undefined &&
					active.planAlias !== message.planAlias)
			) {
				return Object.freeze({
					status: "error",
					code: "provider_refused",
				});
			}
			active.planAlias = message.planAlias;
			try {
				return await requestMailboxCliAuthor(
					active.connection,
					message,
					transport,
				);
			} finally {
				finishActiveCli(active);
			}
		},
		async cancelChat() {
			const active = activeCli;
			if (active === undefined) return;
			await postActiveCliTerminal(active, { status: "canceled" });
		},
		async closeChat() {
			const active = activeCli;
			if (active === undefined) return;
			await postActiveCliTerminal(active, { status: "canceled" });
		},
	});
	const plans = createMailboxPlanStore({
		indexedDB: options.indexedDB,
		now,
	});
	const loadScope = async (
		planAlias: string,
		revisionAlias: string,
	): Promise<RawBindingScope> => {
		const indexed = await session.get(
			revisionIndexKey(planAlias, revisionAlias),
		);
		if (!Array.isArray(indexed) || indexed.length !== 1) {
			throw new Error("Mailbox binding scope is unavailable");
		}
		return scope(indexed[0], planAlias, revisionAlias);
	};
	const lifecycle = createMailboxLifecycle({
		store: plans,
		now,
		execution: {
			async has(planAlias, revisionAlias) {
				try {
					const bindingScope = await loadScope(planAlias, revisionAlias);
					return (await bindings.get(bindingScope)) !== undefined;
				} catch {
					return false;
				}
			},
			invalidate: (planAlias, revisionAlias, reason) =>
				bindings.invalidateRevision(planAlias, revisionAlias, reason),
		},
	});
	const journal = createMailboxExecutionJournal({
		storage:
			options.executionStorage ??
			createMailboxExecutionIndexedDbStorage(options.indexedDB),
		now: () => new Date(now()).toISOString(),
	});
	const debriefStorage = sessionStorage(options.browser.storage.local);
	const debrief = createMailboxDebriefService({
		now: () => new Date(now()).toISOString(),
		storage: {
			get: (key) => debriefStorage.get(key),
			set: (key, value) => debriefStorage.set(key, value),
			remove: (key) => debriefStorage.delete(key),
		},
		async download(report) {
			const data =
				`data:${report.mimeType},${encodeURIComponent(report.content)}`;
			const downloadId = await options.browser.downloads.download({
				url: data,
				filename: report.filename,
				saveAs: true,
			});
			if (
				typeof downloadId !== "number" ||
				!Number.isSafeInteger(downloadId) ||
				downloadId < 0
			) {
				throw new Error("Invalid mailbox debrief download");
			}
			return downloadId;
		},
		async downloadState(downloadId) {
			if (options.browser.downloads.search === undefined) return "missing";
			const matches = await options.browser.downloads.search({
				id: downloadId,
			});
			const match = matches.find((item) => item.id === downloadId);
			return match?.state ?? "missing";
		},
	});
	const execution = createMailboxExecutionCoordinator({
		async loadRevision(planAlias, revisionAlias) {
			return plans.getRevision(planAlias, revisionAlias);
		},
		async loadBinding(planAlias, revisionAlias) {
			const bindingScope = await loadScope(planAlias, revisionAlias);
			const raw = await bindings.get(bindingScope);
			if (raw === undefined) {
				throw new Error("Mailbox binding is unavailable");
			}
			return Object.freeze({ scope: bindingScope, bindings: raw });
		},
		async resolveProvider(providerScope) {
			const provider = options.providers.find(
				(candidate) =>
					candidate.id === providerScope.providerId &&
					candidate.surfaces.includes(String(providerScope.surface)),
			);
			if (provider === undefined) {
				throw Object.freeze({ reasonCode: "provider_refused" });
			}
			return createGuardedMailboxExecutionProvider(provider);
		},
			computeFingerprint:
				options.computeFingerprint ??
				orchestrator.computeFingerprint,
		journal,
		now: () => new Date(now()).toISOString(),
		generateDebrief: (input) => debrief.generate(input),
		async transitionRevision(planAlias, revisionAlias, expected, next) {
			await lifecycle.transition({
				planAlias,
				revisionAlias,
				expectedState: expected,
				nextState: next,
			});
		},
	});
	const cliTerminal =
		options.cliTerminal ??
		orchestrator.launch;
	let registration: MailboxCleanupBackgroundRegistration | undefined;
	let recovery: Promise<void> | undefined;
	let recoveryRegistered = false;
	const recover = (): Promise<void> => {
		if (recovery !== undefined) return recovery;
		recovery = execution
			.recoverActive()
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => {
				recovery = undefined;
			});
		return recovery;
	};
	const scheduleRecovery = (): void => {
		void options.browser.alarms?.create(EXECUTION_RECOVERY_ALARM, {
			when: now() + EXECUTION_RECOVERY_INTERVAL_MS,
		});
	};
	const onRecoveryAlarm = (alarm: Readonly<{ name: string }>): void => {
		if (alarm.name !== EXECUTION_RECOVERY_ALARM) return;
		void recover().finally(scheduleRecovery);
	};
	const onDownloadChanged = (delta: Readonly<{
		id: number;
		state?: Readonly<{
			current: "in_progress" | "complete" | "interrupted";
		}>;
	}>): void => {
		if (
			delta.state?.current !== "complete" &&
			delta.state?.current !== "interrupted"
		) {
			return;
		}
		void recover();
	};
	return Object.freeze({
		execution,
		register() {
			if (registration !== undefined) return registration;
				registration = registerMailboxCleanupBackground({
					runtime: options.browser.runtime,
					chatReceiver:
						options.chatReceiver ?? orchestrator.chatReceiver,
					verifyProposalFingerprint: async ({
						submittedRevision,
						proposal,
						inventory,
					}) =>
						orchestrator.refingerprintProposal({
							submittedRevision,
							proposal,
							inventory,
						}),
				execution,
				cli: {
					async connect(connection, sender) {
						await authority.authorize(connection, sender);
						if (activeCli !== undefined) {
							throw new Error(
								"Mailbox CLI session is already active",
							);
						}
						const active = createActiveCli(connection);
						activeCli = active;
						let terminal: unknown;
						try {
							terminal = await cliTerminal(connection);
						} catch {
							await postActiveCliTerminal(active, {
								status: "error",
								code: "provider_refused",
							});
							return;
						}
						if (
							terminal !== null &&
							typeof terminal === "object" &&
							!Array.isArray(terminal) &&
							(terminal as { status?: unknown }).status ===
								"proposal"
						) {
							const proposal = (
								terminal as {
									proposal?: { planAlias?: unknown };
								}
							).proposal;
							if (typeof proposal?.planAlias !== "string") {
								await postActiveCliTerminal(active, {
									status: "error",
									code: "provider_refused",
								});
								return;
							}
							active.planAlias = proposal.planAlias;
							await active.done;
							return;
						}
						await postActiveCliTerminal(active, terminal);
					},
					inspect(approvalAlias, sender) {
						return authority.inspect(approvalAlias, sender);
					},
					decide(approvalAlias, decision, sender) {
						return authority.decide(
							approvalAlias,
							decision,
							sender,
						);
					},
				},
			});
			if (!recoveryRegistered) {
				recoveryRegistered = true;
				options.browser.alarms?.onAlarm.addListener(onRecoveryAlarm);
				options.browser.downloads.onChanged?.addListener(
					onDownloadChanged,
				);
				scheduleRecovery();
				void recover();
			}
			return registration;
		},
		async dispose() {
			registration?.dispose();
			registration = undefined;
			authority.dispose();
			const active = activeCli;
			if (active !== undefined) finishActiveCli(active);
			if (recoveryRegistered) {
				recoveryRegistered = false;
				options.browser.alarms?.onAlarm.removeListener(onRecoveryAlarm);
				options.browser.downloads.onChanged?.removeListener(
					onDownloadChanged,
				);
				await options.browser.alarms
					?.clear(EXECUTION_RECOVERY_ALARM);
			}
			await recovery;
			alarmRegistration?.dispose();
			await plans.close();
		},
	});
}
