/**
 * Detect installed browsers on Windows (from WSL or native) via the registry's
 * StartMenuInternet keys, and classify whether each can side-load an unpacked
 * extension through the `--load-extension` flag.
 */

import { isWSL, run } from "./lib";

export type BrowserKind = "chromium" | "chrome-stable" | "firefox" | "other";

export type DetectedBrowser = {
	name: string;
	version: string;
	exe: string; // Windows-style path as reported by the registry
	key: string; // slug for --browser (e.g. "brave-beta")
	kind: BrowserKind;
	launchable: boolean; // can we side-load via --load-extension?
};

// One-liner PowerShell: list registered browsers as "name<TAB>version<TAB>exe".
const PROBE = [
	"$ErrorActionPreference='SilentlyContinue';",
	"$roots=@('HKLM:\\SOFTWARE\\Clients\\StartMenuInternet','HKLM:\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet','HKCU:\\SOFTWARE\\Clients\\StartMenuInternet');",
	"$seen=@{};",
	"foreach($r in $roots){ Get-ChildItem $r | ForEach-Object {",
	"  $k=$_.PSPath; $n=(Get-ItemProperty $k).'(default)';",
	"  $c=(Get-ItemProperty \"$k\\shell\\open\\command\").'(default)';",
	"  if($c){ $e=$c.Trim('\"'); if($e -match '^(.*\\.exe)'){$e=$matches[1]};",
	"    if((Test-Path $e) -and -not $seen[$e]){ $seen[$e]=$true;",
	'      $v=(Get-Item $e).VersionInfo.ProductVersion; "$n`t$v`t$e" } } } }',
].join(" ");

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function classify(exe: string): BrowserKind {
	const b = exe.toLowerCase();
	if (b.includes("firefox")) return "firefox";
	if (b.includes("brave") || b.includes("vivaldi") || b.includes("chromium")) {
		return "chromium";
	}
	if (b.includes("msedge") || b.includes("\\edge")) return "chromium";
	if (b.includes("chrome")) return "chrome-stable"; // Google Chrome — flag disabled on stable
	return "other";
}

export function detectBrowsers(): DetectedBrowser[] {
	if (process.platform !== "win32" && !isWSL()) return []; // Windows/WSL only for now
	const out = run("powershell.exe", ["-NoProfile", "-Command", PROBE]);
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((line) => {
			const [name, version, exe] = line.split("\t");
			const kind = classify(exe);
			return {
				name,
				version,
				exe,
				key: slug(name),
				kind,
				launchable: kind === "chromium",
			};
		});
}
