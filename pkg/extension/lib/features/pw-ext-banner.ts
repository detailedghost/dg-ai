/** Message a banner Stop click sends to the worker. */
export const PW_EXT_STOP_MESSAGE = "dg-pw-ext:stop";

const TITLE_MAX_CHARS = 40;
const SESSION_CHARS = 4;

/** The agent tab group title as plain text for the banner, or the short session id when the title is empty. */
export function bannerTitle({ title, sessionId }: { title: string; sessionId: string }): string {
	const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
	return (clean(title) || clean(sessionId).slice(0, SESSION_CHARS)).slice(0, TITLE_MAX_CHARS);
}

/** Self-contained isolated-world banner that says an agent drives the tab, with a Stop button; the text sits in a closed shadow root. */
export function pwExtBanner(show: boolean, title = ""): void {
	const KEY = "__dgPwExtBanner";
	const STOP = "dg-pw-ext:stop";
	const SVG = "http://www.w3.org/2000/svg";
	const CSS = `
.bn{all:initial;display:block;--panel:#fff;--ink:#0a0a0a;--muted:#52525b;--line:#0a0a0a;--accent:#0891b2;--accent2:#c026d3;--eyebrow:#0e7490;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;background:var(--panel);color:var(--ink);font:13px/1.4 var(--sans);border-bottom:.125rem solid var(--line)}
@media (prefers-color-scheme: dark){.bn{--panel:#111;--ink:#e8e8e8;--muted:#8a8a8a;--line:#e8e8e8;--accent:#00f0ff;--accent2:#ff2bd6;--eyebrow:#00f0ff}}
.row{display:flex;align-items:center;gap:12px;padding:6px 16px}
.gh{flex:none;color:var(--accent)}
.eb{flex:none;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;color:var(--eyebrow)}
.t{min-width:0;font-weight:700;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{min-width:0;flex-shrink:100;margin-left:auto;font:12px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stop{flex:none;cursor:pointer;margin:0;border:.125rem solid var(--line);border-radius:0;background:transparent;color:var(--ink);text-transform:uppercase;letter-spacing:.06em;font:600 12px var(--sans);padding:3px 12px;min-height:28px}
.stop:hover,.stop:focus-visible{background:var(--accent2);border-color:var(--accent2);color:#000;outline:none}
.stop:focus-visible{box-shadow:0 0 0 2px var(--panel),0 0 0 4px var(--accent2)}
.hz{height:6px;background:repeating-linear-gradient(-45deg,var(--accent) 0 8px,transparent 8px 16px);border-top:.125rem solid var(--line)}
@media (max-width:520px){.row{gap:8px;padding:6px 8px}.eb{display:none}.t{flex-shrink:0;font-size:12px;letter-spacing:0}}
@media (max-width:340px){.k{display:none}.t{flex-shrink:1}}
`;
	const slot = globalThis as unknown as Record<string, HTMLElement | undefined>;
	const existing = slot[KEY];
	if (!show) {
		existing?.remove();
		slot[KEY] = undefined;
		return;
	}
	if (existing?.isConnected) return;
	const host = document.createElement("dg-agent-banner");
	for (const [name, value] of [
		["position", "fixed"],
		["top", "0px"],
		["left", "0px"],
		["right", "0px"],
		["bottom", "auto"],
		["height", "auto"],
		["z-index", "2147483647"],
		["display", "block"],
		["margin", "0"],
		["padding", "0"],
		["border", "0"],
		["pointer-events", "auto"],
	])
		host.style.setProperty(name, value, "important");
	const root = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = CSS;
	const make = (tag: string, className: string, text = "") => {
		const element = document.createElement(tag);
		element.className = className;
		element.textContent = text;
		return element;
	};
	const svg = (tag: string, attributes: Record<string, string>) => {
		const element = document.createElementNS(SVG, tag);
		for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
		return element;
	};
	const ghost = svg("svg", { class: "gh", width: "20", height: "20", viewBox: "0 0 24 24", "aria-hidden": "true" });
	ghost.append(
		svg("path", { fill: "currentColor", d: "M4 22V11a8 8 0 0 1 16 0v11l-2.67-2.2L14.67 22 12 19.8 9.33 22l-2.66-2.2z" }),
		svg("circle", { cx: "9", cy: "11", r: "2.3", fill: "#fff" }),
		svg("circle", { cx: "15", cy: "11", r: "2.3", fill: "#fff" }),
		svg("circle", { cx: "9.6", cy: "11.4", r: "1.1", fill: "#0a0a0a" }),
		svg("circle", { cx: "15.6", cy: "11.4", r: "1.1", fill: "#0a0a0a" }),
	);
	const label = make("span", "k", title);
	label.title = title;
	const button = make("button", "stop", "Stop") as HTMLButtonElement;
	button.type = "button";
	button.addEventListener("click", (event) => {
		if (!event.isTrusted) return;
		host.remove();
		slot[KEY] = undefined;
		void chrome.runtime.sendMessage({ type: STOP });
	});
	const row = make("div", "row");
	row.setAttribute("role", "status");
	row.append(ghost, make("span", "eb", "DeeGee"), make("span", "t", "Agent is driving this tab"), label, button);
	const bar = make("div", "bn");
	bar.append(row, make("div", "hz"));
	root.append(style, bar);
	(document.body ?? document.documentElement).append(host);
	slot[KEY] = host;
}
