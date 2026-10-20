import { basename } from "node:path";
import type { Gap, Phase, ReqType, Requirement } from "./types";
import { locate, readText } from "./walk";

const SECRET_NAME =
	/(TOKEN|SECRET|PASSWORD|PASSWD|_PASS$|PRIVATE_KEY|API_?KEY|_KEY$|CONN_STR|CONNECTION_STRING|CREDENTIAL|_DSN$)/;

export function classifyEnvKey(key: string): "SECRET" | "CONFIG" {
	return SECRET_NAME.test(key) ? "SECRET" : "CONFIG";
}

interface RowInput {
	type: ReqType;
	name: string;
	value?: string;
	phase: Phase[];
	source: string;
	where: string;
	gaps?: Gap[];
}

function row(input: RowInput): Requirement {
	const { gaps = [], ...rest } = input;
	return { ...rest, proven: true, gaps };
}

function eachLine(
	files: string[],
	visit: (raw: string, line: number, file: string) => void,
): void {
	for (const file of files) {
		const text = readText(file);
		if (text === null) continue;
		text.split("\n").forEach((raw, i) => {
			visit(raw, i + 1, file);
		});
	}
}

function isSampleEnv(path: string): boolean {
	return /\.(sample|example|template)$/.test(path);
}

export function parseEnvFile(text: string): { key: string; line: number }[] {
	const out: { key: string; line: number }[] = [];
	text.split("\n").forEach((raw, i) => {
		if (raw.trimStart().startsWith("#")) return;
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
		if (m?.[1] && !m[1].startsWith("_")) out.push({ key: m[1], line: i + 1 });
	});
	return out;
}

export function extractEnv(root: string, files: string[]): Requirement[] {
	const envFiles = files.filter((f) =>
		/(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/.test(f),
	);
	const parsed = new Map<string, { key: string; line: number }[]>();
	for (const f of envFiles) {
		const text = readText(f);
		if (text !== null) parsed.set(f, parseEnvFile(text));
	}

	const sampleKeys = new Set<string>();
	for (const [f, keys] of parsed) {
		if (isSampleEnv(f)) for (const k of keys) sampleKeys.add(k.key);
	}
	const hasSample = sampleKeys.size > 0;

	const out: Requirement[] = [];
	for (const [f, keys] of parsed) {
		const sample = isSampleEnv(f);
		for (const { key, line } of keys) {
			const gaps: Gap[] = [];
			if (!sample && hasSample && !sampleKeys.has(key)) {
				gaps.push({
					kind: "undocumented",
					detail: `in ${basename(f)}, missing from the committed sample`,
				});
			}
			out.push(
				row({
					type: classifyEnvKey(key),
					name: key,
					phase: ["dev"],
					source: sample ? ".env.sample" : ".env",
					where: locate(root, f, line),
					gaps,
				}),
			);
		}
	}
	return out;
}

export function extractWorkflows(root: string, files: string[]): Requirement[] {
	const out: Requirement[] = [];
	const workflows = files.filter((f) =>
		/\.github\/workflows\/[^/]+\.ya?ml$/.test(f),
	);
	eachLine(workflows, (raw, line, file) => {
		const where = locate(root, file, line);

		for (const m of raw.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)) {
			const name = m[1];
			if (!name || name === "GITHUB_TOKEN") continue;
			out.push(
				row({
					type: "SECRET",
					name,
					phase: ["build"],
					source: "gh-secret",
					where,
				}),
			);
		}

		const role = /role-to-assume:\s*["']?([^"'\s]+)/.exec(raw)?.[1];
		if (role) {
			out.push(
				row({
					type: "CLOUD_PERM",
					name: role.split("/").pop() || role,
					value: role,
					phase: ["build"],
					source: "gh-oidc",
					where,
				}),
			);
		}

		const registry =
			/^\s*registry:\s*["']?([A-Za-z0-9.-]+\.[A-Za-z]{2,}[^"'\s]*)/.exec(
				raw,
			)?.[1];
		if (registry) {
			out.push(
				row({
					type: "REGISTRY",
					name: registry,
					phase: ["build"],
					source: "gh-workflow",
					where,
				}),
			);
		}
	});
	return out;
}

export function extractTerraform(root: string, files: string[]): Requirement[] {
	const out: Requirement[] = [];
	for (const f of files.filter((p) => p.endsWith(".tf"))) {
		const text = readText(f);
		if (text === null) continue;

		let mode: "secret" | "config" | null = null;
		let depth = 0;

		text.split("\n").forEach((raw, i) => {
			const where = locate(root, f, i + 1);

			if (mode === null) {
				if (/container_secrets\s*=\s*\[/.test(raw)) {
					mode = "secret";
					depth = 0;
				} else if (/container_environment\s*=\s*\[/.test(raw)) {
					mode = "config";
					depth = 0;
				}
			}

			if (mode !== null) {
				depth +=
					(raw.match(/\[/g) || []).length - (raw.match(/\]/g) || []).length;
				const named = /name\s*=\s*"([^"]+)"/.exec(raw)?.[1];
				if (named) {
					out.push(
						row({
							type: mode === "secret" ? "SECRET" : "CONFIG",
							name: named,
							phase: ["run"],
							source: mode === "secret" ? "secrets-mgr" : "tfc-varset",
							where,
						}),
					);
				}
				if (depth <= 0) mode = null;
				return;
			}

			const iam = /resource\s+"(aws_iam_[a-z_]+)"\s+"([^"]+)"/.exec(raw);
			if (iam?.[1] && iam[2]) {
				out.push(
					row({
						type: "CLOUD_PERM",
						name: iam[2],
						value: iam[1],
						phase: ["run"],
						source: "terraform",
						where,
					}),
				);
			}

			const secret = /resource\s+"aws_secretsmanager_secret"\s+"([^"]+)"/.exec(
				raw,
			)?.[1];
			if (secret) {
				out.push(
					row({
						type: "SECRET",
						name: secret,
						phase: ["run"],
						source: "secrets-mgr",
						where,
					}),
				);
			}

			const version = /required_version\s*=\s*"([^"]+)"/.exec(raw)?.[1];
			if (version) {
				out.push(
					row({
						type: "TOOLCHAIN",
						name: "terraform",
						value: version,
						phase: ["build"],
						source: "terraform",
						where,
					}),
				);
			}
		});
	}
	return out;
}

