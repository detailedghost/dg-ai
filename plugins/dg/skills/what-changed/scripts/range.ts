#!/usr/bin/env bun
import { execFile } from "node:child_process";

export type Run = (file: string, args: readonly string[]) => Promise<string>;

export type DiscoveredRange = {
  range: string;
  source: "provider-release" | "semver-tag" | "none";
  defaultBranch: string;
  lastRelease: string | null;
  wholeHistory: boolean;
};

export type RangeReport = DiscoveredRange | { range: string; source: "explicit" };

const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** Runs a command with an argv array. Ref names never pass through a shell. Rejects on any failure. */
export function execRun(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        const detail = stderr.trim() || error.message;
        reject(new Error(`${file} ${args.join(" ")} failed: ${detail}`));
      },
    );
  });
}

async function attempt(run: Run, file: string, args: readonly string[]): Promise<string> {
  try {
    return await run(file, args);
  } catch {
    return "";
  }
}

function remoteHost(url: string): string {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:]+)/i.exec(url.trim());
  return match ? match[1].toLowerCase() : "";
}

function isGitlabHost(host: string): boolean {
  return host === "gitlab.com" || host.startsWith("gitlab.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

async function providerDefaultBranch(run: Run, gitlab: boolean): Promise<string> {
  if (gitlab) {
    const body = parsed(await attempt(run, "glab", ["repo", "view", "-F", "json"]));
    return stringField(body, "default_branch");
  }
  const body = parsed(await attempt(run, "gh", ["repo", "view", "--json", "defaultBranchRef"]));
  return stringField(isRecord(body) ? body.defaultBranchRef : undefined, "name");
}

async function providerReleaseTag(run: Run, gitlab: boolean): Promise<string> {
  const body = gitlab
    ? parsed(await attempt(run, "glab", ["api", "projects/:id/releases?per_page=1"]))
    : parsed(
        await attempt(run, "gh", [
          "release",
          "list",
          "--exclude-drafts",
          "--exclude-pre-releases",
          "-L",
          "1",
          "--json",
          "tagName",
        ]),
      );
  if (!Array.isArray(body)) return "";
  const first = body[0];
  return stringField(first, gitlab ? "tag_name" : "tagName");
}

async function hasTag(run: Run, tag: string): Promise<boolean> {
  if (tag === "") return false;
  const verified = await attempt(run, "git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
  return verified !== "";
}

export async function discoverRange(run: Run): Promise<DiscoveredRange>;
export async function discoverRange(run: Run, explicit?: string): Promise<RangeReport>;
export async function discoverRange(run: Run, explicit?: string): Promise<RangeReport> {
  if (explicit) {
    if (explicit.startsWith("-")) throw new Error(`Invalid range "${explicit}": it must not start with "-".`);
    return { range: explicit, source: "explicit" };
  }

  await run("git", ["fetch", "--tags", "--quiet", "origin"]);
  const remoteUrl = await run("git", ["remote", "get-url", "origin"]);
  const gitlab = isGitlabHost(remoteHost(remoteUrl));
  const symbolic = (await attempt(run, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(
    /^origin\//,
    "",
  );
  const defaultBranch = symbolic || (await providerDefaultBranch(run, gitlab));
  if (!defaultBranch) throw new Error("Cannot find the default branch.");

  const head = `origin/${defaultBranch}`;
  const providerTag = await providerReleaseTag(run, gitlab);
  let tag = "";
  let source: DiscoveredRange["source"] = "none";
  if (await hasTag(run, providerTag)) {
    tag = providerTag;
    source = "provider-release";
  } else {
    const tags = (await run("git", ["tag", "--merged", head, "--sort=-v:refname"])).split("\n");
    tag = tags.find((candidate) => /^v?\d+\.\d+\.\d+$/.test(candidate)) ?? "";
    if (tag) source = "semver-tag";
  }

  return {
    range: tag ? `${tag}..${head}` : head,
    defaultBranch,
    lastRelease: tag || null,
    source,
    wholeHistory: !tag,
  };
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify(await discoverRange(execRun, process.argv[2])));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) await main();
