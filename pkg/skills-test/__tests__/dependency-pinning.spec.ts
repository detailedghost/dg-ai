import { afterEach, describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bumpRuntime } from "../../../scripts/bump-runtime";
import { REPO_ROOT, readRepoFile } from "./test-support";
import { parseWorkflow, workflowFiles } from "./workflow-support";

const PKG_DIR = join(REPO_ROOT, "pkg");

function packageJsons(): { name: string; json: Record<string, unknown> }[] {
	return readdirSync(PKG_DIR)
		.filter(
			(entry) =>
				statSync(join(PKG_DIR, entry)).isDirectory() &&
				existsSync(join(PKG_DIR, entry, "package.json")),
		)
		.map((entry) => ({
			name: entry,
			json: JSON.parse(readRepoFile("pkg", entry, "package.json")) as Record<
				string,
				unknown
			>,
		}));
}

const MOVING_TAGS = new Set(["latest", "next", "canary", "*", ""]);
const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

function assertNoMovingTags(deps: Record<string, string>): void {
	const moving = Object.entries(deps).filter(([, range]) =>
		MOVING_TAGS.has(range),
	);
	expect(moving).toEqual([]);
}

describe("no workspace package pins a dependency to a moving tag", () => {
	const packages = packageJsons();

	test("there are packages to check", () => {
		expect(packages.length).toBeGreaterThan(3);
	});

	for (const { name, json } of packages) {
		for (const field of DEP_FIELDS) {
			const deps = (json[field] ?? {}) as Record<string, string>;
			test(`pkg/${name}'s ${field} carry resolvable ranges, not moving tags`, () => {
				assertNoMovingTags(deps);
			});
		}
	}

	test("the root package.json is clean too", () => {
		const root = JSON.parse(readRepoFile("package.json")) as Record<
			string,
			unknown
		>;
		for (const field of DEP_FIELDS) {
			const deps = (root[field] ?? {}) as Record<string, string>;
			assertNoMovingTags(deps);
		}
	});

	test("workspace: protocol is still allowed — it resolves locally, not from the registry", () => {
		const withWorkspace = packages.filter(({ json }) =>
			Object.values((json.dependencies ?? {}) as Record<string, string>).some(
				(range) => range.startsWith("workspace:"),
			),
		);
		expect(withWorkspace.length).toBeGreaterThan(0);
	});
});

