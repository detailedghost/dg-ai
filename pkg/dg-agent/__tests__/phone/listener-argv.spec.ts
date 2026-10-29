import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherCommand } from "@dg/common/node/program";
import { defaultListenerArgv } from "../../src/phone/commands";

describe("defaultListenerArgv", () => {
	const root = join(tmpdir(), "dg-listener-root");

	it("starts with the runtime/current bun and the lib/current dg.js", () => {
		const argv = defaultListenerArgv(root, ["__run"]);
		const [bun, entry] = launcherCommand(root, "dg-agent", []);
		expect(argv[0]).toBe(bun);
		expect(argv[0]).toBe(join(root, "runtime", "current", process.platform === "win32" ? "bun.exe" : "bun"));
		expect(argv[1]).toBe(entry);
		expect(argv[2]).toBe("dg-agent");
	});

	it("never names a version directory", () => {
		for (const part of defaultListenerArgv(root, ["__run"])) {
			expect(part).not.toMatch(/bun-v\d|[\\/]lib[\\/]\d+\.\d+\.\d+/);
		}
	});
});
