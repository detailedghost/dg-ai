export type VimListSource = {
	rowIds(): string[];
	select(id: string): void;
	actions?: Record<string, (id: string) => void>;
};

export type VimNavOptions = {
	lists: Record<string, VimListSource>;
	order: string[];
	leaderActions?: Record<string, () => void>;
	onCursorChange(list: string, id: string | undefined): void;
	onOpenFilter(list: string): void;
	onModeChange(active: boolean, message: string): void;
	onCheatSheet(open: boolean): void;
	isTextInputFocused(): boolean;
};

export type VimNav = {
	isActive(): boolean;
	enable(): void;
	disable(): void;
	activeList(): string;
	cursorId(): string | undefined;
	handleKeydown(event: KeyboardEvent): boolean;
};

const LEADER_KEY = "\\";

function clampIndex(index: number, length: number): number {
	return Math.min(length - 1, Math.max(0, index));
}

/** A DOM-agnostic j/k/gg/G/leader keymap over one or more named, id-keyed lists. */
export function createVimNav(options: VimNavOptions): VimNav {
	let active = false;
	let currentList = options.order[0] ?? "";
	let pendingG = false;
	let leaderPending = false;
	let cheatSheetOpen = false;
	const cursorByList = new Map<string, string | undefined>();

	function list(name: string): VimListSource {
		const source = options.lists[name];
		if (!source) throw new Error(`vim-nav: unknown list "${name}"`);
		return source;
	}

	function clampCursor(name: string): void {
		const ids = list(name).rowIds();
		const current = cursorByList.get(name);
		cursorByList.set(name, current && ids.includes(current) ? current : ids[0]);
	}

	function setCursor(name: string, id: string | undefined): void {
		cursorByList.set(name, id);
		if (name === currentList) options.onCursorChange(name, id);
	}

	function moveCursor(delta: 1 | -1): void {
		const ids = list(currentList).rowIds();
		if (ids.length === 0) {
			setCursor(currentList, undefined);
			return;
		}
		const current = cursorByList.get(currentList);
		const index = current ? ids.indexOf(current) : -1;
		const next = index < 0 ? 0 : clampIndex(index + delta, ids.length);
		setCursor(currentList, ids[next]);
	}

	function moveCursorToStart(): void {
		setCursor(currentList, list(currentList).rowIds()[0]);
	}

	function moveCursorToEnd(): void {
		const ids = list(currentList).rowIds();
		setCursor(currentList, ids[ids.length - 1]);
	}

	function switchList(): void {
		if (options.order.length < 2) return;
		const index = options.order.indexOf(currentList);
		currentList =
			options.order[(index + 1) % options.order.length] ?? currentList;
		clampCursor(currentList);
		options.onCursorChange(currentList, cursorByList.get(currentList));
	}

	function enable(): void {
		active = true;
		currentList = options.order[0] ?? currentList;
		clampCursor(currentList);
		options.onModeChange(
			true,
			"Vim mode on. j/k move, Enter acts, ? for help.",
		);
		options.onCursorChange(currentList, cursorByList.get(currentList));
	}

	function disable(): void {
		active = false;
		pendingG = false;
		leaderPending = false;
		if (cheatSheetOpen) {
			cheatSheetOpen = false;
			options.onCheatSheet(false);
		}
		options.onModeChange(false, "Vim mode off.");
	}

	function handleKeydown(event: KeyboardEvent): boolean {
		if (!active) return false;
		const key = event.key;

		if (cheatSheetOpen) {
			event.preventDefault();
			if (key === "Escape" || key === "?") {
				cheatSheetOpen = false;
				options.onCheatSheet(false);
			}
			return true;
		}

		if (options.isTextInputFocused() && !leaderPending) return false;

		if (key === "Escape") {
			event.preventDefault();
			if (leaderPending) {
				leaderPending = false;
				options.onModeChange(true, "Leader cancelled.");
			} else {
				disable();
			}
			return true;
		}

		if (leaderPending) {
			event.preventDefault();
			leaderPending = false;
			const action = options.leaderActions?.[key];
			action?.();
			options.onModeChange(
				true,
				action ? `Ran leader ${key}.` : "Leader cancelled.",
			);
			return true;
		}

		if (key !== "g") pendingG = false;

		if (key === "?") {
			event.preventDefault();
			cheatSheetOpen = true;
			options.onCheatSheet(true);
			return true;
		}

		if (key === "/") {
			event.preventDefault();
			options.onOpenFilter(currentList);
			return true;
		}

		if (key === LEADER_KEY) {
			event.preventDefault();
			leaderPending = true;
			options.onModeChange(true, "Leader key. Waiting for the next key.");
			return true;
		}

		if (key === "Tab") {
			event.preventDefault();
			switchList();
			return true;
		}

		if (key === "j" || key === "k") {
			event.preventDefault();
			moveCursor(key === "j" ? 1 : -1);
			return true;
		}

		if (key === "g") {
			event.preventDefault();
			if (pendingG) {
				pendingG = false;
				moveCursorToStart();
			} else {
				pendingG = true;
			}
			return true;
		}

		if (key === "G") {
			event.preventDefault();
			moveCursorToEnd();
			return true;
		}

		if (key === "Enter") {
			const id = cursorByList.get(currentList);
			if (!id) return true;
			event.preventDefault();
			list(currentList).select(id);
			return true;
		}

		const action = list(currentList).actions?.[key];
		if (action) {
			const id = cursorByList.get(currentList);
			if (id) {
				event.preventDefault();
				action(id);
			}
			return true;
		}

		return false;
	}

	return {
		isActive: () => active,
		enable,
		disable,
		activeList: () => currentList,
		cursorId: () => cursorByList.get(currentList),
		handleKeydown,
	};
}
