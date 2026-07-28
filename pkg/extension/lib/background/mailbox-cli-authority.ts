import type {
	MailboxCliApprovalDecision,
	MailboxCliApprovalView,
	MailboxCliConnection,
	MailboxCliRuntimeSender,
} from "../features/mailbox-cleanup/cli-transport";
import type { SessionStorageSeam } from "../features/mailbox-cleanup/storage";

const APPROVAL_PAGE = "mailbox-cli-approval.html";
const DEFAULT_APPROVAL_TTL_MS = 60_000;
const MIN_APPROVAL_TTL_MS = 5_000;
const MAX_APPROVAL_TTL_MS = 2 * 60_000;
const CONSUMED_TTL_MS = 10 * 60_000;

type PendingApproval = {
	readonly approvalAlias: string;
	readonly connection: MailboxCliConnection;
	readonly connectionTabId: number;
	readonly connectionFrameId: number;
	readonly approvalTabId: number;
	readonly expiresAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
	resolve(): void;
	reject(error: Error): void;
};

export type MailboxCliAuthority = Readonly<{
	authorize(
		connection: MailboxCliConnection,
		sender: MailboxCliRuntimeSender,
	): Promise<void>;
	inspect(
		approvalAlias: string,
		sender: MailboxCliRuntimeSender,
	): Promise<MailboxCliApprovalView>;
	decide(
		approvalAlias: string,
		decision: MailboxCliApprovalDecision,
		sender: MailboxCliRuntimeSender,
	): Promise<void>;
	dispose(): void;
}>;

function fail(): never {
	throw new Error("Mailbox CLI connection was not authorized");
}

function hex(bytes: Uint8Array): string {
	return [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function approvalAlias(randomBytes: (size: number) => Uint8Array): string {
	const bytes = randomBytes(16);
	if (
		!(bytes instanceof Uint8Array) ||
		bytes.byteLength !== 16 ||
		new Set(bytes).size < 8
	) {
		fail();
	}
	return `cli_${hex(bytes)}`;
}

function extensionId(extensionOrigin: string): string {
	const parsed = new URL(extensionOrigin);
	if (
		(parsed.protocol !== "chrome-extension:" &&
			parsed.protocol !== "moz-extension:") ||
		!/^[a-z0-9-]+$/.test(parsed.host) ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		fail();
	}
	return parsed.host;
}

function safeTabId(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0
	) {
		fail();
	}
	return value;
}

function connectionSender(
	sender: MailboxCliRuntimeSender,
	connection: MailboxCliConnection,
	expectedExtensionId: string,
): Readonly<{ tabId: number; frameId: number }> {
	const frameId = sender.frameId;
	const tabId = safeTabId(sender.tab?.id);
	if (
		sender.id !== expectedExtensionId ||
		frameId !== 0 ||
		typeof sender.url !== "string"
	) {
		fail();
	}
	const parsed = new URL(sender.url);
	if (
		parsed.origin !== connection.origin ||
		parsed.pathname !==
			`/mailbox-cleanup/v1/connect/${connection.runAlias}` ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		fail();
	}
	return Object.freeze({ tabId, frameId });
}

function approvalSender(
	sender: MailboxCliRuntimeSender,
	pending: PendingApproval,
	expectedExtensionOrigin: string,
	expectedExtensionId: string,
): void {
	if (
		sender.id !== expectedExtensionId ||
		sender.frameId !== 0 ||
		safeTabId(sender.tab?.id) !== pending.approvalTabId ||
		typeof sender.url !== "string"
	) {
		fail();
	}
	const parsed = new URL(sender.url);
	if (
		`${parsed.protocol}//${parsed.host}/` !== expectedExtensionOrigin ||
		parsed.pathname !== `/${APPROVAL_PAGE}` ||
		parsed.search !== "" ||
		parsed.hash !== `#approval=${pending.approvalAlias}`
	) {
		fail();
	}
}

function consumedKey(connection: MailboxCliConnection): string {
	return `dg:mailbox-cli-authority:v1:${connection.runAlias}:${connection.nonce}`;
}

function exactConsumed(
	value: unknown,
	connection: MailboxCliConnection,
	now: number,
): "absent" | "expired" | "replay" {
	if (value === undefined) return "absent";
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return "replay";
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 2 ||
		input.origin !== connection.origin ||
		typeof input.expiresAt !== "number" ||
		!Number.isSafeInteger(input.expiresAt)
	) {
		return "replay";
	}
	return input.expiresAt <= now ? "expired" : "replay";
}

