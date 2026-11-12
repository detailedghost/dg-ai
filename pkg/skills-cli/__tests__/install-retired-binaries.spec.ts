import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeRetiredBinaries } from "../src/install/cli";
import { writeShims } from "../src/install/shims";
import { cliDest } from "../src/utils/lib";
import { scratch, type Scratch } from "./runtime-bundle-fixtures";

const NAMES = ["dg-skills", "dg-agent", "dg-daemon"] as const;
const posix = describe.skipIf(process.platform === "win32");

let sandbox: Scratch;
let savedHome: string | undefined;

beforeEach(() => {
	sandbox = scratch("retired-binaries");
	savedHome = process.env.DG_HOME;
	process.env.DG_HOME = sandbox.root;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = savedHome;
	sandbox.cleanup();
});

posix("retired compiled binaries", () => {
	test("cliDest resolves each program to its shim path under <root>/bin", () => {
		for (const name of NAMES) expect(cliDest(name)).toBe(join(sandbox.root, "bin", name));
	});

	test("an existing compiled dg-daemon is gone and its version file removed once the shim exists, and the shim survives", () => {
		const bin = join(sandbox.root, "bin");
		mkdirSync(bin, { recursive: true });
		for (const name of NAMES) {
			writeFileSync(join(bin, name), "compiled ELF bytes", { mode: 0o755 });
			writeFileSync(join(bin, `.${name}.version`), "1.26.0\n");
		}

		writeShims(bin, join(sandbox.root, "data"));
		removeRetiredBinaries();

		for (const name of NAMES) {
			expect(existsSync(join(bin, `.${name}.version`))).toBe(false);
			expect(readFileSync(join(bin, name), "utf8")).not.toContain("compiled ELF bytes");
			expect(readFileSync(join(bin, name), "utf8")).toContain(`${name} "$@"`);
		}
	});
});
