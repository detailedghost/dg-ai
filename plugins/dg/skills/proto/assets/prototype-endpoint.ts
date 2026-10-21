import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ConfirmBody {
	name: string;
	variant: string;
	variants: string[];
	notes?: string;
	action?: "confirm" | "reject";
}

const CLI =
	process.env.DG_SKILLS_BIN ??
	join(process.env.HOME ?? "", ".dg", "bin", "dg-skills");

function resolveSentinelPath(name: string): string {
	const light = process.env.PROTOTYPE_LIGHT === "1" ? ["--light"] : [];
	try {
		return execFileSync(CLI, ["prototype", "path", name, ...light], {
			encoding: "utf8",
		}).trim();
	} catch {
		return join(process.cwd(), ".agents", "prototype", name, ".selection");
	}
}

function record(body: ConfirmBody): {
	status: number;
	body: Record<string, unknown>;
} {
	const sentinelPath = resolveSentinelPath(body.name);
	const protoDir = dirname(sentinelPath);
	mkdirSync(protoDir, { recursive: true });

	if (body.action === "reject") {
		const notes =
			typeof body.notes === "string" && body.notes.length > 0
				? body.notes
				: "\n";
		writeFileSync(join(protoDir, ".reject"), notes, "utf8");
		return { status: 200, body: { ok: true } };
	}
	if (!Array.isArray(body.variants) || !body.variants.includes(body.variant)) {
		return { status: 400, body: { error: "unknown variant" } };
	}
	if (typeof body.notes === "string" && body.notes.trim()) {
		writeFileSync(join(protoDir, ".notes"), body.notes, "utf8");
	}
	writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");
	return { status: 200, body: { ok: true } };
}

/** Express or Vite dev-server handler: `app.post("/prototype-confirm", prototypeConfirmHandler)`. */
export async function prototypeConfirmHandler(
	req: { body?: unknown; json?: () => Promise<unknown> },
	res: { status(code: number): { json(value: unknown): void } },
): Promise<void> {
	if (process.env.NODE_ENV === "production") {
		res.status(404).json({ error: "not found" });
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
