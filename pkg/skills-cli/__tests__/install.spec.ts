import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("install --local rebuilds stale output and replaces an installed extension of the same version", async () => {
	const directory = mkdtempSync(join(tmpdir(), "dg-local-install-"));
	const repo = join(directory, "repo");
	const home = join(directory, "home");
	const output = join(repo, "pkg/extension/.output/chrome-mv3");
	const destination = join(home, ".dg/dg-ai-extension-chrome");
	try {
		for (const path of [output, destination, join(repo, "node_modules/.bin"), join(home, ".config/dg")]) {
			mkdirSync(path, { recursive: true });
		}
		writeFileSync(join(repo, "pkg/extension/package.json"), "{}");
		writeFileSync(join(repo, "node_modules/.bin/wxt"), "");
		writeFileSync(join(output, "manifest.json"), JSON.stringify({ version: "1.11.0" }));
		writeFileSync(join(output, "background.js"), "stale build");
		writeFileSync(join(destination, "background.js"), "installed release");
		writeFileSync(join(home, ".config/dg/browser-batch-installed"), JSON.stringify({ chrome: "1.11.0" }));
		// Mock process/platform boundaries in a child so other specs keep their real filesystem paths.
		const script = `
import { mock } from "bun:test";
import * as os from "node:os";
import * as node from "@dg/common/node";
import { writeFileSync } from "node:fs";
import { Command } from "commander";
mock.module("node:os", () => ({ ...os, homedir: () => ${JSON.stringify(home)} }));
mock.module("@dg/common/node", () => ({ ...node, isWSL: () => false, run: (command, args) => {
  if (command !== "bun" || args.join(" ") !== "run build") throw new Error("unexpected command");
  writeFileSync(${JSON.stringify(join(output, "background.js"))}, "fresh local build");
  return "";
} }));
const { registerInstall } = await import(${JSON.stringify(new URL("../src/commands/install.ts", import.meta.url).pathname)});
const program = new Command();
registerInstall(program);
await program.parseAsync(["install", "--local", "--repo", ${JSON.stringify(repo)}], { from: "user" });
`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout).toContain("staged at");
		expect(readFileSync(join(destination, "background.js"), "utf8")).toBe("fresh local build");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
