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
import { isWSL, runCapture } from "@dg/common/node";

const USAGE = `Usage: dg-skills clipboard-image [--scratch | -s | <dest.png> | -]

Save the clipboard image as PNG. Without arguments, save under .agents/clipboard.
  --scratch, -s  Keep a temporary PNG and print its path
  -              Write PNG bytes to stdout
  --help, -h     Show this help without reading the clipboard
`;

function writeOutput(data: string | Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(data, (error) => (error ? reject(error) : resolve()));
	});
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
		} catch {
			// A missing native command follows the legacy empty-clipboard failure path.
		}
		return true;
	}
	const argv =
		process.env.WAYLAND_DISPLAY && Bun.which("wl-paste")
			? ["wl-paste", "--type", "image/png"]
			: process.env.DISPLAY && Bun.which("xclip")
				? ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]
				: null;
	if (!argv) return false;
	try {
		const child = Bun.spawn(argv, { stdout: descriptor, stderr: "ignore" });
		await child.exited;
	} catch {
		// Native extraction errors are reported as an empty clipboard, with stderr suppressed.
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
	let copied = false;
	try {
		copyFileSync(tempfile, staged, constants.COPYFILE_EXCL);
		copied = true;
		// Replace the destination entry, rather than following a file symlink.
		renameSync(staged, target);
	} finally {
		if (copied) rmSync(staged, { force: true });
	}
}

/** Capture a PNG through the platform's native clipboard tool, preserving legacy output modes. */
export async function main(argv: string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		await writeOutput(USAGE);
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
		if (destination === "-") await writeOutput(readFileSync(tempfile));
		else if (destination === "--scratch" || destination === "-s") {
			await writeOutput(`${tempfile}\n`);
			keep = true;
		} else {
			if (destination?.startsWith("-"))
				throw new Error(`unknown flag: ${destination}`);
			const target = destination || defaultDestination();
			saveImage(tempfile, target);
			await writeOutput(`${target}\n`);
		}
		return 0;
	} catch (error) {
		process.stderr.write(
			`clipboard-image: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (created && !keep) rmSync(tempfile, { force: true });
	}
}
