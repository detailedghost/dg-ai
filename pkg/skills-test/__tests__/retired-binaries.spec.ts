import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const install = readRepoFile(
	"pkg",
	"skills-cli",
	"src",
	"commands",
	"install.ts",
);

describe("install retires the pre-rename daemon binary", () => {
	test("dg-server is listed as retired and dg-daemon is not", () => {
		const listed = /const RETIRED_BINARIES = \[([^\]]*)\]/.exec(install)?.[1];

		expect(listed).toContain('"dg-server"');
		expect(listed).not.toContain('"dg-daemon"');
		expect(listed).not.toContain('"dg-skills"');
	});

	test("the removal runs after the refresh, so a fetch failure cannot strand the machine binaryless", () => {
		const body = install.slice(install.indexOf("async function installCli"));

		expect(body.indexOf("installBinary(spec, releases)")).toBeLessThan(
			body.indexOf("removeRetiredBinaries()"),
		);
	});

	test("it clears the version stamp too, so a later install does not think it is current", () => {
		const fn = install.slice(
			install.indexOf("function removeRetiredBinaries"),
			install.indexOf("const BINARIES"),
		);

		expect(fn).toContain("cliDest(name)");
		expect(fn).toContain("cliVersionFile(name)");
	});
});
