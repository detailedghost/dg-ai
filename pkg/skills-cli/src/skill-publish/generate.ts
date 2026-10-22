import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLI_VERSION, DEFAULT_POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS, LOCAL_ZONE_FIELDS, type Manifest, TEMPLATE_VERSION } from "./types";

export function toPortable(manifest: Manifest): Manifest {
	const copy = { ...manifest };
	for (const field of LOCAL_ZONE_FIELDS) delete (copy as Record<string, unknown>)[field];
	return copy;
}

function generateUpdateSubcommand(manifest: Manifest, repoOwner?: string): string {
	if (!repoOwner) {
		return `
// ── update subcommand ──────────────────────────────────────────────────────────
async function cmdUpdate(_args: string[]): Promise<void> {
  process.stderr.write(
    "update not configured (zip build) — repackage with --repo to enable auto-update.\\n",
  );
  process.exit(1);
}
`;
	}
	return `
// ── update subcommand ──────────────────────────────────────────────────────────
// Built in — no CC/gh/Bun dependency. HTTPS only; SHA256 verify before swap.

/** Throws if url is not https:. Call before any network request. */
export function assertHttpsUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(\`update: refusing non-HTTPS URL: \${url}\`);
  }
}

/** Normalize a hostname for comparison: lowercase + strip a trailing dot (api.github.com. === api.github.com). */
export function normHost(h: string): string {
  return h.toLowerCase().replace(/\\.$/, "");
}

/** True only for GitHub API / asset hosts — gates every update request URL, not just redirects. */
export function isGithubHost(host: string): boolean {
  const h = normHost(host);
  return h === "api.github.com" || h.endsWith(".github.com") || h.endsWith(".githubusercontent.com");
}

/**
 * Returns the Authorization header map to use for requestUrl.
 * Includes the header for the api host; omits it for any other host (CDN redirect).
 */
export function authHeadersFor(
  requestUrl: string,
  apiHost: string,
  token: string | undefined,
  stripAuthOnRedirect: boolean,
): Record<string, string> {
  const parsed = new URL(requestUrl);
  const isApiHost = normHost(parsed.hostname) === normHost(apiHost);
  const headers: Record<string, string> = {
    "User-Agent": "skill-publish-updater/1.0",
    Accept: "application/octet-stream",
  };
  if (token && (isApiHost || !stripAuthOnRedirect)) {
    headers["Authorization"] = \`Bearer \${token}\`;
  }
  return headers;
}

/**
 * Verifies bytes against the matching line in sha256sumsText.
 * Throws with "SHA256 mismatch" if the hash does not match. Must be called before any file write.
 */
export function verifyAsset(bytes: Buffer, sha256sumsText: string, assetName: string): void {
  const matches = sha256sumsText
    .split("\\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { const parts = l.split(/\\s+/); return { hash: parts[0], name: (parts[1] ?? "").replace(/^\\*/, "") }; })
    .filter((e) => e.name === assetName);
  if (matches.length === 0) throw new Error(\`SHA256SUMS does not contain an entry for \${assetName}.\`);
  if (matches.length > 1) throw new Error(\`SHA256SUMS has multiple entries for \${assetName}.\`);
  const expectedHash = matches[0].hash;
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      \`SHA256 mismatch for \${assetName}:\\n  expected: \${expectedHash}\\n  actual:   \${actualHash}\`,
    );
  }
}

/**
 * Atomically writes bytes to tmpPath then renames it over selfPath.
 * Cleans up tmpPath on any failure before re-throwing.
 */
export function atomicSwap(tmpPath: string, selfPath: string, bytes: Buffer): void {
  try {
    _writeFileSync(tmpPath, bytes);
    _chmodSync(tmpPath, 0o755);
    _renameSync(tmpPath, selfPath);
  } catch (err) {
    try { _unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

async function cmdUpdate(args: string[]): Promise<void> {
  const isDryRun = args.includes("--dry-run");
  const repoOwner = ${JSON.stringify(repoOwner)};
  const repoName = ${JSON.stringify(manifest.name)};
  const currentVersion = ${JSON.stringify(manifest.version)};

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? await getGhAuthToken();

  let latestRelease: Record<string, unknown>;
  try {
    latestRelease = await httpsGetJson(
      \`https://api.github.com/repos/\${repoOwner}/\${repoName}/releases/latest\`,
      token,
    ) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("auth") || msg.includes("401") || msg.includes("404")) {
      process.stderr.write(
        \`update requires GH_TOKEN or GITHUB_TOKEN (private repo). Set the env var and retry.\\n\`,
      );
      process.exit(1);
    }
    process.stderr.write(\`update failed: \${msg}\\n\`);
    process.exit(1);
  }

  const latestTag = latestRelease.tag_name as string | undefined;
  if (!latestTag) {
    process.stderr.write("update: release has no tag_name (malformed release).\\n");
    process.exit(1);
  }
  const latestVersion = latestTag.replace(/^v/, "");

  if (latestVersion === currentVersion) {
    process.stdout.write(\`Already up to date: \${currentVersion}\\n\`);
    process.exit(0);
  }

  if (isDryRun) {
    process.stdout.write(\`Would update \${currentVersion} → \${latestVersion}\\n\`);
    process.exit(0);
  }

  const platform = process.platform;
  let assetName: string;
  if (platform === "darwin") assetName = \`\${repoName}-macos\`;
  else if (platform === "win32") assetName = \`\${repoName}-windows.exe\`;
  else assetName = \`\${repoName}-linux\`;

  const assets = (latestRelease.assets ?? []) as Array<Record<string, string>>;
  const sha256Asset = assets.find((a) => a.name === "SHA256SUMS");
  if (!sha256Asset) {
    process.stderr.write("SHA256SUMS not found in release assets.\\n");
    process.exit(1);
  }

  let sha256sums: string;
  try {
    sha256sums = await httpsGetString(sha256Asset.url, token, { stripAuthOnRedirect: true });
  } catch (err) {
    process.stderr.write(\`Failed to download SHA256SUMS: \${err}\\n\`);
    process.exit(1);
  }

  const binaryAsset = assets.find((a) => a.name === assetName);
  if (!binaryAsset) {
    process.stderr.write(\`Asset \${assetName} not found in release.\\n\`);
    process.exit(1);
  }

  let assetBytes: Buffer;
  try {
    assetBytes = await httpsGetBuffer(binaryAsset.url, token, { stripAuthOnRedirect: true });
  } catch (err) {
    process.stderr.write(\`Failed to download \${assetName}: \${err}\\n\`);
    process.exit(1);
  }

  verifyAsset(assetBytes, sha256sums, assetName);

  const selfPath = process.execPath;
  const tmpPath = selfPath + ".new";
  try {
    atomicSwap(tmpPath, selfPath, assetBytes);
  } catch (err) {
    process.stderr.write(\`Swap failed: \${err}\\n\`);
    process.exit(1);
  }

  process.stdout.write(\`Updated \${currentVersion} → \${latestVersion}\\n\`);
}

async function getGhAuthToken(): Promise<string | undefined> {
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch { /* gh not available */ }
  return undefined;
}

/** HTTPS GET returning parsed JSON. Strips auth on any cross-host redirect (keeps it only for api.github.com). */
async function httpsGetJson(url: string, token: string | undefined): Promise<unknown> {
  const text = await httpsGetString(url, token, { stripAuthOnRedirect: true });
  return JSON.parse(text);
}

async function httpsGetString(
  url: string,
  token: string | undefined,
  opts: { stripAuthOnRedirect: boolean },
): Promise<string> {
  const buf = await httpsGetBuffer(url, token, opts);
  return buf.toString("utf-8");
}

async function httpsGetBuffer(
  url: string,
  token: string | undefined,
  opts: { stripAuthOnRedirect: boolean },
  redirectCount = 0,
): Promise<Buffer> {
  const { get: httpsGet } = await import("node:https");

  assertHttpsUrl(url);
  const parsed = new URL(url);
  if (!isGithubHost(parsed.hostname)) {
    return Promise.reject(new Error(\`update: refusing non-GitHub host: \${parsed.hostname}\`));
  }
  const headers = authHeadersFor(url, "api.github.com", token, opts.stripAuthOnRedirect);
  const MAX_BYTES = 256 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const req = httpsGet({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        if (redirectCount >= 5) return reject(new Error("update: too many redirects"));
        const location = res.headers.location ?? "";
        const redirectParsed = new URL(location, url);
        try { assertHttpsUrl(redirectParsed.toString()); } catch (e) {
          return reject(new Error(\`update: redirect to non-HTTPS URL blocked: \${location}\`));
        }
        const stripAuth = opts.stripAuthOnRedirect && normHost(redirectParsed.hostname) !== "api.github.com";
        return httpsGetBuffer(redirectParsed.toString(), stripAuth ? undefined : token, opts, redirectCount + 1)
          .then(resolve)
          .catch(reject);
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        return reject(new Error(\`auth failure (HTTP \${res.statusCode})\`));
      }
      if (res.statusCode === 404) {
        return reject(new Error(\`not found (HTTP 404): \${url}\`));
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(\`HTTP \${res.statusCode}: \${url}\`));
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_BYTES) { req.destroy(new Error("update: download exceeded size cap")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error(\`update: request timed out: \${url}\`)));
    req.on("error", reject);
  });
}
`;
}

