import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isWSL, runCapture, writeStdout } from "@dg/common/node";

const USAGE = `Usage: dg-skills clipboard-image [--scratch | -s | <dest.png> | -]

Save the clipboard image as PNG. Without arguments, save under .agents/clipboard.
  --scratch, -s  Keep a temporary PNG and print its path
  -              Write PNG bytes to stdout
  --help, -h     Show this help without reading the clipboard
`;

function reportCause(error: unknown): void {
	process.stderr.write(
		`clipboard-image: ${error instanceof Error ? error.message : String(error)}\n`,
	);
}

function clipboardCommand(): string[] | null {
	if (process.env.WAYLAND_DISPLAY && Bun.which("wl-paste"))
		return ["wl-paste", "--type", "image/png"];
	if (process.env.DISPLAY && Bun.which("xclip"))
		return ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"];
	return null;
}

async function extractImage(
	tempfile: string,
	descriptor: number,
): Promise<boolean> {
	if (
		process.env.PLATFORM_IS_WSL === "1" ||
		process.env.WSL_INTEROP ||
		isWSL()
	) {
		try {
			const result = await runCapture("wslpath", ["-w", tempfile]);
			const destination = result.stdout.trim().replace(/'/g, "''");
			await runCapture("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 1 }
$img.Save('${destination}', [System.Drawing.Imaging.ImageFormat]::Png)
`,
			]);
		} catch (error) {
			reportCause(error);
		}
		return true;
	}
	const argv = clipboardCommand();
	if (!argv) return false;
	try {
		const child = Bun.spawn(argv, { stdout: descriptor, stderr: "ignore" });
		await child.exited;
	} catch (error) {
		reportCause(error);
	}
	return true;
}

function defaultDestination(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	mkdirSync(".agents/clipboard", { recursive: true });
	return `.agents/clipboard/clipboard-${date}-${time}.png`;
}

function saveImage(tempfile: string, destination: string): void {
	let target = destination;
	try {
		if (statSync(destination).isDirectory())
			target = join(destination, basename(tempfile));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const staged = join(dirname(target), `.clipboard-image-${randomUUID()}.tmp`);
	try {
		copyFileSync(tempfile, staged, constants.COPYFILE_EXCL);
		renameSync(staged, target);
	} finally {
		rmSync(staged, { force: true });
	}
}

/** Capture a PNG through the platform's native clipboard tool, preserving legacy output modes. */
export async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		await writeStdout(USAGE);
		return 0;
	}
	const tempfile = join(tmpdir(), `clipboard-image-${randomUUID()}.png`);
	let created = false;
	let keep = false;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(tempfile, "wx", 0o600);
		created = true;
		const supported = await extractImage(tempfile, descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		if (!supported) {
			process.stderr.write(
				"clipboard-image: no supported clipboard backend found\n  Wayland: install wl-paste (wl-clipboard)\n  X11:     install xclip\n  WSL:     run inside WSL\n",
			);
			return 1;
		}
		if (statSync(tempfile).size === 0) throw new Error("no image on clipboard");
		const destination = argv[0];
		if (destination === "-") await writeStdout(readFileSync(tempfile));
		else if (destination === "--scratch" || destination === "-s") {
			await writeStdout(`${tempfile}\n`);
			keep = true;
		} else {
			if (destination?.startsWith("-"))
				throw new Error(`unknown flag: ${destination}`);
			const target = destination || defaultDestination();
			saveImage(tempfile, target);
			await writeStdout(`${target}\n`);
		}
		return 0;
	} catch (error) {
		reportCause(error);
		return 1;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (created && !keep) rmSync(tempfile, { force: true });
	}
}
