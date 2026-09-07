import { describe, expect, it, mock } from "bun:test";
import {
	createVimNav,
	type VimListSource,
	type VimNavOptions,
} from "@/lib/features/vim-nav";

function fakeKey(key: string): KeyboardEvent {
	return { key, preventDefault: mock(() => {}) } as unknown as KeyboardEvent;
}

function fakeList(
	rowIds: string[],
	overrides: Partial<VimListSource> = {},
): VimListSource {
	return {
		rowIds: () => rowIds,
		select: mock(() => {}),
		...overrides,
	};
}

function fakeOptions(overrides: Partial<VimNavOptions> = {}): VimNavOptions {
	return {
		lists: { rows: fakeList(["a", "b", "c"]) },
		order: ["rows"],
		onCursorChange: mock(() => {}),
		onOpenFilter: mock(() => {}),
		onModeChange: mock(() => {}),
		onCheatSheet: mock(() => {}),
		isTextInputFocused: () => false,
		...overrides,
	};
}

describe("vim-nav: inactive by default", () => {
	it("does not consume any key before enable() is called", () => {
		const nav = createVimNav(fakeOptions());
		expect(nav.isActive()).toBe(false);
		expect(nav.handleKeydown(fakeKey("j"))).toBe(false);
	});
});

describe("vim-nav: enabling and disabling", () => {
	it("enable() sets the cursor to the first row of the first list and announces the mode", () => {
		const onModeChange = mock(() => {});
		const onCursorChange = mock(() => {});
		const nav = createVimNav(fakeOptions({ onModeChange, onCursorChange }));

		nav.enable();

		expect(nav.isActive()).toBe(true);
		expect(nav.cursorId()).toBe("a");
		expect(onModeChange).toHaveBeenCalledWith(true, expect.any(String));
		expect(onCursorChange).toHaveBeenCalledWith("rows", "a");
	});

	it("Escape disables vim mode entirely when no sub-mode is open", () => {
		const onModeChange = mock(() => {});
		const nav = createVimNav(fakeOptions({ onModeChange }));
		nav.enable();

		const consumed = nav.handleKeydown(fakeKey("Escape"));

		expect(consumed).toBe(true);
		expect(nav.isActive()).toBe(false);
		expect(onModeChange).toHaveBeenLastCalledWith(false, expect.any(String));
	});
});

describe("vim-nav: j/k/gg/G cursor movement", () => {
	it("j moves the cursor down one row at a time, k moves it back up", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();

		nav.handleKeydown(fakeKey("j"));
		expect(nav.cursorId()).toBe("b");
		nav.handleKeydown(fakeKey("j"));
		expect(nav.cursorId()).toBe("c");
		nav.handleKeydown(fakeKey("k"));
		expect(nav.cursorId()).toBe("b");
	});

	it("clamps at the last row rather than wrapping past it", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();

		nav.handleKeydown(fakeKey("j"));
		nav.handleKeydown(fakeKey("j"));
		nav.handleKeydown(fakeKey("j"));
		nav.handleKeydown(fakeKey("j"));

		expect(nav.cursorId()).toBe("c");
	});

	it("clamps at the first row rather than wrapping past it", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();

		nav.handleKeydown(fakeKey("k"));
		nav.handleKeydown(fakeKey("k"));

		expect(nav.cursorId()).toBe("a");
	});

	it("G jumps straight to the last row", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();

		nav.handleKeydown(fakeKey("G"));

		expect(nav.cursorId()).toBe("c");
	});

	it("a lone g does not move the cursor; gg jumps to the first row", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();
		nav.handleKeydown(fakeKey("G"));
		expect(nav.cursorId()).toBe("c");

		nav.handleKeydown(fakeKey("g"));
		expect(nav.cursorId()).toBe("c");
		nav.handleKeydown(fakeKey("g"));
		expect(nav.cursorId()).toBe("a");
	});

	it("a stray g followed by an unrelated key does not arm gg on the next g", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();
		nav.handleKeydown(fakeKey("G"));

		nav.handleKeydown(fakeKey("g"));
		nav.handleKeydown(fakeKey("j"));
		expect(nav.cursorId()).toBe("c");

		nav.handleKeydown(fakeKey("g"));
		expect(nav.cursorId()).toBe("c");
	});
});

