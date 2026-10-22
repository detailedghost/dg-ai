/**
 * prototype-endpoint.astro.ts — Astro API route for variant selection.
 *
 * Copy to: src/pages/api/prototype-confirm.ts in your Astro project.
 * It will be served at POST /api/prototype-confirm automatically.
 *
 * The PrototypeSwitcher.astro component POSTs to /prototype-confirm (no /api/
 * prefix) — adjust the fetch URL in PrototypeSwitcher.astro if your Astro
 * project uses a base path or you place this file elsewhere.
 */

import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { APIRoute } from "astro";

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
	try {
		// Throws if dg-skills is not on PATH — catch handles the fallback.
		return execSync(`~/.dg/bin/dg-skills prototype selection path ${name}${light}`, {
			encoding: "utf8",
		}).trim();
	} catch {
		return `${process.cwd()}/.agents/prototype/${name}/.selection`;
	}
}

export const POST: APIRoute = async ({ request }) => {
	// Astro sets import.meta.env.PROD at build time; this guard prevents the
	// endpoint from being callable in production static exports.
	if (import.meta.env.PROD) {
		return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
	}

	let body: ConfirmBody;
	try {
		body = (await request.json()) as ConfirmBody;
	} catch {
		return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
	}

	const sentinelPath = resolveSentinelPath(body.name);
	const protoDir = dirname(sentinelPath);
	mkdirSync(protoDir, { recursive: true });

	if (body.action === "reject") {
		const rejectContent = typeof body.notes === "string" && body.notes.length > 0 ? body.notes : "\n";
		writeFileSync(`${protoDir}/.reject`, rejectContent, "utf8");
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	if (!body.variants.includes(body.variant)) {
		return new Response(JSON.stringify({ error: "unknown variant" }), { status: 400 });
	}

	// Write .notes BEFORE .selection: the selection file is the trigger `wait`
	// wakes on, so its sidecar must already be on disk (else notes are lost).
	if (typeof body.notes === "string" && body.notes.trim()) writeFileSync(`${protoDir}/.notes`, body.notes, "utf8");
	writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");

	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
