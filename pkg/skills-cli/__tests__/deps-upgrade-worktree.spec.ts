import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createWorktree } from "../src/deps-upgrade/worktree-compat";
import * as cliFixtures from "./cli-fixtures";
import { scratchFixtures } from "./git-repo-fixtures";
import { stateDir } from "../../common/src/node/scratch-paths";

cliFixtures.isolateCliTests();
const fixtures = scratchFixtures();
afterEach(() => fixtures.cleanup());
const MODULE = join(import.meta.dir, "../src/deps-upgrade/worktree-compat.ts");
const CLI = join(import.meta.dir, "../src/index.ts");
const { runGit, commitFile } = cliFixtures;

/** All fetches use a disposable local bare repository, including paths with spaces. */
function trackedRepo(homeCode = false) {
 const root = fixtures.tmp("deps-create-");
 const origin = join(root, "upstream origin.git");
 mkdirSync(origin);
 runGit(["init", "-q", "--bare", "-b", "main"], origin);
 const repo = homeCode ? join(process.env.HOME!, "code", "widgets") : join(root, "widgets repo");
 cliFixtures.initTrackedRepo(repo, origin);
 runGit(["push", "-q", "-u", "origin", "main"], repo);
 return { root, origin, repo };
}

function expectedPath(repo: string, slug: string, homeCode = false) {
 return join(homeCode ? join(process.env.HOME!, "code", "worktrees") : dirname(repo), `${basename(repo)}-${slug}`);
}

function write(repo: string, file: string, content: string) {
 mkdirSync(dirname(join(repo, file)), { recursive: true });
 writeFileSync(join(repo, file), content);
}

function prepare(cwd: string, preload?: string) {
 const proc = Bun.spawnSync([process.execPath, "run", ...(preload ? ["--preload", preload] : []), CLI, "deps-upgrade", "prepare"], { cwd, env: { ...process.env, LC_ALL: "C" } });
 return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}

function fixedPrepareTime(root: string): string {
 const preload = join(root, "fixed-time.ts");
 writeFileSync(preload, 'globalThis.Date = class extends Date { constructor(value = "2026-03-04T05:06:07Z") { super(value); } };');
 return preload;
}

