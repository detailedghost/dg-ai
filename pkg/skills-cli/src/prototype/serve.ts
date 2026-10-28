import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { resolveSkillAsset } from "../utils/skill-assets";
import { injectScript } from "./inject";
import { protoDir, type SentinelPaths, sentinelPaths } from "./paths";
import { writeSentinel } from "./sentinels";

const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="54" font-size="80" text-anchor="middle" dominant-baseline="central">✏️</text></svg>',
)}">`;

const DEFAULT_PORT = 4321;
const PORT_ATTEMPTS = 10;
const IDLE_CHECK_MS = 5000;

export interface ServeOptions {
	htmlFile: string;
	name: string;
	paths: SentinelPaths;
	port?: number;
	idleSec?: number;
	tools: unknown;
	onIdle?: () => void;
}

export interface RunningServer {
	port: number;
	stop(): void;
}

export function injectIntoHtml(
	raw: string,
	name: string,
	tools: unknown,
): string {
	const icons = `<script>\n${sharedIcons()}</script>\n`;
	const script = injectScript(name, tools);
	const head = raw.includes("<head>")
		? raw.replace("<head>", `<head>\n${FAVICON_LINK}\n${icons}`)
		: raw;
	const tail = raw.includes("<head>") ? script : icons + script;
	return head.includes("</body>")
		? head.replace("</body>", `${tail}</body>`)
		: head + tail;
}

let iconsSource: string | undefined;

/** The icon set /dg:proto and /dg:verify share, so both toolbars draw the same glyphs. */
function sharedIcons(): string {
	iconsSource ??= readFileSync(resolveSkillAsset("proto", join("assets", "dg-icons.js")), "utf8");
	return iconsSource;
}

async function findPort(start: number): Promise<number> {
	for (let port = start; port < start + PORT_ATTEMPTS; port++) {
		try {
			Bun.listen({
				hostname: "127.0.0.1",
				port,
				socket: { data() {}, open() {}, close() {}, error() {} },
			}).stop(true);
			return port;
		} catch {
			continue;
		}
	}
	throw new Error(
		`No free port found in range ${start}-${start + PORT_ATTEMPTS - 1}`,
	);
}

function readToken(paths: SentinelPaths): string {
	try {
		return readFileSync(paths.reload, "utf8").trim();
	} catch {
		return "0";
	}
}

function decisionState(paths: SentinelPaths): string {
	if (existsSync(paths.selection)) return "approved";
	if (existsSync(paths.reject)) return "rejected";
	try {
		const parsed: unknown = JSON.parse(readFileSync(paths.decision, "utf8"));
		const decision =
			parsed && typeof parsed === "object" && "decision" in parsed
				? parsed.decision
				: undefined;
		if (decision === "APPROVED" || decision === "REWORK")
			return decision.toLowerCase();
	} catch {
		return "pending";
	}
	return "pending";
}

