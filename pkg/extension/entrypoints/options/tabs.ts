export type MountTabsOptions = { fallback: string };

export function mountTabs(root: HTMLElement, { fallback }: MountTabsOptions): void {
	const doc = root.ownerDocument;
	const win = doc.defaultView as Window;
	const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
	const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];

	const ids = tabs.map((tab) => tab.dataset.tab as string);

	function resolve(hash: string): string {
		const id = hash.replace(/^#/, "");
		return ids.includes(id) ? id : fallback;
	}

	function select(id: string, focus = false): void {
		for (const tab of tabs) {
			const on = tab.dataset.tab === id;
			tab.setAttribute("aria-selected", String(on));
			tab.tabIndex = on ? 0 : -1;
			if (on && focus) tab.focus();
		}
		for (const panel of panels) panel.hidden = panel.dataset.panel !== id;
	}

	function go(id: string, focus = false): void {
		select(id, focus);
		if (win.location.hash !== `#${id}`) win.location.hash = id;
	}

	for (const tab of tabs) {
		tab.addEventListener("click", () => go(tab.dataset.tab as string));
		tab.addEventListener("keydown", (event) => {
			const at = tabs.indexOf(tab);
			const last = tabs.length - 1;
			const next: Record<string, number> = {
				ArrowRight: at === last ? 0 : at + 1,
				ArrowLeft: at === 0 ? last : at - 1,
				Home: 0,
				End: last,
			};
			const target = next[event.key];
			if (target === undefined) return;
			event.preventDefault();
			go(ids[target] as string, true);
		});
	}

	win.addEventListener("hashchange", () => select(resolve(win.location.hash)));
	select(resolve(win.location.hash));
}
