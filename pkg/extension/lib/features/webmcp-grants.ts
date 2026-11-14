import type { WebMcpGrantView } from "@dg/pages/chat-messages";
import { button, element } from "./dom";

const AREA_LABELS: Record<string, string> = {
	"area:mail": "mail (list and search)",
	"area:mail-body": "mail-body (read message bodies)",
};
const grantLabel = (tool: string) => (Object.hasOwn(AREA_LABELS, tool) ? (AREA_LABELS[tool] as string) : tool);

export const siteName = (site: string) => (site.startsWith("https://") ? site.slice("https://".length) : site);

export function parseWebMcpGrants(reply: unknown): WebMcpGrantView[] {
	const list = (reply as { grants?: unknown } | undefined)?.grants;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item): WebMcpGrantView[] => {
		const grant = (item ?? {}) as Record<string, unknown>;
		if (typeof grant.site !== "string" || typeof grant.tool !== "string") return [];
		if (grant.kind === "session" && typeof grant.sessionId === "string")
			return [{ kind: "session", sessionId: grant.sessionId, site: grant.site, tool: grant.tool }];
		if (grant.kind === "remembered" && typeof grant.expiresAt === "number")
			return [{ kind: "remembered", site: grant.site, tool: grant.tool, expiresAt: grant.expiresAt }];
		return [];
	});
}

export type WebMcpGrantRowOptions = {
	sessionLabel: (sessionId: string) => string;
	onRevoke: (grant: WebMcpGrantView) => Promise<void>;
};

export function webMcpGrantRow(
	doc: Document,
	grant: WebMcpGrantView,
	{ sessionLabel, onRevoke }: WebMcpGrantRowOptions,
): HTMLElement {
	const row = element(doc, "div", "drive");
	const line = element(doc, "div", "row");
	const identity = element(doc, "div", "grow");
	const who =
		grant.kind === "session"
			? sessionLabel(grant.sessionId)
			: `Remembered until ${new Date(grant.expiresAt).toISOString().slice(0, 10)}`;
	const scope = grant.kind === "session" ? "this session" : "30 days";
	const label = grantLabel(grant.tool);
	identity.append(element(doc, "b", "", label), element(doc, "div", "mono", `${siteName(grant.site)} · ${scope}`));
	identity.append(element(doc, "div", "mono", who));
	const revoke = button(doc, "btn btn-sm", "Revoke", () => {
		revoke.disabled = true;
		void onRevoke(grant).finally(() => {
			revoke.disabled = false;
		});
	});
	revoke.setAttribute("aria-label", `Revoke ${label} on ${siteName(grant.site)}, ${who}`);
	line.append(identity, revoke);
	row.append(line);
	return row;
}
