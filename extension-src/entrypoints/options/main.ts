import { DEFAULTS, type GroupColor, getConfig, setConfig } from "@/lib/config";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function load(): Promise<void> {
	const cfg = await getConfig();
	$<HTMLTextAreaElement>("patterns").value = cfg.patterns.join("\n");
	$<HTMLInputElement>("title").value = cfg.title;
	$<HTMLSelectElement>("color").value = cfg.color;
}

async function save(): Promise<void> {
	const patterns = $<HTMLTextAreaElement>("patterns")
		.value.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	await setConfig({
		patterns: patterns.length ? patterns : DEFAULTS.patterns,
		title: $<HTMLInputElement>("title").value.trim() || DEFAULTS.title,
		color: $<HTMLSelectElement>("color").value as GroupColor,
	});
	const status = $<HTMLSpanElement>("status");
	status.textContent = "Saved ✓";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
}

$<HTMLButtonElement>("save").addEventListener("click", save);
void load();
