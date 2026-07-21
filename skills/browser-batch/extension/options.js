const DEFAULTS = {
	patterns: ["*://github.com/*/*/pull/*"],
	title: "PRs",
	color: "blue",
};

const $ = (id) => document.getElementById(id);

async function load() {
	const cfg = await chrome.storage.sync.get(DEFAULTS);
	$("patterns").value = cfg.patterns.join("\n");
	$("title").value = cfg.title;
	$("color").value = cfg.color;
}

async function save() {
	const patterns = $("patterns")
		.value.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	await chrome.storage.sync.set({ patterns, title: $("title").value.trim() || "PRs", color: $("color").value });
	$("status").textContent = "Saved ✓";
	setTimeout(() => ($("status").textContent = ""), 1500);
}

$("save").addEventListener("click", save);
load();
