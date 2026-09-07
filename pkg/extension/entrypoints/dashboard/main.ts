import { isTextEntryFocused } from "@/lib/dom-focus";
import { patchKeyedList } from "@/lib/dom-keyed-list";
import {
	applyRefresh,
	connectDashboardApi,
	createDashboardState,
	createPoller,
	type DashboardApi,
	type DashboardState,
	firstFailure,
	type JobPayload,
	portOf,
	selectJob,
	summarize,
	toFeedView,
	toJobView,
	visibleItems,
} from "@/lib/features/dashboard";
import { createVimNav } from "@/lib/features/vim-nav";
import "../options/style.css";
import "./style.css";

export type DashboardHandle = {
	ready: Promise<void>;
	refresh(): Promise<void>;
	stop(): void;
};

export type RenderDashboardOptions = {
	root: HTMLElement;
	connect?: (knownPort?: number) => Promise<DashboardApi | undefined>;
	now?: () => Date;
	poll?: boolean;
};

type JobRowRefs = {
	target: HTMLButtonElement;
	dot: HTMLElement;
	name: HTMLElement;
	pill: HTMLElement;
	meta: HTMLElement;
	badge: HTMLElement;
	metaText: HTMLElement;
	when: HTMLElement;
	progress?: HTMLElement;
};

type FeedRowRefs = {
	mark: HTMLButtonElement;
	badge: HTMLElement;
	title: HTMLElement;
	meta: HTMLElement;
};

