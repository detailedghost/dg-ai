import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { APIRoute } from "astro";
import type { BoardStatus } from "../../lib/respond-core.ts";
import { computeBoardStatus, tokenFilePath } from "../../lib/respond-core.ts";

/**
 * Mirror the CLI's status logic (the dg-skills viz list command) — file-direct, no write path.
 * VIZ_DIR intentionally kept local (not respond-core.ts's export): boards_api.test.ts
 * cache-busts this module by import URL to pick up a fresh VIZ_DIR per test, which only
 * re-evaluates this file's own top-level consts, not a separately-cached shared module.
 */
const VIZ_DIR = process.env.VIZ_DIR ?? `${process.env.AI_SCRATCH_DIR ?? "/tmp/ai"}/viz`;

const TBD = "tbd";

export type { BoardStatus };

export interface BoardSummary {
	slug: string;
	title: string;
	subtitle: string;
	template: string;
	status: BoardStatus;
	date: string;
	session_id: string;
	pending: number;
}

export const GET: APIRoute = () => {
	if (!existsSync(VIZ_DIR)) {
		return new Response(JSON.stringify([]), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			},
		});
	}

	// Real board = payload.json AND the .token render mints. Payload-only dirs are
	// staging artifacts (written before render namespaced elsewhere) — exclude the phantoms.
	const slugs = readdirSync(VIZ_DIR).filter(
		(d) => existsSync(`${VIZ_DIR}/${d}/payload.json`) && existsSync(tokenFilePath(`${VIZ_DIR}/${d}`)),
	);

	// One corrupt board's JSON must not take down the whole listing — skip it, keep the rest.
	const boards: BoardSummary[] = [];
	for (const slug of slugs) {
		let p: {
			title?: string;
			subtitle?: string;
			template?: string;
			date?: string;
			session_id?: string;
			decisions?: { answer?: string }[];
			open_questions?: unknown[];
		};
		try {
			const raw = readFileSync(`${VIZ_DIR}/${slug}/payload.json`, "utf-8");
			p = JSON.parse(raw);
		} catch {
			continue;
		}

		const pending =
			(p.decisions ?? []).filter((d) => !d.answer || d.answer === TBD).length + (p.open_questions ?? []).length;

		boards.push({
			slug,
			title: p.title ?? slug,
			subtitle: p.subtitle ?? "",
			template: p.template ?? "unknown",
			status: computeBoardStatus(`${VIZ_DIR}/${slug}`, p as Record<string, unknown>),
			date: p.date ?? "",
			session_id: p.session_id ?? "",
			pending,
		});
	}

	// Most recently created (alphabetical desc on slug is a reasonable proxy) first.
	boards.sort((a, b) => b.slug.localeCompare(a.slug));

	return new Response(JSON.stringify(boards), {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
};
