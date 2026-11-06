import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherCommand } from "@dg/common/node/program";
import { resolveDgPaths } from "@dg/common/node";
import { defaultListenerArgv } from "../../src/phone/commands";
import { listenerArgvFor } from "../../src/phone/listener";

describe("defaultListenerArgv", () => {
	const root = join(tmpdir(), "dg-listener-root");

	it("starts with the runtime/current bun and the lib/current dg.js", () => {
		const argv = defaultListenerArgv(root, ["listen"]);
		const [bun, entry] = launcherCommand(root, "dg-agent", []);
		expect(argv[0]).toBe(bun);
		expect(argv[0]).toBe(join(root, "runtime", "current", process.platform === "win32" ? "bun.exe" : "bun"));
		expect(argv[1]).toBe(entry);
		expect(argv[2]).toBe("dg-agent");
	});

	it("never names a version directory", () => {
		for (const part of defaultListenerArgv(root, ["listen"])) {
			expect(part).not.toMatch(/bun-v\d|[\\/]lib[\\/]\d+\.\d+\.\d+/);
		}
	});
});

describe.skipIf(process.platform === "win32")("listenerArgvFor", () => {
	it("runs the launcher from the data dir, where runtime/current and lib/current live", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: "/home/u", env: {} });
		const argv = listenerArgvFor(paths, ["listen"]);
		expect(argv.slice(0, 3)).toEqual([
			"/home/u/.local/share/dg/runtime/current/bun",
			"/home/u/.local/share/dg/lib/current/dg.js",
			"dg-agent",
		]);
	});
});
