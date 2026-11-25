import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { gitBinary, git as runGit } from "../install/recommended-skills-only";
import { copyTree, hashTree, listTree } from "./tree";

export type Pin = { kind: "sha256" | "commit"; value: string };
export type Staged = { dir: string; files: string[]; treeSha256: string; pin: Pin };

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

function git(cwd: string, args: string[]): string {
	try {
		return runGit(gitBinary(), cwd, args).trim();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (reason === "git not found") throw new DgCliError("dg plugin: git was not found. Next: install git, or add a plain folder instead.");
		throw new DgCliError(`dg plugin: git ${args[0]} failed: ${reason}. Next: check the source and run the command again.`);
	}
}

/** Parses `commit:<hex>` or `sha256:<hex>`. */
export function parsePin(text: string): Pin {
	const [kind, value = ""] = text.split(":");
	if (kind === "commit" && COMMIT.test(value)) return { kind, value };
	if (kind === "sha256" && SHA256.test(value)) return { kind, value };
	throw new DgCliError(`dg plugin: ${text} is not a pin. Next: use commit:<40 or 64 hex> or sha256:<64 hex>.`);
}

export function checkSource(source: string): void {
	if (source === "" || source.startsWith("-") || /^ext::/i.test(source))
		throw new DgCliError(`dg plugin: ${source} is not a usable source. Next: pass a git url or a folder path.`);
	if (holdsCredentials(source))
		throw new DgCliError("dg plugin: the source holds credentials in its URL. Next: remove them; dg never stores secrets in config.toml.");
}

const URL_AUTHORITY = /^([a-z][a-z0-9+.-]*):\/\/([^/\\?#]*)/i;
const SSH_SCHEMES: ReadonlySet<string> = new Set(["ssh:", "git+ssh:"]);

function holdsCredentials(source: string): boolean {
	const match = URL_AUTHORITY.exec(source);
	if (match === null) return false;
	const authority = match[2] ?? "";
	const at = authority.lastIndexOf("@");
	if (at < 0) return false;
	return !SSH_SCHEMES.has(`${(match[1] ?? "").toLowerCase()}:`) || authority.slice(0, at).includes(":");
}

function isFolder(source: string): boolean {
	return existsSync(source) && statSync(source).isDirectory();
}

/** Fetches `source` into `dir`, checks the requested pin, and reports the pin it observed. Nothing leaves `dir`. */
export function stageSource(source: string, dir: string, requested?: Pin): Staged {
	checkSource(source);
	const folder = isFolder(source);
	const gitBacked = !folder || existsSync(join(source, ".git"));
	if (requested?.kind === "commit" && folder && !gitBacked)
		throw new DgCliError("dg plugin: a commit pin needs a git source. Next: pin a plain folder by sha256.");
	let commit: string | undefined;
	if (gitBacked) {
		const checkout = join(dir, "checkout");
		mkdirSync(dir, { recursive: true });
		git(dir, ["clone", "--quiet", "--no-checkout", "--no-hardlinks", "--", source, checkout]);
		if (requested?.kind === "commit") {
			try {
				git(checkout, ["checkout", "--quiet", "--detach", requested.value]);
			} catch {
				throw new DgCliError(`dg plugin: the commit pin ${requested.value} is not in ${source}. Next: check the commit id.`);
			}
		} else git(checkout, ["checkout", "--quiet", "--detach"]);
		commit = git(checkout, ["rev-parse", "HEAD"]);
		if (requested?.kind === "commit" && commit !== requested.value)
			throw new DgCliError(`dg plugin: the commit pin ${requested.value} resolved to ${commit}. Next: pass the full commit id.`);
		rmSync(join(checkout, ".git"), { recursive: true, force: true });
		return finish(checkout, requested, commit);
	}
	const copy = join(dir, "copy");
	copyTree(source, copy, listTree(source));
	return finish(copy, requested, undefined);
}

function finish(dir: string, requested: Pin | undefined, commit: string | undefined): Staged {
	const files = listTree(dir);
	const treeSha256 = hashTree(dir, files);
	if (requested?.kind === "sha256" && requested.value !== treeSha256)
		throw new DgCliError(`dg plugin: the sha256 pin ${requested.value} does not match the fetched files (${treeSha256}). Next: check the source, or pin the sha256 you reviewed.`);
	const pin: Pin = commit === undefined ? { kind: "sha256", value: treeSha256 } : { kind: "commit", value: commit };
	return { dir, files, treeSha256, pin };
}
