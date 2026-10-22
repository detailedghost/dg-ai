/**
 * prototype-endpoint.next.ts — Next.js App Router variant of the confirm endpoint.
 * Copy to app/prototype-confirm/route.ts in your Next.js project.
 *
 * POST /prototype-confirm
 *   Body: { name: string; variant: string; variants: string[] }
 *   Writes the chosen variant to the sentinel that `dg-skills prototype selection wait` watches.
 *   Dev-only: returns 404 in production.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type NextRequest, NextResponse } from "next/server";

const CLI = "~/.dg/bin/dg-skills";

interface ConfirmBody {
	name: string;
	variant: string;
	variants: string[];
	notes?: string;
	action?: "confirm" | "reject";
}

function resolveSentinelPath(name: string): string {
	// PROTOTYPE_LIGHT=1 must be exported by whoever launched this dev server so the
	// sentinel is written where `dg-skills prototype selection wait <name> --light` is watching.
	const light = process.env.PROTOTYPE_LIGHT === "1" ? " --light" : "";
	// Run dg-skills from the git root so the sentinel always lands at
	// <repo-root>/.agents/prototype/<name>/.selection regardless of which
	// package the Next.js server resolves process.cwd() to.
	let gitRoot: string;
	try {
		gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8", cwd: process.cwd() }).trim();
	} catch {
		gitRoot = process.cwd();
	}
	try {
		return execSync(`${CLI} prototype selection path ${name}${light}`, {
			encoding: "utf8",
			cwd: gitRoot,
		}).trim();
	} catch {
		// dg-skills not on PATH or not installed — fall back to the conventional location.
		return `${gitRoot}/.agents/prototype/${name}/.selection`;
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
		const rejectContent = typeof body.notes === "string" && body.notes.length > 0 ? body.notes : "\n";
		writeFileSync(`${protoDir}/.reject`, rejectContent, "utf8");
		return NextResponse.json({ ok: true });
	}

	if (!Array.isArray(body.variants) || !body.variants.includes(body.variant)) {
		return NextResponse.json({ error: "unknown variant" }, { status: 400 });
	}

	// Write .notes BEFORE .selection: the selection file is the trigger `wait`
	// wakes on, so its sidecar must already be on disk (else notes are lost).
	if (typeof body.notes === "string" && body.notes.trim()) {
		writeFileSync(`${protoDir}/.notes`, body.notes, "utf8");
	}
	writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");

	return NextResponse.json({ ok: true });
}