describe("the bun version is pinned to one value everywhere", () => {
	const runtime = JSON.parse(readRepoFile("pkg", "launcher", "runtime.json")) as {
		version: string;
	};
	const mise = Bun.TOML.parse(readRepoFile(".mise", "config.toml")) as {
		tools: { bun: string };
	};

	test("runtime.json holds a full x.y.z version", () => {
		expect(runtime.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test(".mise bun pin equals the runtime.json version", () => {
		expect(mise.tools.bun).toBe(runtime.version);
	});

	test("there is at least one setup-bun step to check", () => {
		const pins = workflowFiles().flatMap((name) => setupBunVersions(name));

		expect(pins.length).toBeGreaterThan(0);
	});

	for (const name of workflowFiles()) {
		test(`every setup-bun in ${name} uses the runtime.json version`, () => {
			for (const version of setupBunVersions(name)) {
				expect(version).toBe(runtime.version);
			}
		});
	}
});

function setupBunVersions(name: string): string[] {
	return Object.values(parseWorkflow(name).jobs).flatMap((job) =>
		(job.steps ?? [])
			.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
			.map((step) => String(step.with?.["bun-version"])),
	);
}

describe("bump-runtime keeps runtime.json, .mise and the workflows in agreement", () => {
	const NEXT = "9.8.7";
	const staged: string[] = [];

	afterEach(() => {
		for (const root of staged.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function stagedRepo(): string {
		const root = mkdtempSync(join(tmpdir(), "dg-bump-runtime-"));
		staged.push(root);
		mkdirSync(join(root, "pkg", "launcher"), { recursive: true });
		mkdirSync(join(root, ".mise"), { recursive: true });
		cpSync(join(REPO_ROOT, "pkg", "launcher", "runtime.json"), join(root, "pkg", "launcher", "runtime.json"));
		cpSync(join(REPO_ROOT, ".mise", "config.toml"), join(root, ".mise", "config.toml"));
		cpSync(join(REPO_ROOT, ".github", "workflows"), join(root, ".github", "workflows"), { recursive: true });
		return root;
	}

	function shasumsFile(root: string, files: string[]): string {
		const path = join(root, "SHASUMS256.txt");
		const lines = files.map((file, index) => `${String(index + 1).repeat(64)}  ${file}`);
		writeFileSync(path, `${lines.join("\n")}\n`);
		return pathToFileURL(path).href;
	}

	test("a bump rewrites the pin, the hashes, .mise and every setup-bun to the new version", async () => {
		const root = stagedRepo();
		const before = JSON.parse(readFileSync(join(root, "pkg", "launcher", "runtime.json"), "utf8")) as {
			assets: Record<string, { file: string }>;
		};
		const files = Object.values(before.assets).map((asset) => asset.file);
		process.env.DG_BUN_SHASUMS_URL = shasumsFile(root, files);
		try {
			await bumpRuntime(root, NEXT);
		} finally {
			delete process.env.DG_BUN_SHASUMS_URL;
		}

		const runtime = JSON.parse(readFileSync(join(root, "pkg", "launcher", "runtime.json"), "utf8")) as {
			version: string;
			assets: Record<string, { file: string; sha256: string }>;
		};
		const mise = Bun.TOML.parse(readFileSync(join(root, ".mise", "config.toml"), "utf8")) as {
			tools: { bun: string };
		};
		expect(runtime.version).toBe(NEXT);
		expect(Object.values(runtime.assets).map((asset) => asset.file)).toEqual(files);
		for (const [index, file] of files.entries()) {
			const asset = Object.values(runtime.assets).find((entry) => entry.file === file);
			expect(asset?.sha256).toBe(String(index + 1).repeat(64));
		}
		expect(mise.tools.bun).toBe(NEXT);
		const pins = readdirSync(join(root, ".github", "workflows"))
			.filter((name) => name.endsWith(".yml"))
			.flatMap((name) =>
				Object.values(
					(Bun.YAML.parse(readFileSync(join(root, ".github", "workflows", name), "utf8")) as ReturnType<typeof parseWorkflow>).jobs,
				).flatMap((job) =>
					(job.steps ?? [])
						.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
						.map((step) => String(step.with?.["bun-version"])),
				),
			);
		expect(pins.length).toBeGreaterThan(0);
		expect(pins.every((pin) => pin === NEXT)).toBe(true);
	});

	test("a SHASUMS file that misses an asset fails and changes nothing", async () => {
		const root = stagedRepo();
		const original = readFileSync(join(root, "pkg", "launcher", "runtime.json"), "utf8");
		process.env.DG_BUN_SHASUMS_URL = shasumsFile(root, ["bun-linux-x64.zip"]);
		try {
			await expect(bumpRuntime(root, NEXT)).rejects.toThrow("has no entry for");
		} finally {
			delete process.env.DG_BUN_SHASUMS_URL;
		}

		expect(readFileSync(join(root, "pkg", "launcher", "runtime.json"), "utf8")).toBe(original);
	});

	test("a .mise config without a bun pin fails before any file changes", async () => {
		const root = stagedRepo();
		const runtimePath = join(root, "pkg", "launcher", "runtime.json");
		const original = readFileSync(runtimePath, "utf8");
		const misePath = join(root, ".mise", "config.toml");
		writeFileSync(misePath, readFileSync(misePath, "utf8").replace(/^bun\s*=.*$/m, ""));
		const files = Object.values((JSON.parse(original) as { assets: Record<string, { file: string }> }).assets).map(
			(asset) => asset.file,
		);
		process.env.DG_BUN_SHASUMS_URL = shasumsFile(root, files);
		try {
			await expect(bumpRuntime(root, NEXT)).rejects.toThrow("no bun pin");
		} finally {
			delete process.env.DG_BUN_SHASUMS_URL;
		}

		expect(readFileSync(runtimePath, "utf8")).toBe(original);
	});

	test("a version that is not x.y.z is refused", async () => {
		await expect(bumpRuntime(stagedRepo(), "1.4")).rejects.toThrow("invalid bun version");
	});
});
