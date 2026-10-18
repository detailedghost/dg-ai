import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillsCli } from "../build";

test("compiled connect initializes Playwright after removing its source, without Bun on PATH", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dg-connect-compiled-"));
	try {
		const entry = join(dir, "entry.ts");
		const executable = join(
			dir,
			process.platform === "win32" ? "probe.exe" : "probe",
		);
		const missingBrowser = join(dir, "missing-chrome");
		const vendor = join(dir, "playwright-core");
		cpSync(
			dirname(fileURLToPath(import.meta.resolve("playwright-core"))),
			vendor,
			{ recursive: true },
		);
		writeFileSync(
			entry,
			`
import { defaultConnectDeps } from ${JSON.stringify(resolve(import.meta.dir, "../src/commands/channel-review-connect.ts"))};
import { chromium } from ${JSON.stringify(fileURLToPath(import.meta.resolve("playwright-core")))};
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = (profile, options) => launch(profile, {
  ...options, executablePath: ${JSON.stringify(missingBrowser)},
});
try {
  await defaultConnectDeps.launchBrowser();
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("executable doesn't exist") && message.includes(${JSON.stringify(missingBrowser)})) {
    console.log("connect browser runtime initialized");
  } else {
    console.error(message);
    process.exitCode = 1;
  }
}
`,
		);
		await buildSkillsCli({
			entrypoint: entry,
			outfile: executable,
			plugins: [
				{
					name: "isolated-playwright",
					setup(build) {
						build.onResolve(
							{
								filter:
									/^(?:playwright-core|.*[/\\]playwright-core[/\\]index\.mjs)$/,
							},
							() => ({ path: join(vendor, "index.mjs") }),
						);
					},
				},
			],
		});
		rmSync(vendor, { recursive: true });
		const run = Bun.spawn([executable], {
			cwd: dir,
			env: { ...process.env, PATH: "", DG_HOME: join(dir, "home") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			run.exited,
			new Response(run.stdout).text(),
			new Response(run.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		expect(stdout.trim()).toBe("connect browser runtime initialized");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
