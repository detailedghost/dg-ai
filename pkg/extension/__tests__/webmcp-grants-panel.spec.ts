import { afterEach, describe, expect, it } from "bun:test";
import { MSG, type WebMcpGrantView } from "@dg/pages/chat-messages";
import { Window } from "happy-dom";
import { mountWebMcpGrantsPanel, NO_WEBMCP_GRANTS } from "../entrypoints/options/webmcp-grants";

const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

const session: WebMcpGrantView = { kind: "session", sessionId: "abcdef123456", site: "https://live.com", tool: "dg_outlook_move" };
const remembered: WebMcpGrantView = { kind: "remembered", site: "https://live.com", tool: "dg_outlook_flag", expiresAt: Date.UTC(2026, 11, 13) };

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function mount(initial: WebMcpGrantView[], reply: unknown = { ok: true }, listReply?: unknown) {
	const window = new Window();
	windows.add(window);
	const container = window.document.createElement("div");
	window.document.body.appendChild(container);
	let grants = initial;
	const sent: Array<{ type: string; grant?: WebMcpGrantView }> = [];
	mountWebMcpGrantsPanel(container as unknown as HTMLElement, {
		request: async (message) => {
			sent.push(message);
			if (message.type === MSG.webmcpGrantsRequest) return listReply ?? { grants };
			if (message.type === MSG.webmcpRevoke) grants = grants.filter((grant) => grant.tool !== message.grant?.tool);
			if (message.type === MSG.webmcpRevokeAll) grants = [];
			return reply;
		},
	});
	return {
		container: container as unknown as HTMLElement,
		sent,
		window,
		setGrants: (next: WebMcpGrantView[]) => {
			grants = next;
		},
	};
}

function revokeButton(container: HTMLElement): HTMLElement {
	return container.querySelector('[aria-label^="Revoke dg_outlook_move"]') as unknown as HTMLElement;
}

function revokeAllButton(container: HTMLElement): HTMLElement {
	return [...container.querySelectorAll("button")].find((node) => node.textContent === "Revoke all") as unknown as HTMLElement;
}

describe("options Web MCP grants panel", () => {
	it("renders session and remembered grants like the popup rows", async () => {
		const { container } = mount([session, remembered]);
		await settle();

		expect([...container.querySelectorAll(".drive")].map((row) => row.textContent)).toEqual([
			"dg_outlook_movelive.com · this sessionabcdef12Revoke",
			"dg_outlook_flaglive.com · 30 daysRemembered until 2026-12-13Revoke",
		]);
		expect(container.querySelector("[data-webmcp-grants-empty]")?.hasAttribute("hidden")).toBe(true);
	});

	it("revoke sends the popup revoke message with that grant, then redraws", async () => {
		const { container, sent } = mount([session, remembered]);
		await settle();
		revokeButton(container).click();
		await settle();

		expect(sent.filter((message) => message.type === MSG.webmcpRevoke)).toEqual([{ type: MSG.webmcpRevoke, grant: session }]);
		expect(container.querySelectorAll(".drive")).toHaveLength(1);
	});

	it("Revoke all sends the revoke-all message and shows the empty state", async () => {
		const { container, sent } = mount([session, remembered]);
		await settle();
		revokeAllButton(container).click();
		await settle();

		expect(sent.filter((message) => message.type === MSG.webmcpRevokeAll)).toEqual([{ type: MSG.webmcpRevokeAll }]);
		expect(container.querySelectorAll(".drive")).toHaveLength(0);
		expect(container.textContent).toContain(NO_WEBMCP_GRANTS);
	});

	it("shows the empty state and no Revoke all when nothing is granted", async () => {
		const { container } = mount([]);
		await settle();

		expect(container.querySelector("[data-webmcp-grants-empty]")?.hasAttribute("hidden")).toBe(false);
		expect(revokeAllButton(container).hidden).toBe(true);
	});

	it("reloads the list when the page regains focus or the hash changes", async () => {
		const { container, window, setGrants } = mount([]);
		await settle();
		setGrants([session]);
		window.dispatchEvent(new window.Event("focus"));
		await settle();
		expect(container.querySelectorAll(".drive")).toHaveLength(1);

		setGrants([session, remembered]);
		window.location.hash = "mcp";
		await settle();
		expect(container.querySelectorAll(".drive")).toHaveLength(2);
	});

	it("reports a failed grant list instead of showing the empty state as truth", async () => {
		const { container } = mount([], { ok: true }, { ok: false, error: "Storage read failed." });
		await settle();

		expect(container.querySelector('[role="status"]')?.textContent).toBe("Storage read failed.");
		expect(container.querySelectorAll(".drive")).toHaveLength(0);
		expect(container.querySelector("[data-webmcp-grants-empty]")?.hasAttribute("hidden")).toBe(true);
	});

	it("shows a failed revoke", async () => {
		const { container } = mount([session], { ok: false, error: "Unknown Web MCP grant." });
		await settle();
		revokeButton(container).click();
		await settle();

		expect(container.querySelector('[role="status"]')?.textContent).toBe("Unknown Web MCP grant.");
	});
});
