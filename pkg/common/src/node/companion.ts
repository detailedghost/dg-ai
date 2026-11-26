/// <reference path="../../../skills-cli/src/pw/playwright-registry.d.ts" />
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DgCliError } from "../errors";
import { type DgPaths, resolveDgPaths } from "./dg-paths";

export interface CompanionModules {
	pw: typeof import("playwright-core") & { registry: typeof import("playwright-core/lib/coreBundle").registry };
	db: { pg: typeof import("pg"); snowflake: typeof import("snowflake-sdk") };
}

export type CompanionName = keyof CompanionModules;

export interface CompanionOptions {
	external?: boolean;
	version?: string;
	paths?: Pick<DgPaths, "dataDir">;
	install?: (name: CompanionName, version: string) => Promise<string>;
}

export class CompanionMissing extends DgCliError {
	constructor(readonly companion: CompanionName, version: string) {
		super(`The ${companion} companion ${version} is not installed.`);
		this.name = "CompanionMissing";
	}
}

export const companionAssetName = (name: CompanionName, version: string): string => `dg-${name}-${version}.tar.zst`;

export function companionDir(paths: Pick<DgPaths, "dataDir">, name: CompanionName, version: string): string {
	return join(paths.dataDir, "companions", `${name}-${version}`);
}

const interop = <T extends object>(mod: T): T => (mod as { default?: T }).default ?? mod;

const direct: { [N in CompanionName]: () => Promise<CompanionModules[N]> } = {
	pw: async () => {
		const [pw, core] = await Promise.all([import("playwright-core"), import("playwright-core/lib/coreBundle")]);
		return { ...pw, registry: core.registry };
	},
	db: async () => {
		const [pg, snowflake] = await Promise.all([import("pg"), import("snowflake-sdk")]);
		return { pg: interop(pg), snowflake: interop(snowflake) };
	},
};

/** Compiled builds that leave the companions out define DG_COMPANIONS_EXTERNAL; every other run imports the packages directly. */
export async function loadCompanion<N extends CompanionName>(name: N, options: CompanionOptions = {}): Promise<CompanionModules[N]> {
	const external = options.external ?? process.env.DG_COMPANIONS_EXTERNAL === "1";
	if (!external) return direct[name]();
	const version = options.version ?? process.env.DG_BUILD_VERSION ?? "unknown";
	const entry = join(companionDir(options.paths ?? resolveDgPaths(), name, version), "index.js");
	if (!existsSync(entry)) {
		if (!options.install) throw new CompanionMissing(name, version);
		await options.install(name, version);
		if (!existsSync(entry)) throw new CompanionMissing(name, version);
	}
	return (await import(pathToFileURL(entry).href)) as CompanionModules[N];
}
