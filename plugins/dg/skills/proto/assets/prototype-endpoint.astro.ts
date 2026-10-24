import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { APIRoute } from "astro";

interface ConfirmBody {
	name: string;
	variant: string;
	variants: string[];
	notes?: string;
	action?: "confirm" | "reject";
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

export const POST: APIRoute = async ({ request }) => {
	if (import.meta.env.PROD) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	const refused = refusal((name) => request.headers.get(name));
	if (refused) {
		return Response.json({ error: refused.error }, { status: refused.status });
	}
	let body: ConfirmBody;
	try {
		body = (await request.json()) as ConfirmBody;
	} catch {
		return Response.json({ error: "invalid json" }, { status: 400 });
	}

	if (!validName(body?.name)) {
		return Response.json({ error: "invalid name" }, { status: 400 });
	}
	const sentinelPath = resolveSentinelPath(body.name);
	const protoDir = dirname(sentinelPath);
	mkdirSync(protoDir, { recursive: true });

	if (body.action === "reject") {
		const notes =
			typeof body.notes === "string" && body.notes.length > 0
				? body.notes
				: "\n";
		writeFileSync(join(protoDir, ".reject"), notes, "utf8");
		return Response.json({ ok: true });
	}
	if (!Array.isArray(body.variants) || !body.variants.includes(body.variant)) {
		return Response.json({ error: "unknown variant" }, { status: 400 });
	}
	if (typeof body.notes === "string" && body.notes.trim()) {
		writeFileSync(join(protoDir, ".notes"), body.notes, "utf8");
	}
	writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");
	return Response.json({ ok: true });
};
