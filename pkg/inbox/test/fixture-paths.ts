import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const config = await Bun.file(fixturePath("organizer.config.json")).json();
config.configHome = join(
	tmpdir(),
	`dg-inbox-fixture-config-${crypto.randomUUID()}`,
);
config.protonmail.dataPath = fixturePath("proton-dataset.json");
config.outlook.dataPath = fixturePath("outlook-dataset.json");
config.outlook.allowPlaintextTokenCache = false;
export const fixtureConfigPath = join(
	config.configHome,
	"organizer.config.json",
);
await Bun.write(fixtureConfigPath, JSON.stringify(config));
