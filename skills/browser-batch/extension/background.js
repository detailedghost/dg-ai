// dg-ai-browser-batch — groups matching tabs into one named/colored tab group as they finish loading.
// Pure browser-side: no native messaging, no external server. The CLI just opens URLs; this groups them.

const DEFAULTS = {
	// Glob patterns matched against the full tab URL. Edit in Options to scope to your org.
	patterns: ["*://github.com/*/*/pull/*"],
	title: "PRs",
	// One of: grey, blue, red, yellow, green, pink, purple, cyan, orange
	color: "blue",
};

async function getConfig() {
	return chrome.storage.sync.get(DEFAULTS);
}

/** Convert a shell-style glob (only * and ?) into an anchored RegExp. */
function globToRegExp(glob) {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

function urlMatches(url, patterns) {
	return patterns.some((p) => globToRegExp(p).test(url));
}

// Group operations are serialized so a batch of tabs opened together lands in ONE group
// instead of racing to each create their own "PRs" group.
let queue = Promise.resolve();
function enqueue(task) {
	queue = queue.then(task).catch((err) => console.error("[browser-batch]", err));
	return queue;
}

async function groupTab(tab, config) {
	// Already in a group? Leave it — never re-group a tab the user (or we) already placed.
	if (typeof tab.groupId === "number" && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;

	const existing = await chrome.tabGroups.query({ windowId: tab.windowId, title: config.title });
	if (existing.length > 0) {
		await chrome.tabs.group({ tabIds: [tab.id], groupId: existing[0].id });
		return;
	}
	const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
	await chrome.tabGroups.update(groupId, { title: config.title, color: config.color });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	// Act once the navigation settles so tab.url is final.
	if (changeInfo.status !== "complete") return;
	enqueue(async () => {
		const config = await getConfig();
		let tab;
		try {
			tab = await chrome.tabs.get(tabId); // re-fetch for the current url + groupId
		} catch {
			return; // tab closed before we got to it
		}
		if (!tab.url || !urlMatches(tab.url, config.patterns)) return;
		await groupTab(tab, config);
	});
});