function generateServerSource(manifest: Manifest, repoOwner?: string): string {
	const serverName = manifest.name;
	const guideToolName = `${serverName}_guide`;
	const recipePromptName = `${serverName}_recipe`;
	const stdoutCap = manifest.stdout_size_cap ?? 0;
	const isSerial = manifest.concurrency === "serial";
	const slowThresholdMs = 5000;

	const toolRegistrations = manifest.tools
		.map((tool) => {
			const descWithLatency =
				tool.slow || (tool.poll_interval_hint && tool.poll_interval_hint >= slowThresholdMs)
					? `${tool.description} (this tool may be slow)`
					: tool.description;

			return `  {
    name: ${JSON.stringify(tool.name)},
    description: ${JSON.stringify(descWithLatency)},
    inputSchema: ${JSON.stringify(tool.inputSchema, null, 4).split("\n").join("\n    ")},
  }`;
		})
		.join(",\n");

	const toolHandlers = manifest.tools
		.map((tool) => {
			if (tool.long_running) {
				const hint = tool.poll_interval_hint ?? DEFAULT_POLL_INTERVAL_MS;
				const timeoutMs = tool.timeout_ms ?? DEFAULT_TIMEOUT_MS;
				return `  if (toolName === ${JSON.stringify(tool.name)}) {
    const start = Date.now();
    const result = await runSubprocess(${JSON.stringify(tool.name)}, toolArgs, TOOL_SCHEMAS[${JSON.stringify(tool.name)}], ${stdoutCap}, ${timeoutMs}, true);
    process.stderr.write(\`[${serverName}] ${tool.name} elapsed: \${Date.now() - start}ms\\n\`);
    if (result === null) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "pending", message: "call again", poll_interval_hint: ${hint} }) }] };
    }
    return { content: [{ type: "text", text: result }] };
  }`;
			}
			return `  if (toolName === ${JSON.stringify(tool.name)}) {
    const start = Date.now();
    const output = await runSubprocess(${JSON.stringify(tool.name)}, toolArgs, TOOL_SCHEMAS[${JSON.stringify(tool.name)}], ${stdoutCap}, ${DEFAULT_TIMEOUT_MS}, false);
    process.stderr.write(\`[${serverName}] ${tool.name} elapsed: \${Date.now() - start}ms\\n\`);
    return { content: [{ type: "text", text: output ?? "" }] };
  }`;
		})
		.join("\n");

	const mutexBlock = isSerial
		? `
let _serialQueue: Promise<unknown> = Promise.resolve();
function withSerial<T>(fn: () => Promise<T>): Promise<T> {
  const next = _serialQueue.then(() => fn());
  _serialQueue = next.then(() => {}, () => {});
  return next;
}
`
		: "";

	const toolCallExpr = isSerial ? "withSerial(() => handleTool(toolName, toolArgs))" : "handleTool(toolName, toolArgs)";
	const updateSubcommand = generateUpdateSubcommand(manifest, repoOwner);
	const argMappings = Object.fromEntries(manifest.tools.map((t) => [t.name, t.arg_mapping ?? []]));

	return `// Generated by skill-publish v${CLI_VERSION} | template-version: ${TEMPLATE_VERSION}
// Server: ${serverName} v${manifest.version} — DO NOT EDIT (re-run skill-publish generate)

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { writeFileSync as _writeFileSync, renameSync as _renameSync, chmodSync as _chmodSync, unlinkSync as _unlinkSync } from "node:fs";

const __sub = process.argv[2];
const __TOOL_SUBCOMMANDS = new Set(${JSON.stringify(manifest.tools.map((t) => t.name))});
let __dispatched = false;
if (import.meta.main && __sub === "update") {
  await (cmdUpdate as (args: string[]) => Promise<void>)(process.argv.slice(3));
  process.exit(0);
}

const MANIFEST = ${JSON.stringify(manifest, null, 2)};

const TOOL_SCHEMAS: Record<string, Record<string, unknown>> = ${JSON.stringify(
		Object.fromEntries(manifest.tools.map((t) => [t.name, t.inputSchema])),
		null,
		2,
	)};

const ARG_MAPPINGS: Record<string, Array<{ positional?: string; flag?: string; bool_flag?: string; as?: string }>> = ${JSON.stringify(
		argMappings,
		null,
		2,
	)};
${mutexBlock}
const TOOLS = [
${toolRegistrations},
  {
    name: ${JSON.stringify(guideToolName)},
    description: "Returns orchestration guidance for ${serverName}. Read this before using other tools.",
    inputSchema: { type: "object", properties: {} },
  },
];

const PROMPTS = [
  {
    name: ${JSON.stringify(recipePromptName)},
    description: "Orchestration guidance for ${serverName}",
    arguments: [],
  },
];

function buildArgList(toolName: string, args: Record<string, unknown>): string[] {
  const safe = (name: string, v: unknown): string => {
    const s = String(v);
    if (typeof v === "string" && s.startsWith("-")) {
      throw new Error(\`Argument "\${name}" must not start with "-" (got "\${s}").\`);
    }
    return s;
  };
  const mapping = ARG_MAPPINGS[toolName] ?? [];
  if (mapping.length === 0) {
    const out: string[] = [];
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "boolean") { if (v) out.push(\`--\${k}\`); continue; }
      if (Array.isArray(v)) { for (const el of v) out.push(\`--\${k}\`, safe(k, el)); continue; }
      if (typeof v === "object") throw new Error(\`Argument "\${k}" is an object; objects cannot be passed to "\${toolName}".\`);
      out.push(\`--\${k}\`, safe(k, v));
    }
    return out;
  }
  const out: string[] = [];
  for (const m of mapping) {
    if (m.positional !== undefined) {
      const v = args[m.positional];
      if (v !== undefined) out.push(safe(m.positional, v));
    } else if (m.flag !== undefined) {
      const v = args[m.flag];
      if (v !== undefined) out.push(m.as ?? \`--\${m.flag}\`, safe(m.flag, v));
    } else if (m.bool_flag !== undefined) {
      if (args[m.bool_flag] === true) out.push(m.as ?? \`--\${m.bool_flag}\`);
    }
  }
  return out;
}

async function runSubprocess(
  toolName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
  capBytes: number,
  timeoutMs: number,
  pendingOnTimeout: boolean,
): Promise<string | null> {
  const allowedProps = (schema.properties ?? {}) as Record<string, unknown>;
  const required = (schema.required ?? []) as string[];
  for (const req of required) {
    if (!(req in args)) throw new Error(\`Missing required argument "\${req}" for tool "\${toolName}".\`);
  }
  for (const key of Object.keys(args)) {
    if (!(key in allowedProps)) {
      throw new Error(\`Unknown argument "\${key}" for tool "\${toolName}". Allowed: \${Object.keys(allowedProps).join(", ") || "(none)"}\`);
    }
    const declared = (allowedProps[key] as Record<string, unknown> | undefined)?.type as string | undefined;
    if (declared) {
      const v = args[key];
      const ok = declared === "integer" ? (typeof v === "number" && Number.isInteger(v))
        : declared === "number" ? typeof v === "number"
        : declared === "array" ? Array.isArray(v)
        : declared === "object" ? (typeof v === "object" && v !== null && !Array.isArray(v))
        : typeof v === declared;
      if (!ok) throw new Error(\`Argument "\${key}" must be \${declared}, got \${Array.isArray(v) ? "array" : typeof v}\`);
    }
  }
  const argList = buildArgList(toolName, args);
  const proc = Bun.spawn([process.execPath, toolName, ...argList], { stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  let capped = false;
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs) : undefined;

  const errPromise = new Response(proc.stderr).text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (capBytes > 0 && total > capBytes) { capped = true; proc.kill(); break; }
    }
  } catch { /* stream torn down by kill() */ }

  const err = await errPromise;
  const exitCode = await proc.exited;
  if (timer !== undefined) clearTimeout(timer);

  if (timedOut && !capped) return pendingOnTimeout ? null : \`\${toolName} timed out after \${timeoutMs}ms\`;

  const outBuf = Buffer.concat(chunks);
  if (exitCode !== 0 && !capped) {
    return (outBuf.toString("utf-8") + err).trim() || \`\${toolName} exited with code \${exitCode}\`;
  }
  if (capBytes > 0 && outBuf.length > capBytes) {
    return outBuf.subarray(0, capBytes).toString("utf-8") + \`\\n[truncated: response exceeded \${capBytes} bytes]\`;
  }
  return outBuf.toString("utf-8");
}

async function handleTool(toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> {
  if (toolName === ${JSON.stringify(guideToolName)}) {
    return { content: [{ type: "text", text: MANIFEST.recipe }] };
  }

${toolHandlers}

  return { content: [{ type: "text", text: \`Unknown tool: \${toolName}\` }], isError: true };
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

if (import.meta.main && !__dispatched) {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = msg.id;
    const method = msg.method as string;
    const params = (msg.params ?? {}) as Record<string, unknown>;

    try {
      if (method === "initialize") {
        send({
          jsonrpc: "2.0", id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, prompts: {} },
            serverInfo: { name: ${JSON.stringify(serverName)}, version: ${JSON.stringify(manifest.version)} },
          },
        });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        const toolName = params.name as string;
        const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
        const result = await ${toolCallExpr};
        send({ jsonrpc: "2.0", id, result });
      } else if (method === "prompts/list") {
        send({ jsonrpc: "2.0", id, result: { prompts: PROMPTS } });
      } else if (method === "prompts/get") {
        const promptName = params.name as string;
        if (promptName === ${JSON.stringify(recipePromptName)}) {
          send({
            jsonrpc: "2.0", id,
            result: {
              description: \`Orchestration guidance for ${serverName}\`,
              messages: [{ role: "user", content: { type: "text", text: MANIFEST.recipe } }],
            },
          });
        } else {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: \`Prompt not found: \${promptName}\` } });
        }
      } else if (method === "notifications/initialized") {
        // no-op
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: \`Method not found: \${method}\` } });
      }
    } catch (err) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err) } });
    }
  });

  process.stderr.write(\`[${serverName}] MCP server ready (v${manifest.version})\\n\`);
}

${updateSubcommand}
`;
}

