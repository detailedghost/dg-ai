import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { scratchRoot, writeFileAtomic } from "@dg/common/node";
import type { CommandResult, HookContext, HookHandler } from "../types";

interface Formatter {
	bin: string;
	args: (file: string) => string[];
}

const SIMPLE = new Map<string, Formatter>(
	Object.entries({
		py: { bin: "ruff", args: (f) => ["format", "--quiet", f] },
		go: { bin: "gofmt", args: (f) => ["-w", f] },
		tf: { bin: "terraform", args: (f) => ["fmt", f] },
		lua: { bin: "stylua", args: (f) => [f] },
		dart: { bin: "dart", args: (f) => ["format", f] },
		bzl: { bin: "black", args: (f) => ["--quiet", f] },
	} satisfies Record<string, Formatter>),
);

const BAZEL_FILES = new Set([
	"BUILD",
	"BUILD.bazel",
	"WORKSPACE",
	"WORKSPACE.bazel",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const BIOME_MISSING = "biome";
const biomeReal = new Map<string, boolean>();
const MD_SKIP =
	/(^|\/)(\.claude|\.agents|CLAUDE\.md|AGENTS\.md|MEMORY\.md|SKILL\.md)(\/|$)|\.opencode\/agents\/|-(spec|plan|refactor)\.md$|(^|\/)refactor-[^/]*\.md$/;

class Formatting {
	readonly missing = new Set<string>();
	readonly failed: string[] = [];

	constructor(
		private readonly file: string,
		private readonly ctx: HookContext,
	) {}

	have(bin: string): boolean {
		if (this.ctx.seams.which(bin)) return true;
		this.missing.add(bin);
		return false;
	}

	probe(argv: string[], cwd?: string) {
		return this.ctx.seams.run(argv, { cwd });
	}

	async exec(argv: string[], cwd?: string): Promise<CommandResult> {
		const result = await this.probe(argv, cwd);
		if (result.status !== 0) {
			const reason = result.stderr.trim().split("\n", 1)[0] ?? "";
			this.failed.push(
				`${basename(argv[0] ?? "")} failed (status ${result.status})${reason ? `: ${reason}` : ""}`,
			);
		}
		return result;
	}

	async biomeIsReal(bin: string): Promise<boolean> {
		const marker = join(
			this.ctx.scratchDir,
			`biome-real.${createHash("sha1").update(bin).digest("hex")}`,
		);
		const cached = biomeReal.get(marker);
		if (cached !== undefined) return cached;
		let real: boolean;
		try {
			real = readFileSync(marker, "utf8") === "1";
		} catch {
			const { stdout } = await this.probe([bin, "--version"]);
			real = stdout.includes("Biome") || stdout.includes("Version:");
			mkdirSync(this.ctx.scratchDir, { recursive: true, mode: 0o700 });
			writeFileSync(marker, real ? "1" : "0");
		}
		biomeReal.set(marker, real);
		return real;
	}

	private async resolveBiome(): Promise<
		{ bin: string; configDir?: string } | undefined
	> {
		let bin: string | undefined;
		let configDir: string | undefined;
		const home = this.ctx.env["HOME"];
		for (
			let dir = dirname(this.file);
			dir !== dirname(dir);
			dir = dirname(dir)
		) {
			const local = join(dir, "node_modules", ".bin", "biome");
			if (!bin && existsSync(local)) bin = local;
			if (
				!configDir &&
				(existsSync(join(dir, "biome.json")) ||
					existsSync(join(dir, "biome.jsonc")))
			)
				configDir = dir;
			if (dir === home || existsSync(join(dir, ".git"))) break;
		}
		if (
			!bin &&
			this.ctx.seams.which("biome") &&
			(await this.biomeIsReal("biome"))
		)
			bin = "biome";
		if (!bin) return undefined;
		return { bin, configDir };
	}

	private async supportsOrganize(
		bin: string,
		configDir?: string,
	): Promise<boolean> {
		const marker = join(
			this.ctx.scratchDir,
			`biome-organize.${createHash("sha1").update(bin).digest("hex")}`,
		);
		try {
			return readFileSync(marker, "utf8") === "1";
		} catch {
			const help = await this.probe([bin, "check", "--help"], configDir);
			const organize = `${help.stdout}${help.stderr}`.includes(
				"--organize-imports-enabled",
			);
			mkdirSync(this.ctx.scratchDir, { recursive: true, mode: 0o700 });
			writeFileSync(marker, organize ? "1" : "0");
			return organize;
		}
	}

	private writeBack(result: CommandResult): void {
		if (result.status !== 0 || !result.stdout || result.truncated) return;
		const target = realpathSync(this.file);
		writeFileAtomic(target, result.stdout, statSync(target).mode & 0o7777);
	}

	async biome(fix: boolean): Promise<boolean> {
		const resolved = await this.resolveBiome();
		if (!resolved) return false;
		const { bin, configDir } = resolved;
		const formatted = await this.exec(
			[bin, "format", "--write", this.file],
			configDir,
		);
		if (fix && formatted.status === 0) {
			const organize = await this.supportsOrganize(bin, configDir);
			await this.exec(
				[
					bin,
					"check",
					"--fix",
					...(organize ? ["--organize-imports-enabled=true"] : []),
					this.file,
				],
				configDir,
			);
		}
		return true;
	}

	async csharpier(): Promise<void> {
		const home = this.ctx.env["HOME"];
		for (
			let dir = dirname(this.file);
			dir !== dirname(dir);
			dir = dirname(dir)
		) {
			const tools = join(dir, ".config", "dotnet-tools.json");
			if (
				existsSync(tools) &&
				readFileSync(tools, "utf8").includes('"csharpier"')
			) {
				await this.exec(
					["dotnet", "tool", "run", "csharpier", "--", "format", this.file],
					dir,
				);
				return;
			}
			if (dir === home || existsSync(join(dir, ".git"))) break;
		}
		if (this.have("csharpier"))
			await this.exec(["csharpier", "format", this.file]);
	}

	async json(): Promise<void> {
		if (await this.biome(false)) return;
		if (!this.ctx.seams.which("jq")) return;
		this.writeBack(await this.exec(["jq", ".", this.file]));
	}

	async shell(): Promise<void> {
		if (!this.have("shfmt")) return;
		const fd = openSync(this.file, "r");
		const head = Buffer.alloc(256);
		const read = readSync(fd, head, 0, head.length, 0);
		closeSync(fd);
		const first = head.toString("utf8", 0, read).split("\n", 1)[0] ?? "";
		if (first.includes("zsh")) return;
		await this.exec(["shfmt", "-i", "2", "-w", this.file]);
	}

	async markdown(): Promise<void> {
		const scratch = scratchRoot(this.ctx.env);
		const normalized = this.file.replaceAll("\\", "/");
		if (MD_SKIP.test(normalized) || normalized.startsWith(`${scratch}/`))
			return;
		const home = this.ctx.env["HOME"];
		const localBin = home ? join(home, ".local", "bin", "mdformat") : undefined;
		if (localBin && existsSync(localBin))
			await this.exec([localBin, this.file]);
		else if (this.have("mdformat")) await this.exec(["mdformat", this.file]);
		if (this.ctx.seams.which("markdownlint"))
			await this.exec(["markdownlint", "--fix", this.file]);
	}

	async xml(): Promise<void> {
		if (this.ctx.seams.which("xmlformat")) {
			this.writeBack(await this.exec(["xmlformat", this.file]));
		} else if (this.ctx.seams.which("xmlformatter"))
			await this.exec(["xmlformatter", "--overwrite", this.file]);
		else this.missing.add("xmlformat");
	}

	async html(): Promise<void> {
		if (this.ctx.seams.which("superhtml"))
			await this.exec(["superhtml", "fmt", this.file]);
		else if (!(await this.biome(false))) this.missing.add("superhtml");
	}

	async run(): Promise<void> {
		const ext = extname(this.file).slice(1);
		const base = basename(this.file);
		const simple = SIMPLE.get(ext);
		if (simple) {
			if (this.have(simple.bin))
				await this.exec([simple.bin, ...simple.args(this.file)]);
		} else if (ext === "cs") await this.csharpier();
		else if (ext === "json") await this.json();
		else if (["js", "jsx", "ts", "tsx"].includes(ext)) {
			if (!(await this.biome(true))) this.missing.add(BIOME_MISSING);
		} else if (["sh", "bash"].includes(ext)) await this.shell();
		else if (ext === "md") await this.markdown();
		else if (ext === "xml") await this.xml();
		else if (["html", "htm"].includes(ext)) await this.html();
		else if (ext === "conf" && base.includes("nginx")) {
			if (this.have("nginx_beautifier"))
				await this.exec(["nginx_beautifier", this.file]);
		}
		if (BAZEL_FILES.has(base) && this.have("black"))
			await this.exec(["black", "--quiet", this.file]);
	}
}

function firstWarning(ctx: HookContext, tools: string[]): string[] {
	mkdirSync(ctx.scratchDir, { recursive: true, mode: 0o700 });
	return tools.filter((tool) => {
		const marker = join(ctx.scratchDir, `fmt-warned.${ctx.sessionId}.${tool}`);
		if (existsSync(marker)) return false;
		writeFileSync(marker, "");
		return true;
	});
}

const handler: HookHandler = async (input, ctx) => {
	if (!EDIT_TOOLS.has(input.tool_name ?? "")) return { exitCode: 0 };
	const raw = String(input.tool_input?.["file_path"] ?? "");
	if (!raw) return { exitCode: 0 };
	const file = resolve(input.cwd ?? process.cwd(), raw);
	if (!existsSync(file)) return { exitCode: 0 };
	const formatting = new Formatting(file, ctx);
	await formatting.run();
	const fresh = firstWarning(ctx, [...formatting.missing]);
	const notes = formatting.failed.map((failure) => `format: ${failure}`);
	if (fresh.length > 0)
		notes.push(
			`format: NOT FORMATTED - formatter unavailable: ${fresh.join(" ")}. Matching files were skipped, not formatted.`,
		);
	if (notes.length === 0) return { exitCode: 0 };
	return { exitCode: 0, additionalContext: notes.join("\n") };
};

export default handler;
