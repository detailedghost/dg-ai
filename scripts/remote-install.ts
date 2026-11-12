import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { linkCurrent, readCurrent } from "../pkg/skills-cli/src/install/current";
import { withInstallLock } from "../pkg/common/src/node/install-lock";

/** Installs a local build as `lib/<version>` under the install-root lock and prunes older builds of `base`. */
export async function installLocal(root: string, source: string, base: string, version: string): Promise<void> {
	await withInstallLock(root, () => {
		const lib = join(root, "lib");
		mkdirSync(lib, { recursive: true });
		const previous = readCurrent(root, "lib");
		const staging = mkdtempSync(join(lib, `install-${version}-`));
		try {
			cpSync(source, staging, { recursive: true });
			renameSync(staging, join(lib, version));
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
		linkCurrent(root, "lib", version);
		for (const name of readdirSync(lib)) {
			if (name.startsWith(`${base}.`) && name !== version && name !== previous) {
				rmSync(join(lib, name), { recursive: true, force: true });
			}
		}
	});
}

if (import.meta.main) {
	const [root, source, base, version] = Bun.argv.slice(2);
	if (!root || !source || !base || !version) throw new Error("usage: remote-install <root> <source> <base> <version>");
	await installLocal(root, source, base, version);
	console.log(`lib/current -> ${version}`);
}