describe("createWorktree", () => {
 test("creates from fetched origin/HEAD with the default prefix and a normalized slug", async () => {
  const { repo } = trackedRepo();
  const result = await createWorktree({ slug: "  Upgrade API v2!  ", cwd: repo });
  expect(result).toEqual({ path: expectedPath(repo, "upgrade_api_v2"), branch: "feature/upgrade_api_v2", origin: repo });
  expect(runGit(["branch", "--show-current"], result.path).trim()).toBe(result.branch);
  expect(runGit(["rev-parse", "HEAD"], result.path)).toBe(runGit(["rev-parse", "origin/main"], repo));
 });

 test.each(["release", "release/", "team/chore/"])("accepts prefix %s with one required trailing slash", async (prefix) => {
  const { repo } = trackedRepo();
  const result = await createWorktree({ slug: "Upgrade", prefix, cwd: repo });
  expect(result.branch).toBe(`${prefix.endsWith("/") ? prefix : `${prefix}/`}upgrade`);
 });

 test("places a primary repository under HOME/code in HOME/code/worktrees", async () => {
  const { repo } = trackedRepo(true);
  const result = await createWorktree({ slug: "deps", cwd: repo });
  expect(result.path).toBe(expectedPath(repo, "deps", true));
  expect(result.origin).toBe(repo);
 });

 test("resolves the primary repository when called inside a linked worktree", async () => {
  const { repo } = trackedRepo();
  const first = await createWorktree({ slug: "first", cwd: repo });
  const second = await createWorktree({ slug: "second", cwd: first.path });
  expect(second.origin).toBe(repo);
  expect(second.path).toBe(expectedPath(repo, "second"));
 });

 test("resumes a dirty worktree without discarding its branch head or files", async () => {
  const { repo } = trackedRepo();
  const first = await createWorktree({ slug: "deps", cwd: repo });
  const head = commitFile(first.path, "feature.txt", "work", "feat: preserve progress");
  write(first.path, "untracked.txt", "unsaved");
  const resumed = await createWorktree({ slug: "deps", cwd: repo });
  expect(resumed).toEqual(first);
  expect(runGit(["rev-parse", "HEAD"], resumed.path).trim()).toBe(head);
  expect(readFileSync(join(resumed.path, "untracked.txt"), "utf8")).toBe("unsaved");
 });

 test("recreates a removed worktree from the existing branch rather than resetting to origin", async () => {
  const { repo } = trackedRepo();
  const first = await createWorktree({ slug: "deps", cwd: repo });
  const head = commitFile(first.path, "feature.txt", "work", "feat: preserve branch");
  runGit(["worktree", "remove", first.path], repo);
  const resumed = await createWorktree({ slug: "deps", cwd: repo });
  expect(resumed).toEqual(first);
  expect(runGit(["rev-parse", "HEAD"], resumed.path).trim()).toBe(head);
 });

 test("uses the registered location when an existing worktree was moved", async () => {
  const { repo, root } = trackedRepo();
  const first = await createWorktree({ slug: "deps", cwd: repo });
  const moved = join(root, "moved worktree");
  runGit(["worktree", "move", first.path, moved], repo);
  mkdirSync(first.path);
  const resumed = await createWorktree({ slug: "deps", cwd: repo });
  expect(resumed.path).toBe(moved);
  expect(runGit(["branch", "--show-current"], resumed.path).trim()).toBe(first.branch);
 });

 test("refuses an existing path with no matching branch and preserves its contents", async () => {
  const { repo } = trackedRepo();
  const target = expectedPath(repo, "deps");
  mkdirSync(target);
  write(target, "keep.txt", "owned data");
  await expect(createWorktree({ slug: "deps", cwd: repo })).rejects.toThrow(/path.*exists.*no matching branch/i);
  expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("owned data");
 });

 test("refuses an existing path when the branch is not checked out there", async () => {
  const { repo } = trackedRepo();
  const first = await createWorktree({ slug: "deps", cwd: repo });
  runGit(["worktree", "remove", first.path], repo);
  mkdirSync(first.path);
  write(first.path, "keep.txt", "owned data");
  await expect(createWorktree({ slug: "deps", cwd: repo })).rejects.toThrow(/not checked out/i);
  expect(readFileSync(join(first.path, "keep.txt"), "utf8")).toBe("owned data");
 });

 test("reports an unreadable configuration file as a warning", async () => {
  const { repo } = trackedRepo();
  write(repo, ".gitignore", ".env\n");
  runGit(["add", ".gitignore"], repo);
  runGit(["commit", "-q", "-m", "chore: ignore env"], repo);
  runGit(["push", "-q", "origin", "main"], repo);
  write(repo, ".env", "secret");
  chmodSync(join(repo, ".env"), 0o000);
  const diagnostics: string[] = [];
  try {
   await createWorktree({ slug: "deps", cwd: repo }, (text) => { diagnostics.push(text); });
  } finally {
   chmodSync(join(repo, ".env"), 0o600);
  }
  expect(diagnostics.join("")).toMatch(/dg-skills worktree: could not seed \.env/);
 });

 test.each(["branch", "path", "both"] as const)("resume:false refuses existing %s state", async (state) => {
  const { repo } = trackedRepo();
  const target = expectedPath(repo, "deps");
  if (state !== "path") runGit(["branch", "feature/deps"], repo);
  if (state !== "branch") mkdirSync(target);
  await expect(createWorktree({ slug: "deps", cwd: repo, resume: false })).rejects.toThrow(/state exists/);
  expect(existsSync(target)).toBe(state !== "branch");
 });

 test("copies ignored root and nested environment files while preserving private file mode", async () => {
  const { repo } = trackedRepo();
  const files = [".env", ".env.local", ".envrc", ".tool-versions", ".nvmrc", ".python-version", ".node-version", ".ruby-version", ".terraform-version", "api/.env", "packages/web/.env.local"];
  write(repo, ".gitignore", ".env*\n.envrc\n.tool-versions\n.*-version\n.nvmrc\n");
  runGit(["add", ".gitignore"], repo);
  runGit(["commit", "-q", "-m", "chore: ignore local configuration"], repo);
  runGit(["push", "-q", "origin", "main"], repo);
  for (const file of files) { write(repo, file, `fixture:${file}`); chmodSync(join(repo, file), 0o600); }
  write(repo, "node_modules/tool/.env", "never copy installed dependencies");
  write(repo, "packages/web/deeper/.env", "beyond bounded depth");
  const result = await createWorktree({ slug: "deps", cwd: repo });
  for (const file of files) {
   expect(readFileSync(join(result.path, file), "utf8")).toBe(`fixture:${file}`);
   expect(statSync(join(result.path, file)).mode & 0o777).toBe(0o600);
  }
  expect(existsSync(join(result.path, "node_modules/tool/.env"))).toBe(false);
  expect(existsSync(join(result.path, "packages/web/deeper/.env"))).toBe(false);
 });

 test("seeds an ignored visible directory symlink with its configuration bytes and private mode", async () => {
  const { repo, root } = trackedRepo();
  const config = join(root, "synthetic config");
  mkdirSync(config);
  write(config, ".env.local", "synthetic API configuration\n");
  chmodSync(join(config, ".env.local"), 0o600);
  write(repo, ".git/info/exclude", "api\n");
  symlinkSync(config, join(repo, "api"), "dir");
  const result = await createWorktree({ slug: "deps", cwd: repo });
  expect(readFileSync(join(result.path, "api/.env.local"), "utf8")).toBe("synthetic API configuration\n");
  expect(statSync(join(result.path, "api/.env.local")).mode & 0o777).toBe(0o600);
 });

 test("excludes hidden configuration directories at both bounded nested levels", async () => {
  const { repo } = trackedRepo();
  write(repo, ".git/info/exclude", ".hidden/\nvisible/.hidden/\n");
  write(repo, ".hidden/.env", "hidden root configuration");
  write(repo, "visible/.hidden/.env", "hidden nested configuration");
  const result = await createWorktree({ slug: "deps", cwd: repo });
  expect(existsSync(join(result.path, ".hidden/.env"))).toBe(false);
  expect(existsSync(join(result.path, "visible/.hidden/.env"))).toBe(false);
 });

 test("seed:false leaves ignored configuration out of the new worktree", async () => {
  const { repo } = trackedRepo();
  write(repo, ".env", "secret fixture");
  write(repo, "packages/web/.env.local", "nested fixture");
  const result = await createWorktree({ slug: "deps", cwd: repo, seed: false });
  expect(existsSync(join(result.path, ".env"))).toBe(false);
  expect(existsSync(join(result.path, "packages/web/.env.local"))).toBe(false);
 });

 test("an explicit base fetches the updated local origin branch before creation", async () => {
  const { repo, root, origin } = trackedRepo();
  const upstream = join(root, "upstream author");
  runGit(["clone", "-q", origin, upstream], root);
  runGit(["config", "user.email", "test@example.invalid"], upstream);
  runGit(["config", "user.name", "Test"], upstream);
  runGit(["checkout", "-q", "-b", "release"], upstream);
  const head = commitFile(upstream, "new-upstream.txt", "new", "feat: latest remote base");
  runGit(["push", "-q", "origin", "release"], upstream);
  const result = await createWorktree({ slug: "deps", cwd: repo, base: "release" });
  expect(runGit(["rev-parse", "HEAD"], result.path).trim()).toBe(head);
  expect(readFileSync(join(result.path, "new-upstream.txt"), "utf8")).toBe("new");
 });

 test("a failed origin fetch warns and permits an existing local remote ref", async () => {
  const { repo, origin } = trackedRepo();
  rmSync(origin, { recursive: true, force: true });
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
   const result = await createWorktree({ slug: "deps", cwd: repo });
   expect(runGit(["rev-parse", "HEAD"], result.path)).toBe(runGit(["rev-parse", "origin/main"], repo));
   expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toMatch(/fetch.*failed.*local ref/i);
  } finally { stderr.mockRestore(); }
 });

 test("returns data without stdout and writes dirty-state warnings to stderr", () => {
  const { repo } = trackedRepo();
  write(repo, ".agents/local.txt", "uncommitted planning");
  const proc = Bun.spawnSync([process.execPath, "-e", `import { createWorktree } from ${JSON.stringify(MODULE)}; const result = await createWorktree({ slug: "deps", cwd: ${JSON.stringify(repo)} }); console.log(JSON.stringify(result));`], { env: process.env });
  expect(proc.exitCode).toBe(0);
  const result = { path: expectedPath(repo, "deps"), branch: "feature/deps", origin: repo };
  expect(proc.stdout.toString()).toBe(`${JSON.stringify(result)}\n`);
  expect(proc.stderr.toString()).toMatch(/uncommitted changes/);
  expect(proc.stderr.toString()).toContain(".agents/");
  expect(existsSync(join(result.path, ".agents/local.txt"))).toBe(false);
 });

 test.each(["", "!!!", "   "])("rejects a slug normalized to empty: %j", async (slug) => {
  const { repo } = trackedRepo();
  await expect(createWorktree({ slug, cwd: repo })).rejects.toThrow(/slug/i);
  expect(runGit(["worktree", "list", "--porcelain"], repo).match(/^worktree /gm)).toHaveLength(1);
 });

 test("rejects a non-repository cwd", async () => {
  await expect(createWorktree({ slug: "deps", cwd: fixtures.tmp("deps-nonrepo-") })).rejects.toThrow(/git repo/i);
 });

 test("requires origin/HEAD when no base is supplied", async () => {
  const { repo } = trackedRepo();
  runGit(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], repo);
  await expect(createWorktree({ slug: "deps", cwd: repo })).rejects.toThrow(/origin\/HEAD/);
 });
});

