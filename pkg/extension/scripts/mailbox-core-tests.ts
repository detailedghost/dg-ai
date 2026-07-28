import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

async function collectSpecs(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...await collectSpecs(path));
		} else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
			files.push(path);
		}
	}
	return files;
}

const extensionRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(extensionRoot, "../..");
const rootMailboxSpecs = (await readdir(
	resolve(extensionRoot, "__tests__"),
	{ withFileTypes: true },
))
	.filter(
		(entry) =>
			entry.isFile() &&
			/^mailbox-.*\.spec\.ts$/u.test(entry.name),
	)
	.map((entry) => resolve(extensionRoot, "__tests__", entry.name));
const specs = [
	...await collectSpecs(resolve(repoRoot, "pkg/common/src/mailbox")),
	...await collectSpecs(
		resolve(extensionRoot, "lib/features/mailbox-cleanup"),
	),
	...rootMailboxSpecs,
].sort();

if (specs.length === 0) {
	throw new Error("Mailbox core test inventory is empty");
}

const child = Bun.spawn(["bun", "test", ...specs], {
	cwd: extensionRoot,
	env: process.env,
	stdout: "inherit",
	stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) process.exitCode = exitCode;
