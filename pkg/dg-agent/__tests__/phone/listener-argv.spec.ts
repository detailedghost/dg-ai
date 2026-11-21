import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { rewriteLauncherArgv } from "@dg/common/node/program";
import { defaultListenerArgv } from "../../src/phone/commands";
import { listenerArgvFor } from "../../src/phone/listener";

describe("defaultListenerArgv", () => {
	const root = join(tmpdir(), "dg-listener-root");

	it("starts with the bin/current link of the compiled program and the agent group", () => {
		const argv = defaultListenerArgv(root, ["listen"]);
		expect(argv[0]).toBe(join(root, "bin", "current", process.platform === "win32" ? "dg.exe" : "dg"));
		expect(argv.slice(1, 3)).toEqual(["agent", "phone"]);
	});

	it("never names a version directory, the runtime or the bundle", () => {
		for (const part of defaultListenerArgv(root, ["listen"])) {
			expect(part).not.toMatch(/bun-v\d|[\\/]bin[\\/]\d+\.\d+\.\d+|runtime|dg\.js/);
		}
	});
});

describe.skipIf(process.platform === "win32")("listenerArgvFor", () => {
	it("runs the compiled program from the data dir", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: "/home/u", env: {} });
		expect(listenerArgvFor(paths, ["--x"])).toEqual(["/home/u/.local/share/dg/bin/current/dg", "agent", "phone", "listen", "--x"]);
	});

	it("is what a 6.3 listener unit argv rewrites to", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: "/home/u", env: {} });
		const old = ["/home/u/.local/share/dg/runtime/current/bun", "/home/u/.local/share/dg/lib/current/dg.js", "dg-agent", "phone", "listen", "--x"];
		expect(rewriteLauncherArgv(old)).toEqual(listenerArgvFor(paths, ["--x"]));
	});
});
