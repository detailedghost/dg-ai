import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");
export const OPTIONS_CSS = join(root, "../extension/entrypoints/options/style.css");

const PAGES = [
	{
		name: "chat",
		title: "DeeGee - Chat",
		entry: "src/chat/page.ts",
		css: "src/chat/style.css",
	},
	{
		name: "board",
		title: "DeeGee | Overwatch",
		entry: "src/board/page.ts",
		css: "src/board/style.css",
	},
] as const;

const DECLARATION = "declare const script: string;\nexport default script;\n";

function minifyCss(css: string): string {
	return css
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{};,>])\s*/g, "$1")
		.trim();
}

async function themeTokens(): Promise<string> {
	const source = await Bun.file(OPTIONS_CSS).text();
	const tokens = source
		.slice(0, source.indexOf("@layer"))
		.replace('@import "tailwindcss";', "");
	const preflight = await Bun.file(
		Bun.resolveSync("tailwindcss/preflight.css", root),
	).text();
	return `${preflight}\n${tokens}`;
}

function renderHtml(title: string, name: string, css: string): string {
	return [
		"<!doctype html>",
		'<html lang="en"><head><meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`<title>${title}</title><style>${css}</style></head>`,
		`<body><div id="app"></div><script src="/${name}.js"></script></body></html>`,
	].join("");
}

/** Writes dist/{chat,board}.{html,js}; the daemon embeds all four as text. */
export async function buildPages(): Promise<void> {
	mkdirSync(dist, { recursive: true });
	const staging = mkdtempSync(join(root, ".dist-"));
	try {
		await buildInto(staging);
		for (const file of readdirSync(staging)) {
			renameSync(join(staging, file), join(dist, file));
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

async function buildInto(outdir: string): Promise<void> {
	const tokens = await themeTokens();
	for (const page of PAGES) {
		const result = await Bun.build({
			entrypoints: [join(root, page.entry)],
			format: "iife",
			target: "browser",
			minify: true,
			outdir,
			naming: `${page.name}.js`,
		});
		if (!result.success) {
			throw new AggregateError(result.logs, `The ${page.name} page build failed.`);
		}
		const pageCss = await Bun.file(join(root, page.css)).text();
		await Bun.write(
			join(outdir, `${page.name}.html`),
			renderHtml(page.title, page.name, minifyCss(`${tokens}\n${pageCss}`)),
		);
		await Bun.write(join(outdir, `${page.name}.d.ts`), DECLARATION);
		await Bun.write(join(outdir, `${page.name}.d.html.ts`), DECLARATION);
	}
}

if (import.meta.main) await buildPages();
