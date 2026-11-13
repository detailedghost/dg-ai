import { createSerialQueue, type WebMcpApprovalClass } from "@dg/common";
import type { AgentTabsStorage } from "./agent-tabs";
import type { ApprovalAnswer, Approvals } from "./approval";
import { siteOf } from "./site-key";
import type { WebMcpSigner } from "./webmcp-signing";

/** One tool on one site, keyed by the registrable-domain site key that the pw --ext allowlist also uses. */
export type WebMcpGrant = { site: string; tool: string };
export type WebMcpSessionGrant = WebMcpGrant & { sessionId: string };
export type WebMcpRememberedGrant = WebMcpGrant & { approvedAt: number; expiresAt: number };

export const REMEMBER_DAYS = 30;
const REMEMBER_MS = REMEMBER_DAYS * 24 * 60 * 60 * 1000;
const REMEMBERED_KEY = "webmcpRemembered";
const MAC_PREFIX = "webmcp-grant:v1\n";
const ARGS_MAX_CHARS = 600;
const PREFIX = "webmcpGrants:";
const keyOf = (sessionId: string) => `${PREFIX}${sessionId}`;
const same = (a: WebMcpGrant, b: WebMcpGrant) => a.site === b.site && a.tool === b.tool;
const isGrant = (value: unknown): value is WebMcpGrant =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as WebMcpGrant).site === "string" &&
	typeof (value as WebMcpGrant).tool === "string";

/** Classes whose Allow may be kept for the session or remembered; read and each never store a grant. */
const GRANTABLE: ReadonlySet<WebMcpApprovalClass> = new Set(["session"]);

/** Session grants in storage.session; they end with the MCP session, not with pw --ext Stop. */
export function createWebMcpGrants({ storage }: { storage: AgentTabsStorage }) {
	const enqueue = createSerialQueue();
	const asking = new Map<string, Promise<ApprovalAnswer>>();

	async function read(sessionId: string): Promise<WebMcpGrant[]> {
		const stored = (await storage.session.get(keyOf(sessionId)))[keyOf(sessionId)];
		return Array.isArray(stored) ? stored.filter(isGrant) : [];
	}

	return {
		async has(sessionId: string, grant: WebMcpGrant): Promise<boolean> {
			return (await read(sessionId)).some((held) => same(held, grant));
		},

		add(sessionId: string, grant: WebMcpGrant): Promise<void> {
			return enqueue(async () => {
				const held = await read(sessionId);
				if (held.some((entry) => same(entry, grant))) return;
				await storage.session.set({ [keyOf(sessionId)]: [...held, { site: grant.site, tool: grant.tool }] });
			});
		},

		/** Shares one open question per session grant, so concurrent calls show one popup. */
		once(sessionId: string, grant: WebMcpGrant, ask: () => Promise<ApprovalAnswer>): Promise<ApprovalAnswer> {
			const key = JSON.stringify([sessionId, grant.site, grant.tool]);
			let pending = asking.get(key);
			if (!pending) {
				pending = ask();
				asking.set(key, pending);
				void pending.finally(() => asking.delete(key)).catch(() => undefined);
			}
			return pending;
		},

		async list(): Promise<WebMcpSessionGrant[]> {
			const stored = await storage.session.get(null);
			return Object.entries(stored).flatMap(([key, value]) =>
				key.startsWith(PREFIX) && Array.isArray(value)
					? value
							.filter(isGrant)
							.map((grant) => ({ sessionId: key.slice(PREFIX.length), site: grant.site, tool: grant.tool }))
					: [],
			);
		},

		revoke(sessionId: string, grant: WebMcpGrant): Promise<void> {
			return enqueue(async () => {
				const kept = (await read(sessionId)).filter((held) => !same(held, grant));
				if (kept.length) await storage.session.set({ [keyOf(sessionId)]: kept });
				else await storage.session.remove(keyOf(sessionId));
			});
		},

		/** Drops every grant of an ended session. */
		forget(sessionId: string): Promise<void> {
			return enqueue(() => storage.session.remove(keyOf(sessionId)));
		},

		forgetAll(): Promise<void> {
			return enqueue(async () => {
				for (const key of Object.keys(await storage.session.get(null)))
					if (key.startsWith(PREFIX)) await storage.session.remove(key);
			});
		},
	};
}

export type WebMcpGrants = ReturnType<typeof createWebMcpGrants>;

export type RememberStorage = {
	local: {
		get(keys: string): Promise<Record<string, unknown>>;
		set(items: Record<string, unknown>): Promise<void>;
	};
};

type StoredRemembered = WebMcpRememberedGrant & { mac: string };

const isStoredRemembered = (entry: unknown): entry is StoredRemembered =>
	isGrant(entry) &&
	Number.isSafeInteger((entry as StoredRemembered).approvedAt) &&
	Number.isSafeInteger((entry as StoredRemembered).expiresAt) &&
	typeof (entry as StoredRemembered).mac === "string";