export function createMailboxCliAuthority(deps: Readonly<{
	extensionOrigin: string;
	session: SessionStorageSeam;
	openApproval(url: string): Promise<unknown>;
	now(): number;
	randomBytes?(size: number): Uint8Array;
	approvalTtlMs?: number;
	tabsOnRemoved?: Readonly<{
		addListener(listener: (tabId: number) => void): void;
		removeListener(listener: (tabId: number) => void): void;
	}>;
}>): MailboxCliAuthority {
	const ttlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
	if (
		!Number.isSafeInteger(ttlMs) ||
		ttlMs < MIN_APPROVAL_TTL_MS ||
		ttlMs > MAX_APPROVAL_TTL_MS
	) {
		fail();
	}
	const parsedExtensionOrigin = new URL(deps.extensionOrigin);
	const origin =
		`${parsedExtensionOrigin.protocol}//${parsedExtensionOrigin.host}/`;
	const id = extensionId(origin);
	const random =
		deps.randomBytes ??
		((size: number) => crypto.getRandomValues(new Uint8Array(size)));
	const pendingByAlias = new Map<string, PendingApproval>();
	const pendingByConnection = new Set<string>();
	let disposed = false;

	const connectionKey = (connection: MailboxCliConnection): string =>
		`${connection.origin}:${connection.runAlias}:${connection.nonce}`;

	const remove = (
		pending: PendingApproval,
		error?: Error,
	): void => {
		if (pendingByAlias.get(pending.approvalAlias) !== pending) return;
		pendingByAlias.delete(pending.approvalAlias);
		pendingByConnection.delete(connectionKey(pending.connection));
		clearTimeout(pending.timer);
		if (error === undefined) pending.resolve();
		else pending.reject(error);
	};

	const onTabRemoved = (tabId: number): void => {
		for (const pending of pendingByAlias.values()) {
			if (
				pending.connectionTabId === tabId ||
				pending.approvalTabId === tabId
			) {
				remove(
					pending,
					new Error("Mailbox CLI approval was closed"),
				);
			}
		}
	};
	deps.tabsOnRemoved?.addListener(onTabRemoved);

	return Object.freeze({
		async authorize(connection, sender) {
			if (disposed) fail();
			const source = connectionSender(sender, connection, id);
			const key = connectionKey(connection);
			if (pendingByConnection.has(key)) fail();
			const replayKey = consumedKey(connection);
			const prior = exactConsumed(
				await deps.session.get(replayKey),
				connection,
				deps.now(),
			);
			if (prior === "replay") fail();
			if (prior === "expired") await deps.session.delete(replayKey);

			const alias = approvalAlias(random);
			const expiresAt = deps.now() + ttlMs;
			const approvalUrl =
				`${origin}${APPROVAL_PAGE}#approval=${alias}`;
			pendingByConnection.add(key);
			let opened: unknown;
			try {
				opened = await deps.openApproval(approvalUrl);
			} catch {
				pendingByConnection.delete(key);
				throw new Error("Mailbox CLI approval could not open");
			}
			let approvalTabId: number;
			try {
				approvalTabId = safeTabId(
					(opened as { id?: unknown } | undefined)?.id,
				);
			} catch {
				pendingByConnection.delete(key);
				throw new Error("Mailbox CLI approval could not open");
			}

			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					const pending = pendingByAlias.get(alias);
					if (pending !== undefined) {
						remove(
							pending,
							new Error("Mailbox CLI approval timed out"),
						);
					}
				}, ttlMs);
				const pending: PendingApproval = {
					approvalAlias: alias,
					connection,
					connectionTabId: source.tabId,
					connectionFrameId: source.frameId,
					approvalTabId,
					expiresAt,
					timer,
					resolve,
					reject,
				};
				pendingByAlias.set(alias, pending);
			});
		},
		async inspect(alias, sender) {
			const pending = pendingByAlias.get(alias);
			if (
				disposed ||
				pending === undefined ||
				pending.expiresAt <= deps.now()
			) {
				fail();
			}
			approvalSender(sender, pending, origin, id);
			return Object.freeze({
				schemaVersion: 1,
				origin: pending.connection.origin,
				runAlias: pending.connection.runAlias,
				expiresAt: new Date(pending.expiresAt).toISOString(),
			});
		},
		async decide(alias, decision, sender) {
			const pending = pendingByAlias.get(alias);
			if (
				disposed ||
				pending === undefined ||
				pending.expiresAt <= deps.now()
			) {
				fail();
			}
			approvalSender(sender, pending, origin, id);
			if (decision === "deny") {
				remove(
					pending,
					new Error("Mailbox CLI approval was denied"),
				);
				return;
			}
			await deps.session.set(consumedKey(pending.connection), {
				origin: pending.connection.origin,
				expiresAt: deps.now() + CONSUMED_TTL_MS,
			});
			remove(pending);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			deps.tabsOnRemoved?.removeListener(onTabRemoved);
			for (const pending of [...pendingByAlias.values()]) {
				remove(
					pending,
					new Error("Mailbox CLI approval was closed"),
				);
			}
		},
	});
}
