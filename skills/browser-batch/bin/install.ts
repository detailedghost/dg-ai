#!/usr/bin/env bun
/**
 * Chrome and Edge intentionally do not allow scripts to silently install unpacked extensions.
 * This helper copies the vendored MV3 extension to a stable local path and prints guided
 * Load-unpacked steps so setup is repeatable without pretending browser policy can be bypassed.
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Marker = { version?: string };

function versionParts(version: string): number[] {
	return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function versionGte(a: string, b: string): boolean {
	const left = versionParts(a);
	const right = versionParts(b);
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const delta = (left[i] ?? 0) - (right[i] ?? 0);
		if (delta !== 0) return delta > 0;
	}
	return true;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error) {
		throw new Error(`${command} not found or failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

function isWSL(): boolean {
	if (process.platform !== "linux") return false;
	try {
		return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

function copyDir(src: string, dest: string): void {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src)) {
		const from = join(src, entry);
		const to = join(dest, entry);
		if (statSync(from).isDirectory()) copyDir(from, to);
		else copyFileSync(from, to);
	}
}

function extensionDir(): string {
	if (process.env.CLAUDE_PLUGIN_ROOT) {
		return join(process.env.CLAUDE_PLUGIN_ROOT, "skills", "browser-batch", "extension");
	}
	return resolve(import.meta.dir, "../extension");
}

function windowsUserProfile(): string {
	if (process.platform === "win32" && process.env.USERPROFILE) return process.env.USERPROFILE;
	return run("cmd.exe", ["/c", "echo", "%USERPROFILE%"]).replace(/\r/g, "");
}

function destination(): { copyPath: string; printPath: string } {
	if (isWSL()) {
		const winProfile = windowsUserProfile();
		const winDest = `${winProfile}\\.dg\\browser-batch-extension`;
		const copyPath = run("wslpath", ["-u", winDest]);
		const printPath = run("wslpath", ["-w", copyPath]);
		return { copyPath, printPath };
	}

	if (process.platform === "win32") {
		const winDest = `${windowsUserProfile()}\\.dg\\browser-batch-extension`;
		return { copyPath: winDest, printPath: winDest };
	}

	const localDest = join(homedir(), ".dg", "browser-batch-extension");
	return { copyPath: localDest, printPath: localDest };
}

function printSteps(path: string): void {
	console.log("1. Open chrome://extensions (or edge://extensions).");
	console.log('2. Enable "Developer mode".');
	console.log('3. Click "Load unpacked".');
	console.log(`4. Select ${path}.`);
	console.log("5. Done.");
}

function main(): void {
	const source = extensionDir();
	const manifest = readJson<{ version: string }>(join(source, "manifest.json"));
	const markerPath = join(homedir(), ".config", "dg", "browser-batch-installed");
	const marker = existsSync(markerPath) ? readJson<Marker>(markerPath) : undefined;

	if (marker?.version && versionGte(marker.version, manifest.version)) {
		console.log(`dg-ai-browser-batch extension already set up (v${marker.version}).`);
		return;
	}

	const hadMarker = Boolean(marker?.version);
	const { copyPath, printPath } = destination();
	mkdirSync(dirname(copyPath), { recursive: true });
	copyDir(source, copyPath);

	console.log(`dg-ai-browser-batch extension copied to ${printPath}`);
	if (hadMarker) {
		console.log("extension updated — click the reload icon on chrome://extensions.");
	} else {
		printSteps(printPath);
	}

	mkdirSync(dirname(markerPath), { recursive: true });
	writeFileSync(markerPath, `${JSON.stringify({ version: manifest.version })}\n`);
	console.log(`dg-ai-browser-batch extension set up (v${manifest.version}).`);
}

try {
	main();
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`dg-ai-browser-batch install failed: ${msg}`);
	if (isWSL()) {
		console.error("WSL detected — ensure Windows interop is enabled (cmd.exe and wslpath must be reachable on PATH).");
	}
	process.exit(1);
}
