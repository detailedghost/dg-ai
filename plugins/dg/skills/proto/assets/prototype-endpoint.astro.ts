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

export const POST: APIRoute = async ({ request }) => {
	if (import.meta.env.PROD) {
		return Response.json({ error: "not found" }, { status: 404 });
	}
	let body: ConfirmBody;
	try {
		body = (await request.json()) as ConfirmBody;
	} catch {
		return Response.json({ error: "invalid json" }, { status: 400 });
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
