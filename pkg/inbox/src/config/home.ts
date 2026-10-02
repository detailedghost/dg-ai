import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../utils/json";
import type { RouteProfileConfig } from "./types";

export type ConfigHomeSeed = {
	routeProfilesPath: string;
	mappingsPath: string;
	securityPath: string;
	created: string[];
};

export async function loadRouteProfiles(
	configHome: string,
): Promise<Record<string, RouteProfileConfig>> {
	const file = Bun.file(routeProfilesPath(configHome));
	if (!(await file.exists())) {
		return {};
	}
	const parsed = routeProfilesFileSchema.parse(
		await readJsonFile(routeProfilesPath(configHome)),
	);
	return parsed.routeProfiles ?? {};
}

export async function ensureConfigHome(
	configHome: string,
): Promise<ConfigHomeSeed> {
	await Bun.$`mkdir -p ${configHome}`.quiet();
	const created: string[] = [];
	await seedJson(
		routeProfilesPath(configHome),
		{ kind: "route-profiles", id: nanoid(), routeProfiles: {} },
		created,
	);
	await seedJson(
		join(configHome, "mappings.json"),
		{ kind: "mappings", id: nanoid(), mappings: {} },
		created,
	);
	await seedJson(
		join(configHome, "security.json"),
		{ kind: "security", id: nanoid(), security: {} },
		created,
	);
	return {
		routeProfilesPath: routeProfilesPath(configHome),
		mappingsPath: join(configHome, "mappings.json"),
		securityPath: join(configHome, "security.json"),
		created,
	};
}

function routeProfilesPath(configHome: string): string {
	return join(configHome, "route-profiles.json");
}

async function seedJson(
	path: string,
	value: unknown,
	created: string[],
): Promise<void> {
	const file = Bun.file(path);
	if (await file.exists()) {
		return;
	}
	await Bun.$`mkdir -p ${dirname(path)}`.quiet();
	await writeJsonFile(path, value);
	created.push(path);
}

const routeRuleSchema = z.object({
	domain: z.string().min(1),
	subjectContains: z.array(z.string().min(1)).default([]),
});

const routeProfileSchema = z.object({
	folderName: z.string().min(1),
	filterName: z.string().min(1),
	domainFilters: z.array(z.string().min(1)).default([]),
	subjectDomainFilters: z.array(routeRuleSchema).default([]),
});

const routeProfilesFileSchema = z.object({
	routeProfiles: z.record(z.string(), routeProfileSchema).default({}),
});