export function extractDockerfile(
	root: string,
	files: string[],
): Requirement[] {
	const out: Requirement[] = [];
	const dockerfiles = files.filter((p) =>
		/(^|\/)Dockerfile(\.[A-Za-z0-9_-]+)?$/.test(p),
	);
	eachLine(dockerfiles, (raw, line, file) => {
		const where = locate(root, file, line);

		const expose = /^\s*EXPOSE\s+(\d+)/i.exec(raw)?.[1];
		if (expose) {
			out.push(
				row({
					type: "NETWORK",
					name: `:${expose} ingress`,
					value: expose,
					phase: ["run"],
					source: "dockerfile",
					where,
				}),
			);
		}

		const env = /^\s*ENV\s+([A-Z_][A-Z0-9_]*)[=\s]/i.exec(raw)?.[1];
		if (env) {
			out.push(
				row({
					type: classifyEnvKey(env),
					name: env,
					phase: ["build", "run"],
					source: "dockerfile",
					where,
				}),
			);
		}

		const image = /^\s*FROM\s+(\S+)/i.exec(raw)?.[1];
		if (image && !image.startsWith("$")) {
			const tagged = image.split(":");
			out.push(
				row({
					type: "TOOLCHAIN",
					name: tagged[0] ?? image,
					value: tagged.length > 1 ? tagged[tagged.length - 1] : undefined,
					phase: ["build"],
					source: "dockerfile",
					where,
				}),
			);
			const host = (image.split("/")[0] ?? "").split(":")[0] ?? "";
			if (image.includes("/") && (host.includes(".") || host === "localhost")) {
				out.push(
					row({
						type: "REGISTRY",
						name: host,
						phase: ["build"],
						source: "dockerfile",
						where,
					}),
				);
			}
		}
	});
	return out;
}

