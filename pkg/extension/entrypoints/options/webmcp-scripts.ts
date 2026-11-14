import { describeError, type WebMcpScriptRecord } from "@dg/common";
import { WEBMCP_MESSAGES, type WebMcpReply, type WebMcpScriptRow } from "@/lib/background/webmcp-scripts";
import { failStatus, flashStatus } from "@/lib/ui-helpers";

export const WEBMCP_UNAVAILABLE_NOTE =
	"Third-party scripts need Chrome 120 or newer and the Allow User Scripts toggle for dg-ai-extension on chrome://extensions (Developer mode before Chrome 138).";

export type MountWebMcpScriptsPanelOptions = {
	available: boolean;
	request?: (message: { type: string; [key: string]: unknown }) => Promise<unknown>;
};

type ChosenFile = { name: string; text(): Promise<string> };

function statusOf(record: WebMcpScriptRecord): "approved" | "needs approval" | "disabled" {
	if (record.approvedAt === undefined) return "needs approval";
	return record.enabled ? "approved" : "disabled";
}

export function mountWebMcpScriptsPanel(
	container: HTMLElement,
	{ available, request = (message) => browser.runtime.sendMessage(message) }: MountWebMcpScriptsPanelOptions,
): void {
	const doc = container.ownerDocument;

	async function call<T = void>(message: { type: string; [key: string]: unknown }): Promise<T> {
		const reply = (await request(message)) as WebMcpReply | undefined;
		if (!reply) throw new Error("The extension background did not answer");
		if (!reply.ok) throw new Error(reply.error);
		return reply.value as T;
	}

	function el<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		className?: string,
		text?: string,
	): HTMLElementTagNameMap[K] {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	const panel = el("div", "panel");
	panel.appendChild(el("h2", "sec-h", "Web MCP scripts"));
	panel.appendChild(
		el(
			"p",
			"note",
			"A script runs with your session on the matched sites, so add only code you trust. Third-party scripts must name their tools dg_<site>_<verb>.",
		),
	);

	const rows = el("div");
	panel.appendChild(rows);

	const status = el("div", "status");
	status.setAttribute("role", "status");

	async function run(change: () => Promise<void>, done: string): Promise<boolean> {
		try {
			await change();
			await render();
			flashStatus(status, done);
			return true;
		} catch (error) {
			failStatus(status, describeError(error));
			return false;
		}
	}

	function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
		const node = el("button", "btn", label);
		node.type = "button";
		node.disabled = disabled;
		node.addEventListener("click", onClick);
		return node;
	}

	function row(record: WebMcpScriptRow, code?: string): HTMLElement {
		const item = el("div", "mb-4");
		item.setAttribute("data-webmcp-row", record.id);
		item.appendChild(el("b", undefined, record.name));
		item.appendChild(el("p", "note", record.matches.join(", ")));
		if (record.problem !== undefined) {
			const problem = el("p", "note text-red-600", record.problem);
			problem.setAttribute("data-webmcp-problem", "");
			item.appendChild(problem);
		}

		if (record.source === "built-in") {
			const label = el("label", "lbl");
			const box = el("input");
			box.type = "checkbox";
			box.checked = record.enabled;
			box.addEventListener("change", () => {
				void run(() => call({ type: WEBMCP_MESSAGES.setEnabled, id: record.id, enabled: box.checked }), "Saved ✓");
			});
			label.appendChild(box);
			label.appendChild(doc.createTextNode(" Enabled"));
			item.appendChild(label);
			return item;
		}

		const state = statusOf(record);
		const meta = el("p", "note");
		const sha = el("code", undefined, record.sha256.slice(0, 12));
		sha.setAttribute("data-webmcp-sha", "");
		meta.append(sha, doc.createTextNode(` ${state}`));
		item.appendChild(meta);

		if (code !== undefined) {
			const view = el("pre", "field mb-2 overflow-auto", code);
			view.setAttribute("data-webmcp-code-view", "");
			view.tabIndex = 0;
			view.setAttribute("aria-label", `Code of ${record.name}`);
			item.appendChild(view);
		}

		const actions = el("div", "flex flex-wrap items-center gap-3");
		if (record.approvedAt === undefined) {
			actions.appendChild(
				button(
					"Approve",
					() => void run(() => call({ type: WEBMCP_MESSAGES.approve, id: record.id, sha256: record.sha256 }), "Approved ✓"),
					!available,
				),
			);
		} else {
			const enable = state === "disabled";
			actions.appendChild(
				button(
					enable ? "Enable" : "Disable",
					() => void run(() => call({ type: WEBMCP_MESSAGES.setEnabled, id: record.id, enabled: enable }), "Saved ✓"),
				),
			);
		}
		actions.appendChild(
			button("Remove", () => void run(() => call({ type: WEBMCP_MESSAGES.remove, id: record.id }), "Removed ✓")),
		);
		item.appendChild(actions);

		const replace = el("input", "field mt-2");
		replace.type = "file";
		replace.setAttribute("aria-label", `Replace code for ${record.name}`);
		replace.addEventListener("change", () => {
			const file = (replace.files as unknown as ChosenFile[] | null)?.[0];
			if (!file) return;
			void run(async () => call({ type: WEBMCP_MESSAGES.replace, id: record.id, code: await file.text() }), "Code replaced ✓");
		});
		item.appendChild(replace);
		return item;
	}

	async function render(): Promise<void> {
		const records = await call<WebMcpScriptRow[]>({ type: WEBMCP_MESSAGES.list });
		const views = await Promise.all(
			records.map((record) =>
				record.source !== "built-in" && record.approvedAt === undefined ? call<string | undefined>({ type: WEBMCP_MESSAGES.code, id: record.id }) : undefined,
			),
		);
		rows.replaceChildren(...records.map((record, index) => row(record, views[index])));
	}

	const form = el("form", "mt-6");
	form.appendChild(el("h3", "lbl", "Add a third-party script"));
	if (!available) form.appendChild(el("p", "note", WEBMCP_UNAVAILABLE_NOTE));

	const nameLabel = el("label", "lbl", "Name");
	const name = el("input", "field");
	name.type = "text";
	name.setAttribute("data-webmcp-name", "");
	nameLabel.appendChild(name);

	const sitesLabel = el("label", "lbl", "Sites (one match pattern per line)");
	const sites = el("textarea", "field");
	sites.rows = 3;
	sites.placeholder = "https://example.com/*";
	sites.setAttribute("data-webmcp-sites", "");
	sitesLabel.appendChild(sites);

	const codeLabel = el("label", "lbl", "Code");
	const code = el("textarea", "field");
	code.rows = 8;
	code.setAttribute("data-webmcp-code", "");
	codeLabel.appendChild(code);

	const fileLabel = el("label", "lbl", "Or choose a file");
	const file = el("input", "field");
	file.type = "file";
	file.setAttribute("data-webmcp-file", "");
	fileLabel.appendChild(file);

	let chosenName = "";
	file.addEventListener("change", () => {
		const chosen = (file.files as unknown as ChosenFile[] | null)?.[0];
		if (!chosen) return;
		chosenName = chosen.name;
		void chosen.text().then((text) => {
			code.value = text;
		});
	});

	async function add(): Promise<void> {
		const matches = sites.value
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const added = await run(
			async () => {
				await call({
					type: WEBMCP_MESSAGES.add,
					name: name.value.trim() || chosenName,
					matches,
					code: code.value,
					source: chosenName ? "file" : "paste",
				});
			},
			"Added. Approve it to run it.",
		);
		if (!added) return;
		name.value = "";
		sites.value = "";
		code.value = "";
		file.value = "";
		chosenName = "";
	}

	const addButton = button("Add script", () => void add());
	form.append(nameLabel, sitesLabel, codeLabel, fileLabel, addButton);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void add();
	});
	for (const control of [name, sites, code, file, addButton]) control.disabled = !available;

	panel.appendChild(form);
	panel.appendChild(status);
	container.appendChild(panel);
	void render();
}
