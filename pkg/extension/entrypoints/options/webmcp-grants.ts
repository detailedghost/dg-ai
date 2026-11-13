import { describeError } from "@dg/common";
import { MSG, type WebMcpGrantView } from "@dg/pages/chat-messages";
import { button, element } from "@/lib/features/dom";
import { parseWebMcpGrants, webMcpGrantRow } from "@/lib/features/webmcp-grants";

export const NO_WEBMCP_GRANTS = "No Web MCP grants. Agents ask before a tool runs.";

export type MountWebMcpGrantsPanelOptions = {
	request?: (message: { type: string; grant?: WebMcpGrantView }) => Promise<unknown>;
};

export function mountWebMcpGrantsPanel(
	container: HTMLElement,
	{ request = (message) => browser.runtime.sendMessage(message) }: MountWebMcpGrantsPanelOptions = {},
): void {
	const doc = container.ownerDocument;
	const panel = element(doc, "div", "panel");
	panel.setAttribute("data-webmcp-grants", "");
	const list = element(doc, "div");
	const empty = element(doc, "p", "note", NO_WEBMCP_GRANTS);
	empty.setAttribute("data-webmcp-grants-empty", "");
	empty.hidden = true;
	const status = element(doc, "div", "status err");
	status.setAttribute("role", "status");

	async function render(): Promise<void> {
		const reply = await request({ type: MSG.webmcpGrantsRequest });
		const failure = reply as { ok?: unknown; error?: unknown } | undefined;
		if (!reply || failure?.ok === false)
			throw new Error(typeof failure?.error === "string" ? failure.error : "The extension background did not answer");
		const grants = parseWebMcpGrants(reply);
		list.replaceChildren(
			...grants.map((grant) =>
				webMcpGrantRow(doc, grant, {
					sessionLabel: (sessionId) => sessionId.slice(0, 8),
					onRevoke: (picked) => revoke({ type: MSG.webmcpRevoke, grant: picked }),
				}),
			),
		);
		empty.hidden = grants.length > 0;
		revokeAll.hidden = grants.length === 0;
	}

	async function revoke(message: { type: string; grant?: WebMcpGrantView }): Promise<void> {
		try {
			const reply = (await request(message)) as { ok?: unknown; error?: unknown } | undefined;
			status.textContent = reply?.ok === true ? "" : typeof reply?.error === "string" ? reply.error : "The extension background did not answer";
			await render();
		} catch (error) {
			status.textContent = describeError(error);
		}
	}

	const revokeAll = button(doc, "btn", "Revoke all", () => void revoke({ type: MSG.webmcpRevokeAll }));
	revokeAll.hidden = true;

	panel.append(
		element(doc, "h2", "sec-h", "Web MCP grants"),
		element(doc, "p", "note", "Tools an agent may run without asking again. Session grants end with the agent session. Remembered grants last 30 days."),
		list,
		empty,
		revokeAll,
		status,
	);
	container.appendChild(panel);
	const refresh = () => {
		status.textContent = "";
		void render().catch((error: unknown) => {
			status.textContent = describeError(error);
		});
	};
	const win = doc.defaultView;
	win?.addEventListener("focus", refresh);
	win?.addEventListener("hashchange", refresh);
	refresh();
}
