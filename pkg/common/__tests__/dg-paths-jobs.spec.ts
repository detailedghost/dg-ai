import { describe, expect, it } from "bun:test";
import { join, posix, win32 } from "node:path";
import {
	isJobName,
	jobSourceDir,
	jobStateDir,
	resolveDgPaths,
} from "@dg/common/node";

const linux = (env: Record<string, string | undefined>) =>
	resolveDgPaths({ platform: "linux", homeDir: "/h", env });

describe("DgPaths job paths", () => {
	it("places the job folders below data and state when DG_HOME is set", () => {
		const paths = linux({ DG_HOME: "/d" });

		expect(paths.jobsDir).toBe(posix.join(paths.dataDir, "jobs"));
		expect(paths.jobSourcesPath).toBe(
			posix.join(paths.jobsDir, "sources.json"),
		);
		expect(paths.jobStateRoot).toBe(posix.join(paths.stateDir, "jobs"));
		expect(paths.jobsDir).toBe("/d/data/jobs");
		expect(paths.jobSourcesPath).toBe("/d/data/jobs/sources.json");
		expect(paths.jobStateRoot).toBe("/d/state/jobs");
		expect(jobSourceDir(paths, "bot")).toBe("/d/data/jobs/bot");
		expect(jobStateDir(paths, "bot-dev")).toBe("/d/state/jobs/bot-dev");
	});

	it("joins with the windows separator on win32", () => {
		const paths = resolveDgPaths({
			platform: "win32",
			homeDir: "C:\\h",
			env: { DG_HOME: "C:\\d" },
		});

		expect(paths.jobsDir).toBe(win32.join(paths.dataDir, "jobs"));
		expect(paths.jobStateRoot).toBe(win32.join(paths.stateDir, "jobs"));
		expect(jobSourceDir(paths, "bot")).toBe(win32.join(paths.jobsDir, "bot"));
		expect(jobStateDir(paths, "bot")).toBe(
			win32.join(paths.jobStateRoot, "bot"),
		);
	});

	it("derives the job folders from the XDG roots with no DG_HOME", () => {
		const paths = linux({
			XDG_DATA_HOME: "/x/data",
			XDG_STATE_HOME: "/x/state",
		});

		expect(paths.jobsDir).toBe(posix.join(paths.dataDir, "jobs"));
		expect(paths.jobStateRoot).toBe(posix.join(paths.stateDir, "jobs"));
	});

	it("holds only strings in every value of the object", () => {
		for (const env of [{ DG_HOME: "/d" }, {}]) {
			for (const [key, value] of Object.entries(linux(env))) {
				expect(typeof value, key).toBe("string");
			}
		}
	});

	it("keeps the helpers off the paths object", () => {
		const paths = linux({ DG_HOME: "/d" }) as Record<string, unknown>;

		expect(paths.jobSourceDir).toBeUndefined();
		expect(paths.jobStateDir).toBeUndefined();
	});

	it("resolves the job folders below DG_PATH_FENCE", () => {
		const paths = linux({ DG_HOME: "/f/x", DG_PATH_FENCE: "/f" });

		expect(paths.jobsDir.startsWith("/f/x/")).toBe(true);
		expect(jobStateDir(paths, "bot").startsWith("/f/x/")).toBe(true);
	});

	it("throws the fence error for a DG_HOME outside the fence", () => {
		expect(() => linux({ DG_HOME: "/g", DG_PATH_FENCE: "/f" })).toThrow(
			/^dg path fence: /,
		);
	});
});

describe("isJobName", () => {
	it.each(["a", "0", "bot", "bot-dev", "a-", "9lives", "a".repeat(64)])(
		"accepts %p",
		(name) => {
			expect(isJobName(name)).toBe(true);
		},
	);

	it.each([
		"",
		".",
		"..",
		"a/b",
		"a\\b",
		"A",
		"-a",
		"a_b",
		"a b",
		"a.b",
		"a".repeat(65),
		"bot\n",
		"\nbot",
	])("rejects %p", (name) => {
		expect(isJobName(name)).toBe(false);
	});
});

describe("jobSourceDir and jobStateDir name guard", () => {
	const paths = linux({ DG_HOME: "/d" });
	const message = (name: string) =>
		`dg paths: "${name}" is not a valid job or source name`;

	for (const name of ["", ".", "..", "a/b", "A"]) {
		it(`throws the same text for ${JSON.stringify(name)} in both helpers`, () => {
			expect(() => jobSourceDir(paths, name)).toThrow(message(name));
			expect(() => jobStateDir(paths, name)).toThrow(message(name));
			expect(() => jobStateDir(paths, name)).toThrow(Error);
		});
	}

	it("returns a folder that equals join of the root and a name that passes isJobName", () => {
		const name = "ok-1";

		expect(isJobName(name)).toBe(true);
		expect(jobSourceDir(paths, name)).toBe(join(paths.jobsDir, name));
		expect(jobStateDir(paths, name)).toBe(join(paths.jobStateRoot, name));
	});
});
