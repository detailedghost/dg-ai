import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import pkg from "../package.json" with { type: "json" };
import {
	FIXTURE_ENTRIES,
	narrationZipName,
	sha256,
	storedZip,
} from "./demo-narration-fixtures";

export function releaseFetch(): typeof fetch {
	const name = narrationZipName(pkg.version);
	const zip = storedZip(FIXTURE_ENTRIES);
	const sums = `${sha256(zip)}  ${name}\n`;
	return (async (input: unknown) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.endsWith("SHA256SUMS")) return new Response(sums);
		if (url.endsWith(name)) return new Response(new Blob([zip]));
		return new Response("missing", { status: 404 });
	}) as unknown as typeof fetch;
}

export function isolatedHome(): { dir: string; restore(): void } {
	const dir = mkdtempSync(join(tmpdir(), "dg-narration-route-"));
	const previous = { HOME: process.env.HOME, DG_HOME: process.env.DG_HOME };
	mkdirSync(join(dir, "state"), { recursive: true });
	process.env.HOME = dir;
	process.env.DG_HOME = join(dir, "state");
	resolveDgPaths();
	return {
		dir,
		restore() {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}