describe("deps-upgrade prepare", () => {
 test("creates an actual worktree with no legacy helper on PATH and shares durable state across checkouts", () => {
  const { repo } = trackedRepo();
  const result = prepare(repo);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const branch = result.stdout.match(/^  branch: (.+)$/m)?.[1];
  const path = result.stdout.match(/^  path:   (.+)$/m)?.[1];
  expect(branch).toMatch(/^chore\/deps_update_\d{8}_\d{6}$/);
  expect(path).toMatch(/^\//);
  expect(result.stdout).toBe(`Worktree ready.\n  branch: ${branch}\n  path:   ${path}\n\nRun every remaining step from inside the worktree:\n  cd ${path}\n`);
  expect(runGit(["branch", "--show-current"], path!).trim()).toBe(branch!);
  const probe = (cwd: string) => {
   const proc = Bun.spawnSync([process.execPath, "-e", `import { scratchPaths } from ${JSON.stringify(join(import.meta.dir, "../src/deps-upgrade/index.ts"))}; console.log(JSON.stringify(scratchPaths()));`], { cwd, env: process.env });
   expect(proc.exitCode).toBe(0);
   return JSON.parse(proc.stdout.toString()) as Record<string, string>;
  };
  const mainState = probe(repo);
  expect(probe(path!)).toEqual(mainState);
  expect(readFileSync(mainState.branchFile, "utf8")).toBe(`${branch}\n`);
  for (const key of ["closedLog", "auditBefore", "auditAfter", "heldLog"]) expect(readFileSync(mainState[key], "utf8")).toBe("");
 });

 test("resumes the same timestamp worktree and clears previous run state", () => {
  const { repo, root } = trackedRepo();
  const preload = fixedPrepareTime(root);
  const first = prepare(repo, preload);
  expect(first.exitCode).toBe(0);
  const path = first.stdout.match(/^  path:   (.+)$/m)?.[1];
  expect(path).toMatch(/^\//);
  const head = commitFile(path!, "progress.txt", "keep progress", "feat: existing upgrade progress");
  const state = stateDir("deps-upgrade", { cwd: repo });
  const snapshots = ["closed-prs.txt", "audit-before.json", "audit-after.json", "held-by-cooldown.jsonl"];
  for (const file of snapshots) writeFileSync(join(state, file), "previous run");
  const second = prepare(repo, preload);
  expect(second.exitCode).toBe(0);
  expect(second.stderr).toBe("");
  expect(first.stderr).toBe("");
  expect(second.stdout).toBe(first.stdout);
  for (const file of snapshots) expect(readFileSync(join(state, file), "utf8")).toBe("");
  expect(runGit(["rev-parse", "HEAD"], path!).trim()).toBe(head);
  expect(runGit(["worktree", "list", "--porcelain"], repo).match(/^worktree /gm)).toHaveLength(2);
 });

 test("wraps a conflicting target directory in the legacy worktree-create error and preserves its files", () => {
  const { repo, root } = trackedRepo();
  const target = expectedPath(repo, "deps_update_20260304_050607");
  mkdirSync(target);
  write(target, "keep.txt", "existing target contents");
  const result = prepare(repo, fixedPrepareTime(root));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toStartWith("error: dg-skills worktree create failed:\n");
  expect(result.stderr).toContain(`dg-skills worktree: path ${target} exists but no matching branch — investigate manually\n`);
  expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("existing target contents");
  expect(runGit(["worktree", "list", "--porcelain"], repo).match(/^worktree /gm)).toHaveLength(1);
 });

 test("preserves native Git diagnostics and the actionable error when the branch is checked out elsewhere", () => {
  const { repo, root } = trackedRepo();
  const branch = "chore/deps_update_20260304_050607";
  const target = expectedPath(repo, "deps_update_20260304_050607");
  const elsewhere = join(root, "elsewhere checkout");
  runGit(["worktree", "add", elsewhere, "-b", branch, "origin/main"], repo);
  expect(existsSync(target)).toBe(false);
  const native = Bun.spawnSync(["git", "worktree", "add", target, branch], { cwd: repo, env: { ...process.env, LC_ALL: "C" } });
  expect(native.exitCode).not.toBe(0);
  const nativeStderr = native.stderr.toString();
  expect(nativeStderr).toContain("Preparing worktree");
  expect(nativeStderr).toContain("fatal:");
  const result = prepare(repo, fixedPrepareTime(root));
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
   `error: dg-skills worktree create failed:\n` +
   `branch ${branch} exists but worktree missing — recreating at ${target}\n` +
   nativeStderr +
   `dg-skills worktree: failed to add worktree at ${target}\n\n`,
  );
  expect(existsSync(target)).toBe(false);
  expect(runGit(["branch", "--show-current"], elsewhere).trim()).toBe(branch);
 });

 test("fails with a structured error when origin cannot be fetched", () => {
  const { repo, origin } = trackedRepo();
  rmSync(origin, { recursive: true, force: true });
  const result = prepare(repo);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.length).toBeGreaterThan(0);
  expect(result.stdout).toBe("");
  expect(runGit(["worktree", "list", "--porcelain"], repo).match(/^worktree /gm)).toHaveLength(1);
 });
});
