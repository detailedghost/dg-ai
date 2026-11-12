import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { WORMHOLE_PINS, WORMHOLE_RELEASE_URL } from "../pkg/dg-agent/src/phone/wormhole";

async function hashAsset(asset: string): Promise<string> {
	const url = `${WORMHOLE_RELEASE_URL}${asset}`;
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`could not download ${url}: ${response.status}`);
	const hash = createHash("sha256");
	for await (const chunk of response.body) hash.update(chunk);
	return hash.digest("hex");
}

/** Lines of `<asset>: pinned <a>, downloaded <b>` for every asset whose hash differs. */
function pinDiff(pins: Readonly<Record<string, string>>, downloaded: ReadonlyMap<string, string>): string[] {
	return Object.entries(pins)
		.filter(([asset, pin]) => downloaded.get(asset) !== pin)
		.map(([asset, pin]) => `${asset}: pinned ${pin}, downloaded ${downloaded.get(asset) ?? "nothing"}`);
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({ args: Bun.argv.slice(2), options: { check: { type: "boolean" } } });
		const assets = Object.keys(WORMHOLE_PINS);
		const downloaded = new Map(await Promise.all(assets.map(async (asset) => [asset, await hashAsset(asset)] as const)));
		for (const [asset, sha256] of downloaded) console.log(`${sha256}  ${asset}`);
		const diff = pinDiff(WORMHOLE_PINS, downloaded);
		if (values.check && diff.length > 0) {
			for (const line of diff) console.error(line);
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