export function renderDashboard(
	options: RenderDashboardOptions,
): DashboardHandle {
	const {
		root,
		connect = connectDashboardApi,
		now = () => new Date(),
	} = options;
	const doc = root.ownerDocument;

	let state: DashboardState = createDashboardState();
	let api: DashboardApi | undefined;
	let lastPort: number | undefined;
	let mounted = false;

	const jobRowRefs = new WeakMap<HTMLLIElement, JobRowRefs>();
	const feedRowRefs = new WeakMap<HTMLLIElement, FeedRowRefs>();

	function el<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		className?: string,
		text?: string,
	): HTMLElementTagNameMap[K] {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function button(label: string, className = "dash__btn"): HTMLButtonElement {
		const node = el("button", className, label);
		node.type = "button";
		return node;
	}

	function spacer(): HTMLSpanElement {
		return el("span", "dash__grow");
	}

	async function act(work: Promise<boolean>): Promise<void> {
		await work;
		await refresh();
	}

	function renderQueueControl(itemId: string): HTMLElement {
		const holder = el("span");
		const trigger = button("Queue to agent", "dash__btn dash__queue");
		trigger.addEventListener("click", () => {
			const input = el("input", "dash__identity");
			input.placeholder = "agent identity";
			input.addEventListener("keydown", (event) => {
				if (event.key === "Escape") {
					holder.replaceChildren(trigger);
					return;
				}
				if (event.key !== "Enter" || !input.value.trim()) return;
				const identity = input.value.trim();
				input.disabled = true;
				void act(api?.queueToAgent(itemId, identity) ?? Promise.resolve(false));
			});
			holder.replaceChildren(input);
			input.focus();
		});
		holder.append(trigger);
		return holder;
	}

	function createJobRow(job: JobPayload): HTMLLIElement {
		const row = el("li");
		const target = el("button", "dash__job");
		target.type = "button";
		target.addEventListener("click", () => {
			state = selectJob(
				state,
				state.selectedJobId === job.id ? undefined : job.id,
			);
			render();
		});

		const top = el("div", "dash__jobtop");
		const dot = el("span");
		const name = el("span", "dash__jobname");
		const pill = el("span");
		top.append(dot, name, pill);

		const meta = el("div");
		const badge = el("span");
		const metaText = el("span");
		const when = el("span");
		meta.append(badge, metaText, spacer(), when);

		target.append(top, meta);
		row.append(target);
		jobRowRefs.set(row, {
			target,
			dot,
			name,
			pill,
			meta,
			badge,
			metaText,
			when,
		});
		return row;
	}

	function updateJobRow(row: HTMLLIElement, job: JobPayload, at: Date): void {
		const refs = jobRowRefs.get(row);
		if (!refs) return;
		const view = toJobView(job, at);

		refs.target.className = `dash__job dash__job--${view.state}`;
		if (state.selectedJobId === job.id) {
			refs.target.setAttribute("aria-current", "true");
		} else {
			refs.target.removeAttribute("aria-current");
		}

		refs.dot.className = `dash__dot dash__dot--${view.state}`;
		refs.name.textContent = view.label;
		refs.pill.className =
			view.unread > 0 ? "dash__pill" : "dash__pill dash__pill--none";
		refs.pill.textContent = String(view.unread);

		refs.meta.className =
			view.state === "failed"
				? "dash__jobmeta dash__jobmeta--failed"
				: "dash__jobmeta";
		refs.badge.className = `dash__badge dash__badge--${view.source.toLowerCase()}`;
		refs.badge.textContent = view.source;
		refs.metaText.textContent =
			view.state === "failed" ? view.detail : view.schedule;
		refs.when.textContent = view.when;

		row.hidden = !filterMatches("jobs", job.label);

		if (view.state === "paused") {
			refs.progress?.remove();
			refs.progress = undefined;
			return;
		}
		if (!refs.progress) {
			refs.progress = el("span");
			refs.target.append(refs.progress);
		}
		refs.progress.className =
			view.state === "failed" ? "dash__prog dash__prog--failed" : "dash__prog";
		refs.progress.style.transform = `scaleX(${view.progress.toFixed(3)})`;
	}

	function createFeedRow(item: { id: string; jobId: string }): HTMLLIElement {
		const row = el("li");
		const itemId = item.id;

		const mark = button("", "dash__mark");
		mark.addEventListener("click", () => {
			void act(api?.markRead(itemId) ?? Promise.resolve(false));
		});

		const body = el("div");
		const top = el("div", "dash__top");
		const badge = el("span");
		const title = el("span", "dash__itemtitle");
		top.append(badge, title);
		const meta = el("div", "dash__meta");
		body.append(top, meta);

		row.append(mark, body, renderQueueControl(itemId));
		feedRowRefs.set(row, { mark, badge, title, meta });
		return row;
	}

	function updateFeedRow(
		row: HTMLLIElement,
		item: {
			id: string;
			jobId: string;
			createdAt: string;
			title: string;
			meta: string | null;
			url: string | null;
			read: boolean;
		},
		jobsById: Map<string, JobPayload>,
		at: Date,
	): void {
		const refs = feedRowRefs.get(row);
		if (!refs) return;
		const view = toFeedView(item, at);

		row.className = view.unread
			? "dash__item dash__item--unread"
			: "dash__item dash__item--read";

		const job = jobsById.get(item.jobId);
		const source = job ? toJobView(job, at).source : "Job";
		refs.badge.className = `dash__badge dash__badge--${source.toLowerCase()}`;
		refs.badge.textContent = source;
		refs.title.textContent = view.title;
		refs.meta.textContent = view.meta;

		refs.mark.textContent = view.unread ? "Mark read" : "Read";
		refs.mark.disabled = !view.unread;

		row.hidden = !filterMatches("feed", view.title);
	}

	const vimFilterQuery: Record<"feed" | "jobs", string> = {
		feed: "",
		jobs: "",
	};

	function filterMatches(list: "feed" | "jobs", searchable: string): boolean {
		const query = vimFilterQuery[list];
		return !query || searchable.toLowerCase().includes(query.toLowerCase());
	}

	function findRow(
		container: HTMLElement,
		id: string | undefined,
	): HTMLElement | undefined {
		if (!id) return undefined;
		for (const child of Array.from(container.children)) {
			if ((child as HTMLElement).dataset.key === id)
				return child as HTMLElement;
		}
		return undefined;
	}

	let vimCursor: { list: string; id: string | undefined } = {
		list: "feed",
		id: undefined,
	};

	function paintVimCursor(): void {
		const showCursor = vim.isActive();
		for (const row of Array.from(railList.children)) {
			(row as HTMLElement).classList.toggle(
				"dash__job--cursor",
				showCursor &&
					vimCursor.list === "jobs" &&
					(row as HTMLElement).dataset.key === vimCursor.id,
			);
		}
		for (const row of Array.from(feedList.children)) {
			(row as HTMLElement).classList.toggle(
				"dash__item--cursor",
				showCursor &&
					vimCursor.list === "feed" &&
					(row as HTMLElement).dataset.key === vimCursor.id,
			);
		}
	}

	let railList: HTMLUListElement;
	let railEmpty: HTMLElement;
	let summaryText: HTMLElement;
	let summaryFailed: HTMLElement;
	let vimToggle: HTMLButtonElement;
	let vimBar: HTMLElement;
	let vimFilterInput: HTMLInputElement;
	let vimCheat: HTMLElement;

	const VIM_CHEAT_SHEET =
		"VIM  j/k move  gg/G ends  Enter act  r run  m read  q queue  \\a mark all  Tab list  / filter  ? this  Esc exit";

	function buildRail(): HTMLElement {
		const rail = el("aside", "dash__rail");

		const head = el("div", "dash__head");
		const brand = el("h1", "dash__brand");
		brand.append(el("span", "dash__mk"), doc.createTextNode("Jobs"));
		vimToggle = button("Vim", "dash__btn dash__vimtoggle");
		vimToggle.dataset.action = "vim-toggle";
		vimToggle.setAttribute("aria-pressed", "false");
		vimToggle.addEventListener("click", () => {
			if (vim.isActive()) vim.disable();
			else vim.enable();
		});
		const settingsLink = el("a", undefined, "Settings");
		settingsLink.href = "/options.html#/settings";
		head.append(brand, spacer(), vimToggle, settingsLink);

		vimBar = el("div", "dash__vimbar");
		vimBar.setAttribute("role", "status");
		vimBar.hidden = true;

		vimFilterInput = el("input", "dash__vimfilter");
		vimFilterInput.hidden = true;
		vimFilterInput.addEventListener("input", () => {
			const list = vim.activeList() as "feed" | "jobs";
			vimFilterQuery[list] = vimFilterInput.value;
			render();
		});
		vimFilterInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				const list = vim.activeList() as "feed" | "jobs";
				vimFilterQuery[list] = "";
				vimFilterInput.value = "";
				vimFilterInput.hidden = true;
				render();
			} else if (event.key === "Enter") {
				event.preventDefault();
				vimFilterInput.hidden = true;
			}
		});

		vimCheat = el("div", "dash__vimcheat", VIM_CHEAT_SHEET);
		vimCheat.hidden = true;

		const summary = el("div", "dash__summary");
		summaryText = el("span");
		summaryFailed = el("b");
		summaryFailed.hidden = true;
		summary.append(summaryText, spacer(), summaryFailed);

		railList = el("ul", "dash__jobs");
		railEmpty = el("div", "dash__empty");
		railEmpty.hidden = true;

		rail.append(
			head,
			vimBar,
			vimFilterInput,
			vimCheat,
			summary,
			railList,
			railEmpty,
		);
		return rail;
	}

	function patchRail(at: Date): void {
		const counts = summarize(state.jobs);
		summaryText.textContent = `${counts.total} jobs · ${counts.active} active`;
		summaryFailed.hidden = counts.failed === 0;
		if (counts.failed > 0)
			summaryFailed.textContent = `${counts.failed} failed`;

		patchKeyedList(railList, state.jobs, {
			key: (job) => job.id,
			create: createJobRow,
			update: (row, job) => updateJobRow(row as HTMLLIElement, job, at),
		});

		railEmpty.hidden = state.jobs.length > 0;
		railEmpty.textContent = state.loaded
			? "No jobs scheduled yet."
			: "Looking for the daemon…";
	}

	let paneTitle: HTMLElement;
	let paneSub: HTMLElement;
	let runButton: HTMLButtonElement;
	let offlineAlert: HTMLElement;
	let failureAlert: HTMLElement;
	let failureLabel: HTMLElement;
	let failureMessage: Text;
	let failureShowButton: HTMLButtonElement;
	let feedList: HTMLUListElement;
	let feedEmpty: HTMLElement;
	let pane: HTMLElement;
	let currentFailureJobId: string | undefined;

	function buildPane(): HTMLElement {
		pane = el("section", "dash__pane");

		const head = el("div", "dash__head");
		paneTitle = el("h2", "dash__title");
		paneSub = el("span", "dash__sub");
		runButton = button("Run now");
		runButton.hidden = true;
		runButton.addEventListener("click", () => {
			const jobId = state.selectedJobId;
			if (!jobId) return;
			runButton.disabled = true;
			void act(api?.runJob(jobId) ?? Promise.resolve(false));
		});
		const markAll = button("Mark all read");
		markAll.addEventListener("click", () => {
			void act(api?.markAllRead() ?? Promise.resolve(false));
		});
		head.append(paneTitle, paneSub, spacer(), runButton, markAll);

		offlineAlert = el("div", "dash__alert dash__alert--offline");
		offlineAlert.append(
			el("b", undefined, "The daemon is not answering."),
			doc.createTextNode(" Showing the last data it gave."),
		);

		failureAlert = el("div", "dash__alert");
		failureLabel = el("b");
		failureMessage = doc.createTextNode("");
		failureShowButton = button("Show job");
		failureShowButton.addEventListener("click", () => {
			if (!currentFailureJobId) return;
			state = selectJob(state, currentFailureJobId);
			render();
		});
		failureAlert.append(
			failureLabel,
			failureMessage,
			spacer(),
			failureShowButton,
		);

		feedList = el("ul", "dash__feed");
		feedEmpty = el("div", "dash__empty");
		feedEmpty.hidden = true;

		pane.append(head, feedList, feedEmpty);
		return pane;
	}

	function patchPane(at: Date): void {
		const selected = state.jobs.find((job) => job.id === state.selectedJobId);
		const view = selected ? toJobView(selected, at) : undefined;

		paneTitle.textContent = selected ? selected.label : "All jobs";
		paneSub.textContent = view
			? `${view.detail} · ${view.when}`
			: `${visibleItems(state).length} items`;
		runButton.hidden = !selected;
		runButton.disabled = false;

		if (offlineAlert.parentElement !== pane) {
			if (state.offline) pane.insertBefore(offlineAlert, feedList);
		} else if (!state.offline) {
			offlineAlert.remove();
		}

		const failure = firstFailure(state.jobs, at);
		if (failure) {
			currentFailureJobId = failure.jobId;
			failureLabel.textContent = failure.label;
			failureMessage.textContent = ` ${failure.message}`;
			if (failureAlert.parentElement !== pane) {
				pane.insertBefore(failureAlert, feedList);
			}
		} else {
			currentFailureJobId = undefined;
			failureAlert.remove();
		}

		const items = visibleItems(state);
		const jobsById = new Map(state.jobs.map((job) => [job.id, job]));
		patchKeyedList(feedList, items, {
			key: (item) => item.id,
			create: createFeedRow,
			update: (row, item) =>
				updateFeedRow(row as HTMLLIElement, item, jobsById, at),
		});

		feedEmpty.hidden = items.length > 0;
		feedEmpty.textContent = state.loaded
			? "Nothing has come in yet."
			: "Looking for the daemon…";
	}

	const vim = createVimNav({
		order: ["feed", "jobs"],
		lists: {
			feed: {
				rowIds: () =>
					visibleItems(state)
						.filter((item) =>
							filterMatches("feed", toFeedView(item, now()).title),
						)
						.map((item) => item.id),
				select: (id) => {
					void act(api?.markRead(id) ?? Promise.resolve(false));
				},
				actions: {
					m: (id) => {
						void act(api?.markRead(id) ?? Promise.resolve(false));
					},
					q: (id) => {
						findRow(feedList, id)
							?.querySelector<HTMLButtonElement>(".dash__queue")
							?.click();
					},
				},
			},
			jobs: {
				rowIds: () =>
					state.jobs
						.filter((job) => filterMatches("jobs", job.label))
						.map((job) => job.id),
				select: (id) => {
					state = selectJob(state, state.selectedJobId === id ? undefined : id);
					render();
				},
				actions: {
					r: (id) => {
						void act(api?.runJob(id) ?? Promise.resolve(false));
					},
				},
			},
		},
		leaderActions: {
			a: () => {
				void act(api?.markAllRead() ?? Promise.resolve(false));
			},
		},
		onCursorChange: (list, id) => {
			vimCursor = { list, id };
			paintVimCursor();
			findRow(list === "jobs" ? railList : feedList, id)?.scrollIntoView?.({
				block: "nearest",
			});
		},
		onOpenFilter: (list) => {
			vimFilterInput.placeholder =
				list === "jobs" ? "Filter jobs…" : "Filter feed…";
			vimFilterInput.value = vimFilterQuery[list as "feed" | "jobs"];
			vimFilterInput.hidden = false;
			vimFilterInput.focus();
		},
		onModeChange: (isActive, message) => {
			vimToggle.setAttribute("aria-pressed", String(isActive));
			vimBar.textContent = message;
			vimBar.hidden = !isActive;
			if (!isActive) {
				vimFilterInput.hidden = true;
				paintVimCursor();
			}
		},
		onCheatSheet: (open) => {
			vimCheat.hidden = !open;
		},
		isTextInputFocused: () => isTextEntryFocused(doc),
	});

	function render(force = true): void {
		if (!force && isTextEntryFocused(doc)) return;
		const at = now();
		if (!mounted) {
			const painted = el("div", "dash");
			painted.append(buildRail(), buildPane());
			root.replaceChildren(painted);
			mounted = true;
		}
		patchRail(at);
		patchPane(at);
		paintVimCursor();
	}

	async function refresh(): Promise<void> {
		if (!api) {
			api = await connect(lastPort);
			if (!api) {
				state = applyRefresh(state, { ok: false });
				render(false);
				return;
			}
			lastPort = portOf(api);
		}
		const result = await api.refresh();
		if (!result.ok) api = undefined;
		state = applyRefresh(state, result);
		render(false);
	}

	const poller = createPoller(() => void refresh());

	function onVisibility(): void {
		poller.setHidden(doc.hidden);
	}

	function onKeydown(event: KeyboardEvent): void {
		vim.handleKeydown(event);
	}

	render();
	const ready = refresh();
	doc.addEventListener("keydown", onKeydown);

	if (options.poll !== false) {
		doc.addEventListener("visibilitychange", onVisibility);
		poller.start();
	}

	return {
		ready,
		refresh,
		stop() {
			poller.stop();
			doc.removeEventListener("visibilitychange", onVisibility);
			doc.removeEventListener("keydown", onKeydown);
		},
	};
}

if (typeof document !== "undefined") {
	const autoRoot = document.querySelector<HTMLElement>("#app");
	if (autoRoot) {
		void renderDashboard({ root: autoRoot }).ready.catch((error) => {
			console.error(
				"[dg-dashboard] could not render the dashboard page:",
				error,
			);
		});
	}
}