function readChanges(paths: SentinelPaths): Response {
	try {
		const raw = readFileSync(paths.changes, "utf8");
		JSON.parse(raw);
		return new Response(raw, {
			headers: { "Content-Type": "application/json" },
		});
	} catch {
		return Response.json({});
	}
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function recordDecision(
	paths: SentinelPaths,
	body: Record<string, unknown>,
): Response {
	const target =
		body.selftest === true ? sentinelPaths(`${paths.dir}-selftest`) : paths;
	mkdirSync(target.dir, { recursive: true });
	if (body.decision) {
		const decision = text(body.decision).toUpperCase();
		if (decision !== "APPROVED" && decision !== "REWORK")
			return Response.json(
				{ error: 'decision must be "APPROVED" or "REWORK"' },
				{ status: 400 },
			);
		writeSentinel(target.source, "browser\n");
		writeSentinel(
			target.decision,
			`${JSON.stringify({ decision, notes: text(body.notes) })}\n`,
		);
		return Response.json({ ok: true });
	}
	const action = (text(body.action) || "confirm").toLowerCase();
	if (action !== "confirm" && action !== "reject")
		return Response.json(
			{ error: 'action must be "confirm" or "reject"' },
			{ status: 400 },
		);
	const notes = text(body.notes);
	if (action === "reject") {
		writeSentinel(target.source, "browser\n");
		writeSentinel(target.reject, notes || "\n");
		return Response.json({ ok: true });
	}
	const variant = text(body.variant);
	if (!variant)
		return Response.json(
			{ error: "variant is required for confirm" },
			{ status: 400 },
		);
	if (Array.isArray(body.variants) && !body.variants.includes(variant))
		return Response.json(
			{ error: `variant "${variant}" not in allowed list` },
			{ status: 400 },
		);
	if (notes) writeSentinel(target.notes, notes);
	writeSentinel(target.source, "browser\n");
	writeSentinel(target.selection, `${variant}\n`);
	return Response.json({ ok: true });
}

function rejectCrossSite(req: Request, port: number): Response | undefined {
	const origin = req.headers.get("origin");
	if (
		origin !== null &&
		origin !== `http://localhost:${port}` &&
		origin !== `http://127.0.0.1:${port}`
	)
		return Response.json({ error: "Forbidden origin" }, { status: 403 });
	const site = req.headers.get("sec-fetch-site");
	if (site !== "same-origin" && site !== "none")
		return Response.json({ error: "Forbidden request" }, { status: 403 });
	const type = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase();
	if (type !== "application/json")
		return Response.json(
			{ error: "Content-Type must be application/json" },
			{ status: 415 },
		);
	return undefined;
}

/** Serve one self-contained prototype page and its decision endpoints; the sentinel directory is fixed by the caller. */
export async function startServer(
	options: ServeOptions,
): Promise<RunningServer> {
	const { htmlFile, name, paths, tools } = options;
	const port = await findPort(options.port ?? DEFAULT_PORT);
	let lastActivity = Date.now();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req) {
			const url = new URL(req.url);
			const host = (req.headers.get("host") ?? "").split(":")[0];
			if (host !== "localhost" && host !== "127.0.0.1")
				return new Response("Forbidden", { status: 403 });

			if (req.method === "POST" && url.pathname === "/prototype-decision") {
				const refusal = rejectCrossSite(req, port);
				if (refusal) return refusal;
				lastActivity = Date.now();
				let body: unknown;
				try {
					body = await req.json();
				} catch {
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				}
				if (!body || typeof body !== "object" || Array.isArray(body))
					return Response.json({ error: "Invalid JSON" }, { status: 400 });
				return recordDecision(paths, body as Record<string, unknown>);
			}
			if (req.method !== "GET")
				return new Response("Method Not Allowed", { status: 405 });
			if (url.pathname === "/prototype-state")
				return Response.json(
					{ status: decisionState(paths) },
					{ headers: { "Cache-Control": "no-store" } },
				);
			if (url.pathname === "/prototype-reload")
				return Response.json({ token: readToken(paths) });
			if (url.pathname === "/prototype-changes") return readChanges(paths);
			try {
				return new Response(
					injectIntoHtml(readFileSync(htmlFile, "utf8"), name, tools),
					{ headers: { "Content-Type": "text/html; charset=utf-8" } },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return new Response(`Cannot read file: ${message}`, { status: 500 });
			}
		},
	});

	const idleSec = options.idleSec ?? 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		if (timer) clearInterval(timer);
		server.stop(true);
	};
	if (idleSec > 0) {
		const reloadMtime = () => {
			try {
				return statSync(paths.reload).mtimeMs;
			} catch {
				return 0;
			}
		};
		timer = setInterval(
			() => {
				if (
					Date.now() - Math.max(lastActivity, reloadMtime()) >
					idleSec * 1000
				) {
					stop();
					options.onIdle?.();
				}
			},
			Math.min(IDLE_CHECK_MS, idleSec * 1000),
		);
	}
	return { port, stop };
}

const SERVE_USAGE =
	"Usage: prototype serve <html-file> <name> [--light] [--port=PORT] [--idle=SEC] [--dir=PATH]\n";

interface ServeArgs {
	htmlFile: string;
	name: string;
	light: boolean;
	port: number;
	idleSec: number;
	dir?: string;
}

function intFlag(
	arg: string,
	prefix: string,
	min: number,
	max: number,
): number {
	const value = Number.parseInt(arg.slice(prefix.length), 10);
	if (Number.isNaN(value) || value < min || value > max)
		throw new Error(`invalid value: ${arg}`);
	return value;
}

function parseServeArgs(argv: string[]): ServeArgs | undefined {
	const [htmlFile, name, ...rest] = argv;
	if (!htmlFile || !name) return undefined;
	const parsed: ServeArgs = {
		htmlFile,
		name,
		light: false,
		port: DEFAULT_PORT,
		idleSec: 0,
	};
	for (const arg of rest) {
		if (arg === "--light") parsed.light = true;
		else if (arg.startsWith("--port="))
			parsed.port = intFlag(arg, "--port=", 1, 65535);
		else if (arg.startsWith("--idle="))
			parsed.idleSec = intFlag(arg, "--idle=", 0, Number.MAX_SAFE_INTEGER);
		else if (arg.startsWith("--dir=")) parsed.dir = arg.slice("--dir=".length);
		else throw new Error(`Unknown option: ${arg}`);
	}
	return parsed;
}

function webmcpTools(): unknown {
	const file = resolveSkillAsset("proto", join("assets", "webmcp-tools.json"));
	return (JSON.parse(readFileSync(file, "utf8")) as { tools: unknown }).tools;
}

/** Run the long-lived serve process; resolves once it is listening and the event loop keeps it alive. */
export async function runServe(argv: string[]): Promise<number | undefined> {
	if (argv.includes("--help")) {
		process.stdout.write(SERVE_USAGE);
		return 0;
	}
	const args = parseServeArgs(argv);
	if (!args) {
		process.stderr.write(SERVE_USAGE);
		return 1;
	}
	const dir =
		args.dir ?? protoDir(args.name, { cwd: process.cwd(), light: args.light });
	const running = await startServer({
		htmlFile: args.htmlFile,
		name: args.name,
		paths: sentinelPaths(dir),
		port: args.port,
		idleSec: args.idleSec,
		tools: webmcpTools(),
		onIdle: () => process.exit(0),
	});
	process.stdout.write(
		`prototype-serve: http://127.0.0.1:${running.port}/\n  html  : ${args.htmlFile}\n  name  : ${args.name}${args.light ? " (--light)" : ""}\n  Press Ctrl-C to stop.\n`,
	);
	return undefined;
}
