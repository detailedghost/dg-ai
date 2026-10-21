import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";

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

export async function POST(req: NextRequest): Promise<NextResponse> {
	if (process.env.NODE_ENV === "production") {
		return NextResponse.json({ error: "not found" }, { status: 404 });
	}
	let body: ConfirmBody;
	try {
		body = (await req.json()) as ConfirmBody;
	} catch {
		return NextResponse.json({ error: "invalid json" }, { status: 400 });
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
		return NextResponse.json({ ok: true });
	}
	if (!Array.isArray(body.variants) || !body.variants.includes(body.variant)) {
		return NextResponse.json({ error: "unknown variant" }, { status: 400 });
	}
	if (typeof body.notes === "string" && body.notes.trim()) {
		writeFileSync(join(protoDir, ".notes"), body.notes, "utf8");
	}
	writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");
	return NextResponse.json({ ok: true });
}
