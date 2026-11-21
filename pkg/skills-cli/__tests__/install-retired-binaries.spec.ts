import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeRetiredBinaries } from "../src/install/cli";
import { PROGRAM_NAMES } from "@dg/common/node/program";
import { writeDgLink } from "../src/install/compiled";
import { scratch, type Scratch } from "./release-fixtures";

const NAMES = PROGRAM_NAMES;
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
	test("a retired dg-server binary and the version stamps of the old program names are removed", () => {
		const bin = join(sandbox.root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-server"), "compiled ELF bytes", { mode: 0o755 });
		for (const name of ["dg-server", ...NAMES]) writeFileSync(join(bin, `.${name}.version`), "1.26.0\n");

		removeRetiredBinaries();

		expect(existsSync(join(bin, "dg-server"))).toBe(false);
		for (const name of ["dg-server", ...NAMES]) expect(existsSync(join(bin, `.${name}.version`))).toBe(false);
	});

	test("a .dg.version file is left alone: no compiled dg binary ever existed", () => {
		const bin = join(sandbox.root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, ".dg.version"), "1.26.0\n");

		removeRetiredBinaries();

		expect(readFileSync(join(bin, ".dg.version"), "utf8")).toBe("1.26.0\n");
	});

	test("the dg link survives", () => {
		const bin = join(sandbox.root, "bin");
		const data = join(sandbox.root, "data");

		writeDgLink(bin, data, "7.0.0", "linux", () => {});
		removeRetiredBinaries();

		expect(lstatSync(join(bin, "dg")).isSymbolicLink()).toBe(true);
	});
});
