import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const config = await Bun.file(fixturePath("organizer.config.json")).json();
const configHome = join(
	tmpdir(),
	`dg-inbox-fixture-config-${crypto.randomUUID()}`,
);
config.configHome = configHome;
config.protonmail.dataPath = fixturePath("proton-dataset.json");
config.outlook.dataPath = fixturePath("outlook-dataset.json");
config.outlook.allowPlaintextTokenCache = false;
export const fixtureConfigPath = join(configHome, "organizer.config.json");

export function writeFixtureConfig(): void {
	mkdirSync(configHome, { recursive: true });
	writeFileSync(fixtureConfigPath, JSON.stringify(config));
}

export function removeFixtureConfig(): void {
	rmSync(configHome, { recursive: true, force: true });
}
