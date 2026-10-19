import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCapture } from "@dg/common/node";
import { runNative } from "./process";

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function text(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

const VENDORED_DIRS = new Set(["node_modules", ".git", ".venv", "bin", "obj"]);

function nodeScripts(path: string): Record<string, unknown> {
	try {
		const scripts = (JSON.parse(text(path)) as { scripts?: unknown }).scripts;
		return typeof scripts === "object" && scripts !== null
			? (scripts as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function entries(path: string) {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

function findWithin(
	path: string,
	matches: (name: string) => boolean,
	depth = 3,
): boolean {
	if (depth === 0) return false;
	for (const entry of entries(path)) {
		if (matches(entry.name)) return true;
		if (
			entry.isDirectory() &&
			!VENDORED_DIRS.has(entry.name) &&
			findWithin(join(path, entry.name), matches, depth - 1)
		)
			return true;
	}
	return false;
}

/** Detect from Git root, preserve legacy tool working directories, and aggregate failures. */
export async function verifyBuild(cwd = process.cwd()): Promise<number> {
	cwd = resolve(cwd);
	const git = await runCapture("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		stdin: null,
	}).catch(() => null);
	const root = git?.status === 0 ? git.stdout.replace(/\n+$/, "") : cwd;
	let detected = false;
	let failed = false;
	const run = async (
		tool: string,
		args: string[],
		marker: string,
		failure: string,
		toolCwd = cwd,
	) => {
		console.log(`==> ${marker}`);
		if ((await runNative(tool, args, toolCwd, true)) === 0) return true;
		console.log(`==> ${failure}`);
		failed = true;
		return false;
	};

	if (
		entries(root).some(
			(entry) => !entry.name.startsWith(".") && entry.name.endsWith(".sln"),
		) ||
		findWithin(root, (name) => name.endsWith(".csproj"))
	) {
		detected = true;
		if (
			await run(
				"dotnet",
				["build"],
				"[dotnet] Building...",
				"[dotnet] BUILD FAILED.",
			)
		) {
			await run(
				"dotnet",
				["test", "--filter", "Category=Unit", "--verbosity", "minimal"],
				"[dotnet] Running unit tests...",
				"[dotnet] TESTS FAILED.",
			);
		}
	}

	if (isFile(join(root, "package.json"))) {
		detected = true;
		const runner = Bun.which("bun") ? "bun" : "npm";
		const scripts = nodeScripts(join(root, "package.json"));
		if ("build" in scripts) {
			await run(
				runner,
				["run", "build"],
				`[node/${runner}] Building...`,
				`[node/${runner}] BUILD FAILED.`,
			);
		}
		if (!failed && "test" in scripts) {
			await run(
				runner,
				["test"],
				`[node/${runner}] Running tests...`,
				`[node/${runner}] TESTS FAILED.`,
			);
		}
	}

	if (
		isFile(join(root, "pyproject.toml")) &&
		/^\[project\]/m.test(text(join(root, "pyproject.toml")))
	) {
		detected = true;
		if (
			(await run(
				"uv",
				["sync", "--project", root, "--all-groups"],
				"[python/uv] Syncing dependencies...",
				"[python/uv] SYNC FAILED.",
			)) &&
			findWithin(
				root,
				(name) => /^test_.*\.py$/.test(name) || /_test\.py$/.test(name),
			)
		) {
			await run(
				"uv",
				["run", "--project", root, "--all-groups", "pytest"],
				"[python/uv] Running pytest...",
				"[python/uv] TESTS FAILED.",
			);
		}
	}

	if (isFile(join(root, "go.mod"))) {
		detected = true;
		if (
			await run(
				"go",
				["build", "./..."],
				"[go] Building...",
				"[go] BUILD FAILED.",
				root,
			)
		) {
			await run(
				"go",
				["test", "./..."],
				"[go] Running tests...",
				"[go] TESTS FAILED.",
				root,
			);
		}
	}

	if (findWithin(root, (name) => name === "dbt_project.yml")) {
		detected = true;
		console.log(
			"==> [dbt] Detected but skipping (needs warehouse credentials).",
		);
	}
	if (!detected)
		console.log(
			`==> No recognized project type found at ${root}. Skipping build verification.`,
		);
	return failed ? 1 : 0;
}
