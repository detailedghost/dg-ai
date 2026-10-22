/**
 * prototype-endpoint.ts — Copy into your dev server to handle variant selection.
 *
 * Express / Vite plugin (express-style):
 *   import { prototypeConfirmHandler } from './prototype-endpoint'
 *   app.post('/prototype-confirm', prototypeConfirmHandler)
 *
 * Bun.serve:
 *   import bunHandler from './prototype-endpoint'
 *   Bun.serve({ port: 3000, fetch: bunHandler.fetch })
 *   — or register the route inside an existing Bun.serve router.
 */

import { execSync } from "child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** Express / Vite dev-server handler. */
export async function prototypeConfirmHandler(req: any, res: any): Promise<void> {
	if (process.env.NODE_ENV === "production") {
		res.status(404).json({ error: "not found" });
		return;
	}

	const body: ConfirmBody = typeof req.body === "object" && req.body !== null ? req.body : await req.json();

	const sentinelPath = resolveSentinelPath(body.name);
	const protoDir = dirname(sentinelPath);
	mkdirSync(protoDir, { recursive: true });

	if (body.action === "reject") {
		const rejectContent = typeof body.notes === "string" && body.notes.length > 0 ? body.notes : "\n";
		writeFileSync(`${protoDir}/.reject`, rejectContent, "utf8");
		res.status(200).json({ ok: true });
		return;
	}

	if (!body.variants.includes(body.variant)) {
		res.status(400).json({ error: "unknown variant" });
		return;
	}

	// Write .notes BEFORE .selection: the selection file is the trigger `wait`
	// wakes on, so its sidecar must already be on disk (else notes are lost).
	if (typeof body.notes === "string" && body.notes.trim()) writeFileSync(`${protoDir}/.notes`, body.notes, "utf8");
	writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");

	res.status(200).json({ ok: true });
}

/** Bun.serve-compatible default export. */
export default {
	fetch: async (req: Request): Promise<Response> => {
		if (process.env.NODE_ENV === "production") {
			return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
		}

		let body: ConfirmBody;
		try {
			body = (await req.json()) as ConfirmBody;
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

		// Sidecar before trigger — see the Express handler above for why.
		if (typeof body.notes === "string" && body.notes.trim()) writeFileSync(`${protoDir}/.notes`, body.notes, "utf8");
		writeFileSync(sentinelPath, `${body.variant}\n`, "utf8");

		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	},
};
