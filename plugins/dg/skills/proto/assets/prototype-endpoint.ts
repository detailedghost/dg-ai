import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ConfirmBody {
	name: string;
	variant: string;
	variants: string[];
	notes?: string;
	action?: "confirm" | "reject" | "status";
	selftest?: boolean;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			LOCAL_HOSTS.has(url.hostname)
		);
	} catch {
		return false;
	}
}

function refusal(
	header: (name: string) => string | null | undefined,
): { status: number; error: string } | undefined {
	const origin = header("origin");
	if (origin != null && !isLocalOrigin(origin))
		return { status: 403, error: "forbidden origin" };
	const site = header("sec-fetch-site");
	if (site !== "same-origin" && site !== "none")
		return { status: 403, error: "forbidden request" };
	const type = (header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	if (type !== "application/json")
		return { status: 415, error: "content type must be application/json" };
	return undefined;
}

function validName(name: unknown): name is string {
	return typeof name === "string" && NAME.test(name);
}

const CLI =
	process.env.DG_SKILLS_BIN ??
	join(process.env.HOME ?? "", ".dg", "bin", "dg-skills");

/** Pins sentinel resolution to the repo root, matching the agent's own cwd. */
function gitRoot(): string {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return process.cwd();
	}
}

function resolveSentinelPath(name: string): string {
	const light = process.env.PROTOTYPE_LIGHT === "1" ? ["--light"] : [];
	const cwd = gitRoot();
	try {
		return execFileSync(CLI, ["prototype", "path", name, ...light], {
			encoding: "utf8",
			cwd,
		}).trim();
	} catch {
		return join(cwd, ".agents", "prototype", name, ".selection");
	}
}

function record(body: ConfirmBody): {
	status: number;
	body: Record<string, unknown>;
} {
	if (!validName(body?.name)) {
		return { status: 400, body: { error: "invalid name" } };
	}
	const targetName = body.selftest ? `${body.name}-selftest` : body.name;
	const sentinelPath = resolveSentinelPath(targetName);
	const protoDir = dirname(sentinelPath);

	if (body.action === "status") {
		try {
			return {
				status: 200,
				body: { token: readFileSync(join(protoDir, ".reload"), "utf8").trim() },
			};
		} catch {
			return { status: 200, body: { token: "0" } };
		}
	}
	mkdirSync(protoDir, { recursive: true });

	if (body.action === "reject") {
		const notes =
			typeof body.notes === "string" && body.notes.length > 0
				? body.notes
				: "\n";
		writeFileSync(join(protoDir, ".source"), "browser\n", "utf8");
		writeFileSync(join(protoDir, ".reject"), notes, "utf8");
		return { status: 200, body: { ok: true } };
	}
	if (!Array.isArray(body.variants) || !body.variants.includes(body.variant)) {
		return { status: 400, body: { error: "unknown variant" } };
	}
	if (typeof body.notes === "string" && body.notes.trim()) {
		writeFileSync(join(protoDir, ".notes"), body.notes, "utf8");
	}
	writeFileSync(join(protoDir, ".source"), "browser\n", "utf8");
	writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");
	return { status: 200, body: { ok: true } };
}

/** Express or Vite dev-server handler: `app.post("/prototype-confirm", prototypeConfirmHandler)`. */
export async function prototypeConfirmHandler(
	req: {
		body?: unknown;
		json?: () => Promise<unknown>;
		headers?: Record<string, string | string[] | undefined>;
	},
	res: { status(code: number): { json(value: unknown): void } },
): Promise<void> {
	if (process.env.NODE_ENV === "production") {
		res.status(404).json({ error: "not found" });
		return;
	}
	const refused = refusal((name) => {
		const value = req.headers?.[name];
		return Array.isArray(value) ? value[0] : value;
	});
	if (refused) {
		res.status(refused.status).json({ error: refused.error });
		return;
	}
	const body = (
		typeof req.body === "object" && req.body !== null
			? req.body
			: await req.json?.()
	) as ConfirmBody;
	const result = record(body);
	res.status(result.status).json(result.body);
}

/** Bun.serve fetch handler: `Bun.serve({ fetch: bunHandler.fetch })`. */
export default {
	fetch: async (req: Request): Promise<Response> => {
		if (process.env.NODE_ENV === "production") {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		const refused = refusal((name) => req.headers.get(name));
		if (refused) {
			return Response.json({ error: refused.error }, { status: refused.status });
		}
		let body: ConfirmBody;
		try {
			body = (await req.json()) as ConfirmBody;
		} catch {
			return Response.json({ error: "invalid json" }, { status: 400 });
		}
		const result = record(body);
		return Response.json(result.body, { status: result.status });
	},
};
