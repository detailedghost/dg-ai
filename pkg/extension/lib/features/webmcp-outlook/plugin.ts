import { isDgToolName } from "@dg/common";
import { installModelContextShim, registerDgTool, type WebMcpTool } from "../webmcp-shim";
import { installOutlookHeaderObserver } from "./observer";
import { createOwaService } from "./service";
import { createOutlookTools } from "./tools";

const STARTED_KEY = Symbol.for("dg.webmcp.outlook");

/** Registers the tools only when the page lists no tool of its own; returns how many it registered. */
export async function registerOutlookTools(doc: Document, tools: WebMcpTool[]): Promise<number> {
	const existing = await installModelContextShim(doc).getTools();
	if (existing.some((tool) => !isDgToolName(tool.name))) return 0;
	const taken = new Set(existing.map((tool) => tool.name));
	const fresh = tools.filter((tool) => !taken.has(tool.name));
	for (const tool of fresh) registerDgTool(tool, doc);
	return fresh.length;
}

/** Installs the header observer at once and registers the Outlook tools after the page loads. */
export function startOutlookPlugin(host: Window & typeof globalThis): void {
	const slot = globalThis as unknown as Record<symbol, unknown>;
	if (slot[STARTED_KEY]) return;
	Object.defineProperty(slot, STARTED_KEY, { value: true, configurable: true });
	const pageFetch = host.fetch.bind(host);
	const observer = installOutlookHeaderObserver(host);
	const service = createOwaService({ location: host.location, fetch: pageFetch, headers: observer.getHeaders });
	const register = () => void registerOutlookTools(host.document, createOutlookTools(service)).catch(() => undefined);
	if (host.document.readyState === "complete") register();
	else host.addEventListener("load", register, { once: true });
}
