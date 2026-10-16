#!/usr/bin/env bun
import { $ } from "bun";

const run = async (cmd: string): Promise<string> => {
  const r = await $`sh -c ${cmd}`.quiet().nothrow();
  return r.exitCode === 0 ? r.text().trim() : "";
};

const explicit = process.argv[2];
if (explicit) {
  console.log(JSON.stringify({ range: explicit, source: "explicit" }));
  process.exit(0);
}

await run("git fetch --tags --quiet origin");

const remoteUrl = await run("git remote get-url origin");
const gitlab = remoteUrl.includes("gitlab");

const defaultBranch =
  (await run("git symbolic-ref --short refs/remotes/origin/HEAD")).replace(/^origin\//, "") ||
  (gitlab
    ? await run("glab repo view -F json | jq -r .default_branch")
    : await run("gh repo view --json defaultBranchRef -q .defaultBranchRef.name"));

if (!defaultBranch) {
  console.error("Cannot find the default branch.");
  process.exit(1);
}

const head = `origin/${defaultBranch}`;

const providerTag = gitlab
  ? await run("glab api 'projects/:id/releases?per_page=1' | jq -r '.[0].tag_name // empty'")
  : await run("gh release list --exclude-drafts --exclude-pre-releases -L 1 --json tagName -q '.[0].tagName'");

const hasTag = async (tag: string) => tag !== "" && (await run(`git rev-parse -q --verify refs/tags/${tag}`)) !== "";

let tag = "";
let source = "none";
if (await hasTag(providerTag)) {
  tag = providerTag;
  source = "provider-release";
} else {
  const tags = (await run(`git tag --merged ${head} --sort=-v:refname`)).split("\n");
  tag = tags.find((t) => /^v?\d+\.\d+\.\d+$/.test(t)) ?? "";
  if (tag) source = "semver-tag";
}

console.log(
  JSON.stringify({
    range: tag ? `${tag}..${head}` : head,
    defaultBranch,
    lastRelease: tag || null,
    source,
    wholeHistory: !tag,
  }),
);
