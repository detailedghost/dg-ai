import { DEFAULTS, type GroupColor, getConfig, setConfig } from "@/lib/config";

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

async function load(): Promise<void> {
	const cfg = await getConfig();
	$<HTMLSelectElement>("color").value = cfg.color;
}

async function save(): Promise<void> {
	await setConfig({
		color:
			($<HTMLSelectElement>("color").value as GroupColor) || DEFAULTS.color,
	});
	const status = $<HTMLSpanElement>("status");
	status.textContent = "Saved ✓";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
}

$<HTMLButtonElement>("save").addEventListener("click", save);
void load();