export function cmdGenerate(args: string[]): number {
	let manifestPath = "";
	let outDir = "";
	let repoOwner: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out-dir" && i + 1 < args.length) outDir = args[++i];
		else if (args[i] === "--repo-owner" && i + 1 < args.length) repoOwner = args[++i];
		else if (!args[i].startsWith("-")) manifestPath = args[i];
	}

	if (!manifestPath) {
		process.stderr.write("Usage: skill-publish generate <manifest-path> [--out-dir <dir>] [--repo-owner <owner>]\n");
		return 1;
	}

	const absManifest = resolve(manifestPath);
	if (!existsSync(absManifest)) {
		process.stderr.write(`Manifest not found: ${absManifest}\n`);
		return 1;
	}

	let manifest: Manifest;
	try {
		manifest = JSON.parse(readFileSync(absManifest, "utf-8")) as Manifest;
	} catch (e) {
		process.stderr.write(`Invalid manifest JSON: ${e}\n`);
		return 1;
	}

	if (!manifest.name) {
		process.stderr.write("Manifest is missing a name.\n");
		return 1;
	}
	if (!/^[a-z][a-z0-9-]*$/.test(manifest.name)) {
		process.stderr.write(`Unsafe manifest name "${manifest.name}" — must match ^[a-z][a-z0-9-]*$.\n`);
		return 1;
	}
	if (repoOwner !== undefined && !/^[A-Za-z0-9-]+$/.test(repoOwner)) {
		process.stderr.write(`Unsafe --repo-owner "${repoOwner}" — must match ^[A-Za-z0-9-]+$.\n`);
		return 1;
	}

	const portable = toPortable(manifest);
	const targetDir = outDir ? resolve(outDir) : join(dirname(absManifest), `${manifest.name}-server`);
	mkdirSync(targetDir, { recursive: true });

	const serverSource = generateServerSource(portable, repoOwner);
	writeFileSync(join(targetDir, "server.ts"), serverSource);

	const pkgJson = {
		name: `${manifest.name}-mcp-server`,
		version: manifest.version,
		type: "module",
		scripts: { start: "bun run server.ts" },
	};
	writeFileSync(join(targetDir, "package.json"), JSON.stringify(pkgJson, null, 2));

	process.stdout.write(`${targetDir}\n`);
	return 0;
}