/** 30-day grants in storage.local, signed with the extension's HMAC key so a content script cannot forge or extend one. */
export function createRememberedWebMcpGrants({
	storage,
	signer,
	now = Date.now,
}: {
	storage: RememberStorage;
	signer: WebMcpSigner;
	now?: () => number;
}) {
	const enqueue = createSerialQueue();
	const payload = (grant: WebMcpRememberedGrant) =>
		new TextEncoder().encode(MAC_PREFIX + JSON.stringify([grant.site, grant.tool, grant.approvedAt, grant.expiresAt]));

	async function live(): Promise<StoredRemembered[]> {
		const at = now();
		const value = (await storage.local.get(REMEMBERED_KEY))[REMEMBERED_KEY];
		const entries = Array.isArray(value) ? value.filter(isStoredRemembered) : [];
		const checks = await Promise.all(
			entries.map(
				async (entry) =>
					entry.expiresAt - entry.approvedAt === REMEMBER_MS &&
					entry.approvedAt <= at &&
					entry.expiresAt > at &&
					(await signer.verify(payload(entry), entry.mac).catch(() => false)),
			),
		);
		return entries.filter((_, index) => checks[index]);
	}

	return {
		async has(grant: WebMcpGrant): Promise<boolean> {
			return (await live()).some((entry) => same(entry, grant));
		},

		add(grant: WebMcpGrant): Promise<void> {
			return enqueue(async () => {
				const approvedAt = now();
				const record = { site: grant.site, tool: grant.tool, approvedAt, expiresAt: approvedAt + REMEMBER_MS };
				const mac = await signer.sign(payload(record));
				const kept = (await live()).filter((entry) => !same(entry, grant));
				await storage.local.set({ [REMEMBERED_KEY]: [...kept, { ...record, mac }] });
			});
		},

		async list(): Promise<WebMcpRememberedGrant[]> {
			return (await live()).map(({ site, tool, approvedAt, expiresAt }) => ({ site, tool, approvedAt, expiresAt }));
		},

		revoke(grant: WebMcpGrant): Promise<void> {
			return enqueue(async () => {
				const kept = (await live()).filter((entry) => !same(entry, grant));
				await storage.local.set({ [REMEMBERED_KEY]: kept });
			});
		},

		forgetAll(): Promise<void> {
			return enqueue(() => storage.local.set({ [REMEMBERED_KEY]: [] }));
		},
	};
}

export type RememberedWebMcpGrants = ReturnType<typeof createRememberedWebMcpGrants>;

function argsLine(args: Record<string, unknown>): string {
	const json = (JSON.stringify(args) ?? "{}").replace(
		/[\p{Cc}\p{Cf}]/gu,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	if (json.length <= ARGS_MAX_CHARS) return `Args: ${json}`;
	return `Args: ${json.slice(0, ARGS_MAX_CHARS)} (${json.length - ARGS_MAX_CHARS} more characters not shown)`;
}

const SCOPE_LINES: Record<Exclude<WebMcpApprovalClass, "read">, string> = {
	session: "Allow lets this agent use this tool on this site until its MCP session ends.",
	each: "This tool asks every time.",
};
const REMEMBER_LABEL = `Remember for ${REMEMBER_DAYS} days, for every agent session`;

/** Asks the person at the browser before a Web MCP tool runs; a remembered or session grant skips the question. */
export async function requestWebMcpApproval({
	approvals,
	grants,
	remembered,
	sessionId,
	agentIdentity,
	tool,
	args,
	origin,
	class: approvalClass,
}: {
	approvals: Pick<Approvals, "ask">;
	grants: WebMcpGrants;
	remembered: RememberedWebMcpGrants;
	sessionId: string;
	agentIdentity: string;
	tool: string;
	args: Record<string, unknown>;
	origin: string;
	class: WebMcpApprovalClass;
}): Promise<ApprovalAnswer> {
	if (approvalClass === "read") return "allow";
	const site = siteOf(origin);
	const grantable = GRANTABLE.has(approvalClass);
	const ask = () =>
		approvals.ask({
			title: `Allow ${tool} on ${site.name}?`,
			origin,
			lines: [`Agent: ${agentIdentity}`, `Tool: ${tool}`, argsLine(args), SCOPE_LINES[approvalClass]],
			...(grantable ? { remember: REMEMBER_LABEL } : {}),
		});
	if (!grantable) return (await ask()).answer;
	const grant = { site: site.key, tool };
	if ((await remembered.has(grant)) || (await grants.has(sessionId, grant))) return "allow";
	return grants.once(sessionId, grant, async () => {
		const { answer, remember } = await ask();
		if (answer !== "allow") return answer;
		await grants.add(sessionId, grant);
		if (remember) await remembered.add(grant).catch(() => undefined);
		return answer;
	});
}