export function extractCompose(root: string, files: string[]): Requirement[] {
	const out: Requirement[] = [];
	for (const f of files.filter((p) =>
		/(^|\/)(docker-)?compose(\.[A-Za-z0-9_-]+)?\.ya?ml$/.test(p),
	)) {
		const text = readText(f);
		if (text === null) continue;

		let inServices = false;
		text.split("\n").forEach((raw, i) => {
			const where = locate(root, f, i + 1);

			if (/^services:\s*$/.test(raw)) {
				inServices = true;
				return;
			}
			if (/^[A-Za-z]/.test(raw)) inServices = false;
			if (!inServices) return;

			const service = /^ {2}([A-Za-z0-9._-]+):\s*$/.exec(raw)?.[1];
			if (service) {
				out.push(
					row({
						type: "SERVICE",
						name: service,
						phase: ["dev"],
						source: "compose",
						where,
					}),
				);
			}

			const port = /^\s*-\s*["']?(\d+):(\d+)/.exec(raw)?.[1];
			if (port) {
				out.push(
					row({
						type: "NETWORK",
						name: `:${port} published`,
						value: port,
						phase: ["dev"],
						source: "compose",
						where,
					}),
				);
			}
		});
	}
	return out;
}

const TOOLCHAIN_FILES = [
	"mise.toml",
	"global.json",
	".nvmrc",
	"package.json",
	"pyproject.toml",
];

export function extractToolchain(root: string, files: string[]): Requirement[] {
	const out: Requirement[] = [];
	const push = (
		name: string,
		value: string | undefined,
		source: string,
		file: string,
		line: number,
	) => {
		out.push(
			row({
				type: "TOOLCHAIN",
				name,
				value,
				phase: ["dev", "build"],
				source,
				where: locate(root, file, line),
			}),
		);
	};

	for (const f of files) {
		const base = basename(f);
		if (!TOOLCHAIN_FILES.includes(base)) continue;
		const text = readText(f);
		if (text === null) continue;
		const lines = text.split("\n");

		if (base === "mise.toml") {
			let inTools = false;
			lines.forEach((raw, i) => {
				if (/^\[tools\]/.test(raw)) {
					inTools = true;
					return;
				}
				if (/^\[/.test(raw)) inTools = false;
				if (!inTools) return;
				const tool = /^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/.exec(raw);
				if (tool?.[1]) push(tool[1], tool[2], "mise", f, i + 1);
			});
		}

		if (base === "global.json") {
			lines.forEach((raw, i) => {
				const version = /"version"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
				if (version) push("dotnet", version, "global.json", f, i + 1);
			});
		}

		if (base === ".nvmrc") {
			const value = text.trim();
			if (value) push("node", value.replace(/^v/, ""), "nvmrc", f, 1);
		}

		if (base === "package.json") {
			let inEngines = false;
			lines.forEach((raw, i) => {
				if (/"engines"\s*:\s*\{/.test(raw)) {
					inEngines = true;
					return;
				}
				if (!inEngines) return;
				if (/\}/.test(raw)) {
					inEngines = false;
					return;
				}
				const engine = /"([A-Za-z0-9_-]+)"\s*:\s*"([^"]+)"/.exec(raw);
				if (engine?.[1]) push(engine[1], engine[2], "package.json", f, i + 1);
			});
		}

		if (base === "pyproject.toml") {
			lines.forEach((raw, i) => {
				const python = /^\s*requires-python\s*=\s*["']([^"']+)["']/.exec(
					raw,
				)?.[1];
				if (python) push("python", python, "pyproject.toml", f, i + 1);
			});
		}
	}
	return out;
}

function parseFeed(url: string): { host: string; value: string } | null {
	try {
		const { protocol, host, pathname } = new URL(url);
		return { host, value: `${protocol}//${host}${pathname}` };
	} catch {
		return null;
	}
}

export function extractRegistries(
	root: string,
	files: string[],
): Requirement[] {
	const out: Requirement[] = [];
	for (const f of files) {
		const base = basename(f).toLowerCase();
		if (base !== "nuget.config" && base !== ".npmrc") continue;
		const nuget = base === "nuget.config";
		const pattern = nuget
			? /value="(https?:\/\/[^"]+)"/
			: /registry\s*=\s*(https?:\/\/\S+)/;
		const text = readText(f);
		if (text === null) continue;

		text.split("\n").forEach((raw, i) => {
			const url = pattern.exec(raw)?.[1];
			if (!url) return;
			const feed = parseFeed(url);
			if (!feed) return;
			out.push(
				row({
					type: "REGISTRY",
					name: feed.host,
					value: feed.value,
					phase: ["dev", "build"],
					source: nuget ? "nuget.config" : "npmrc",
					where: locate(root, f, i + 1),
				}),
			);
		});
	}
	return out;
}
