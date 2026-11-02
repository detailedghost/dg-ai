import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPages } from "../build";

const dist = join(import.meta.dir, "../dist");
const daemonEntry = join(import.meta.dir, "../../dg-daemon/src/index.ts");
const FORBIDDEN = ["kokoro", "playwright"];

let bundle = "";

beforeAll(async () => {
	await buildPages();
	const result = await Bun.build({
		entrypoints: [daemonEntry],
		target: "bun",
		minify: false,
	});
	expect(result.success).toBe(true);
	bundle = (
		await Promise.all(result.outputs.map((output) => output.text()))
	).join("\n");
}, 60_000);

function plainMarker(file: string): string {
	const text = readFileSync(join(dist, file), "utf8");
	const marker = text
		.match(/[^"'`\\\r\n$\u0080-\uffff]{40,}/g)
		?.sort((a, b) => b.length - a.length)
		.at(0);
	if (marker === undefined) throw new Error(`no plain run in ${file}`);
	return marker.slice(0, 60);
}

test("the daemon chunk embeds the built chat and board page assets", () => {
	for (const file of ["chat.html", "board.html", "chat.js", "board.js"]) {
		expect({ file, found: bundle.includes(plainMarker(file)) }).toEqual({
			file,
			found: true,
		});
	}
});

test("the daemon chunk includes none of the forbidden heavy dependencies", () => {
	const lowered = bundle.toLowerCase();
	const matched = FORBIDDEN.filter((name) => lowered.includes(name));
	expect(matched).toEqual([]);
});