describe("vim-nav: Enter and row actions", () => {
	it("Enter selects the row under the cursor", () => {
		const select = mock(() => {});
		const nav = createVimNav(
			fakeOptions({ lists: { rows: fakeList(["a", "b"], { select }) } }),
		);
		nav.enable();
		nav.handleKeydown(fakeKey("j"));

		nav.handleKeydown(fakeKey("Enter"));

		expect(select).toHaveBeenCalledWith("b");
	});

	it("dispatches a single-key row action to the row under the cursor", () => {
		const runJob = mock(() => {});
		const nav = createVimNav(
			fakeOptions({
				lists: {
					rows: fakeList(["job-1", "job-2"], { actions: { r: runJob } }),
				},
			}),
		);
		nav.enable();
		nav.handleKeydown(fakeKey("j"));

		nav.handleKeydown(fakeKey("r"));

		expect(runJob).toHaveBeenCalledWith("job-2");
	});

	it("an unrecognized key is not consumed, so the browser default still applies", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();

		expect(nav.handleKeydown(fakeKey("z"))).toBe(false);
	});
});

describe("vim-nav: leader key", () => {
	it("a leader-prefixed key runs the matching leader action", () => {
		const markAllRead = mock(() => {});
		const nav = createVimNav(
			fakeOptions({ leaderActions: { a: markAllRead } }),
		);
		nav.enable();

		nav.handleKeydown(fakeKey("\\"));
		expect(markAllRead).not.toHaveBeenCalled();
		nav.handleKeydown(fakeKey("a"));

		expect(markAllRead).toHaveBeenCalledTimes(1);
	});

	it("Escape while a leader sequence is open cancels only the leader, not vim mode itself", () => {
		const nav = createVimNav(fakeOptions());
		nav.enable();
		nav.handleKeydown(fakeKey("\\"));

		nav.handleKeydown(fakeKey("Escape"));

		expect(nav.isActive()).toBe(true);
	});

	it("a leader sequence already open is completed even if a text input then gains focus", () => {
		const markAllRead = mock(() => {});
		let textFocused = false;
		const nav = createVimNav(
			fakeOptions({
				leaderActions: { a: markAllRead },
				isTextInputFocused: () => textFocused,
			}),
		);
		nav.enable();
		nav.handleKeydown(fakeKey("\\"));

		textFocused = true;
		nav.handleKeydown(fakeKey("a"));

		expect(markAllRead).toHaveBeenCalledTimes(1);
	});
});

describe("vim-nav: never swallows keys while a text input has focus", () => {
	it("j does not move the cursor, and is left unconsumed, while a text input has focus", () => {
		const nav = createVimNav(fakeOptions({ isTextInputFocused: () => true }));
		nav.enable();

		const consumed = nav.handleKeydown(fakeKey("j"));

		expect(consumed).toBe(false);
		expect(nav.cursorId()).toBe("a");
	});
});

describe("vim-nav: multiple lists and Tab switching", () => {
	it("Tab switches the active list and remembers each list's own cursor position", () => {
		const nav = createVimNav(
			fakeOptions({
				lists: { feed: fakeList(["f1", "f2"]), jobs: fakeList(["j1", "j2"]) },
				order: ["feed", "jobs"],
			}),
		);
		nav.enable();
		nav.handleKeydown(fakeKey("j"));
		expect(nav.activeList()).toBe("feed");
		expect(nav.cursorId()).toBe("f2");

		nav.handleKeydown(fakeKey("Tab"));
		expect(nav.activeList()).toBe("jobs");
		expect(nav.cursorId()).toBe("j1");

		nav.handleKeydown(fakeKey("Tab"));
		expect(nav.activeList()).toBe("feed");
		expect(nav.cursorId()).toBe("f2");
	});
});

describe("vim-nav: filter and cheat sheet", () => {
	it("/ opens the filter for the active list without moving the cursor", () => {
		const onOpenFilter = mock(() => {});
		const nav = createVimNav(fakeOptions({ onOpenFilter }));
		nav.enable();

		nav.handleKeydown(fakeKey("/"));

		expect(onOpenFilter).toHaveBeenCalledWith("rows");
		expect(nav.cursorId()).toBe("a");
	});

	it("? opens the cheat sheet and swallows subsequent keys until Escape or ? closes it", () => {
		const onCheatSheet = mock(() => {});
		const nav = createVimNav(fakeOptions({ onCheatSheet }));
		nav.enable();

		nav.handleKeydown(fakeKey("?"));
		expect(onCheatSheet).toHaveBeenLastCalledWith(true);

		nav.handleKeydown(fakeKey("j"));
		expect(nav.cursorId()).toBe("a");

		nav.handleKeydown(fakeKey("Escape"));
		expect(onCheatSheet).toHaveBeenLastCalledWith(false);
		expect(nav.isActive()).toBe(true);
	});
});
