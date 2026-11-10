import { createSerialQueue, type WebMcpApprovalClass } from "@dg/common";
import type { AgentTabsStorage } from "./agent-tabs";
import type { ApprovalAnswer, Approvals } from "./approval";

/** One tool on one origin in one agent tab group, approved by the person for a dg session. */
export type WebMcpGrant = { origin: string; tool: string; groupId: number };

const ARGS_MAX_CHARS = 600;
const keyOf = (sessionId: string) => `webmcpGrants:${sessionId}`;
const same = (a: WebMcpGrant, b: WebMcpGrant) =>
	a.origin === b.origin && a.tool === b.tool && a.groupId === b.groupId;

/** Session grants in storage.session; a grant matches only in the tab group it was given in. */
export function createWebMcpGrants({ storage }: { storage: AgentTabsStorage }) {
	const enqueue = createSerialQueue();

	async function read(sessionId: string): Promise<WebMcpGrant[]> {
		const stored = (await storage.session.get(keyOf(sessionId)))[keyOf(sessionId)];
		return Array.isArray(stored) ? (stored as WebMcpGrant[]) : [];
	}

	return {
		async has(sessionId: string, grant: WebMcpGrant): Promise<boolean> {
			return (await read(sessionId)).some((held) => same(held, grant));
		},

		add(sessionId: string, grant: WebMcpGrant): Promise<void> {
			return enqueue(async () => {
				const held = await read(sessionId);
				if (held.some((entry) => same(entry, grant))) return;
				await storage.session.set({ [keyOf(sessionId)]: [...held, grant] });
			});
		},
	};
}

export type WebMcpGrants = ReturnType<typeof createWebMcpGrants>;

function argsLine(args: Record<string, unknown>): string {
	const json = (JSON.stringify(args) ?? "{}").replace(
		/[\p{Cc}\p{Cf}]/gu,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	if (json.length <= ARGS_MAX_CHARS) return `Args: ${json}`;
	return `Args: ${json.slice(0, ARGS_MAX_CHARS)} (${json.length - ARGS_MAX_CHARS} more characters not shown)`;
}

const SCOPE_LINES: Record<Exclude<WebMcpApprovalClass, "read">, string> = {
	session: "Allow once to let this agent use this tool on this site until its tab group closes.",
	each: "This tool asks every time.",
};

/** Asks the person at the browser before a dg tool runs; a session grant skips the question in its own tab group. */
export async function requestWebMcpApproval({
	approvals,
	grants,
	sessionId,
	agentIdentity,
	tool,
	args,
	origin,
	groupId,
	class: approvalClass,
}: {
	approvals: Pick<Approvals, "request">;
	grants: WebMcpGrants;
	sessionId: string;
	agentIdentity: string;
	tool: string;
	args: Record<string, unknown>;
	origin: string;
	groupId: number;
	class: WebMcpApprovalClass;
}): Promise<ApprovalAnswer> {
	if (approvalClass === "read") return "allow";
	const grouped = groupId >= 0;
	const scope = approvalClass === "session" && grouped ? "session" : "each";
	const grant = { origin, tool, groupId };
	if (scope === "session" && (await grants.has(sessionId, grant))) return "allow";
	const answer = await approvals.request({
		title: `Allow ${tool} on ${origin}?`,
		origin,
		lines: [`Agent: ${agentIdentity}`, `Tool: ${tool}`, argsLine(args), SCOPE_LINES[scope]],
	});
	if (answer === "allow" && scope === "session") await grants.add(sessionId, grant);
	return answer;
}
