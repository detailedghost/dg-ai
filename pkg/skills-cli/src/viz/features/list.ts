import { existsSync, readdirSync, readFileSync } from "node:fs";
import { sessionUrl, vizConfig } from "../config";
import { note } from "../io";
import { computeBoardStatus, tokenFilePath } from "../respond-core";
import { portInUse } from "../server";

const UNANSWERED = "tbd";

export async function cmdList(): Promise<void> {
	const { pidFile, port, vizDir } = vizConfig();
	const serverUp = await portInUse();
	const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf-8").trim() : "—";
	note(`server :${port} ${serverUp ? `up (pid ${pid})` : "down"}`);

	const slugs = existsSync(vizDir)
		? readdirSync(vizDir).filter(
				(d) =>
					existsSync(`${vizDir}/${d}/payload.json`) &&
					existsSync(tokenFilePath(`${vizDir}/${d}`)),
			)
		: [];
	if (slugs.length === 0) {
		note("no sessions");
		return;
	}

	const rows = slugs.map((slug) => {
		const p = JSON.parse(
			readFileSync(`${vizDir}/${slug}/payload.json`, "utf-8"),
		) as {
			title?: string;
			template?: string;
			decisions?: { answer?: string }[];
			open_questions?: unknown[];
		};
		const pending =
			(p.decisions ?? []).filter((d) => !d.answer || d.answer === UNANSWERED)
				.length + (p.open_questions ?? []).length;
		return {
			slug,
			title: p.title ?? "",
			template: p.template ?? "?",
			pending,
			stale: existsSync(`${vizDir}/${slug}/.stale`),
			awaiting:
				computeBoardStatus(
					`${vizDir}/${slug}`,
					p as Record<string, unknown>,
				) === "awaiting",
			url: serverUp ? sessionUrl(slug) : "",
		};
	});
	process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}
