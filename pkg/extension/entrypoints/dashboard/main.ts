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
	let lastPainted = "";

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

	function renderJob(job: JobPayload, at: Date): HTMLLIElement {
		const view = toJobView(job, at);
		const row = el("li");
		const target = el("button", `dash__job dash__job--${view.state}`);
		target.type = "button";
		if (state.selectedJobId === job.id)
			target.setAttribute("aria-current", "true");
		target.addEventListener("click", () => {
			state = selectJob(
				state,
				state.selectedJobId === job.id ? undefined : job.id,
			);
			render();
		});

		const top = el("div", "dash__jobtop");
		top.append(
			el("span", `dash__dot dash__dot--${view.state}`),
			el("span", "dash__jobname", view.label),
			el(
				"span",
				view.unread > 0 ? "dash__pill" : "dash__pill dash__pill--none",
				String(view.unread),
			),
		);

		const meta = el(
			"div",
			view.state === "failed"
				? "dash__jobmeta dash__jobmeta--failed"
				: "dash__jobmeta",
		);
		meta.append(
			el(
				"span",
				`dash__badge dash__badge--${view.source.toLowerCase()}`,
				view.source,
			),
			el("span", undefined, view.state === "failed" ? view.detail : view.every),
			spacer(),
			el("span", undefined, view.when),
		);

		target.append(top, meta);
		if (view.state !== "paused") {
			const progress = el(
				"span",
				view.state === "failed"
					? "dash__prog dash__prog--failed"
					: "dash__prog",
			);
			progress.style.transform = `scaleX(${view.progress.toFixed(3)})`;
			target.append(progress);
		}

		row.append(target);
		return row;
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

	function renderItems(at: Date): HTMLElement {
		const list = el("ul", "dash__feed");
		const items = visibleItems(state);
		const jobsById = new Map(state.jobs.map((job) => [job.id, job]));

		if (items.length === 0) {
			const empty = el(
				"div",
				"dash__empty",
				state.loaded ? "Nothing has come in yet." : "Looking for the daemon…",
			);
			list.append(empty);
			return list;
		}

		for (const item of items) {
			const view = toFeedView(item, at);
			const row = el(
				"li",
				view.unread
					? "dash__item dash__item--unread"
					: "dash__item dash__item--read",
			);

			const body = el("div");
			const top = el("div", "dash__top");
			const job = jobsById.get(item.jobId);
			const source = job ? toJobView(job, at).source : "Job";
			top.append(
				el("span", `dash__badge dash__badge--${source.toLowerCase()}`, source),
				el("span", "dash__itemtitle", view.title),
			);
			body.append(top, el("div", "dash__meta", view.meta));

			const mark = button("", "dash__mark");
			mark.title = view.unread ? "Mark read" : "Read";
			mark.disabled = !view.unread;
			mark.addEventListener("click", () => {
				void act(api?.markRead(item.id) ?? Promise.resolve(false));
			});

			row.append(mark, body, renderQueueControl(item.id));
			list.append(row);
		}

		return list;
	}

	function renderRail(at: Date): HTMLElement {
		const rail = el("aside", "dash__rail");

		const head = el("div", "dash__head");
		const brand = el("h1", "dash__brand");
		brand.append(el("span", "dash__mk"), doc.createTextNode("Jobs"));
		const schedule = button("+ Schedule", "dash__btn dash__btn--ghost");
		schedule.disabled = true;
		schedule.title =
			"Adding jobs in the browser is the next page — use `dg-daemon job add` for now";
		head.append(brand, spacer(), schedule);

		const counts = summarize(state.jobs);
		const summary = el("div", "dash__summary");
		summary.append(
			el("span", undefined, `${counts.total} jobs · ${counts.active} active`),
			spacer(),
		);
		if (counts.failed > 0) {
			summary.append(el("b", undefined, `${counts.failed} failed`));
		}

		const list = el("ul", "dash__jobs");
		for (const job of state.jobs) list.append(renderJob(job, at));
		if (state.jobs.length === 0) {
			list.append(
				el(
					"div",
					"dash__empty",
					state.loaded ? "No jobs scheduled yet." : "Looking for the daemon…",
				),
			);
		}

		rail.append(head, summary, list);
		return rail;
	}

	function renderPane(at: Date): HTMLElement {
		const pane = el("section", "dash__pane");
		const selected = state.jobs.find((job) => job.id === state.selectedJobId);

		const head = el("div", "dash__head");
		head.append(
			el("h2", "dash__title", selected ? selected.label : "All jobs"),
			el(
				"span",
				"dash__sub",
				selected
					? `${toJobView(selected, at).detail} · ${toJobView(selected, at).when}`
					: `${visibleItems(state).length} items`,
			),
			spacer(),
		);

		if (selected) {
			const run = button("Run now");
			run.addEventListener("click", () => {
				run.disabled = true;
				void act(api?.runJob(selected.id) ?? Promise.resolve(false));
			});
			head.append(run);
		}

		const markAll = button("Mark all read");
		markAll.addEventListener("click", () => {
			void act(api?.markAllRead() ?? Promise.resolve(false));
		});
		head.append(markAll);
		pane.append(head);

		if (state.offline) {
			const alert = el("div", "dash__alert dash__alert--offline");
			alert.append(
				el("b", undefined, "The daemon is not answering."),
				doc.createTextNode(" Showing the last data it gave."),
			);
			pane.append(alert);
		}

		const failure = firstFailure(state.jobs, at);
		if (failure) {
			const alert = el("div", "dash__alert");
			alert.append(
				el("b", undefined, failure.label),
				doc.createTextNode(` ${failure.message}`),
				spacer(),
			);
			const show = button("Show job");
			show.addEventListener("click", () => {
				state = selectJob(state, failure.jobId);
				render();
			});
			alert.append(show);
			pane.append(alert);
		}

		pane.append(renderItems(at));
		return pane;
	}

	/** The poll must not tear down a half-typed agent identity under the user. */
	function isEditing(): boolean {
		return doc.activeElement?.classList.contains("dash__identity") ?? false;
	}

	function paintKey(): string {
		return JSON.stringify([
			state.jobs,
			state.items,
			state.selectedJobId,
			state.offline,
			state.loaded,
		]);
	}

	function render(force = true): void {
		const key = paintKey();
		if (!force && (key === lastPainted || isEditing())) return;
		lastPainted = key;
		const at = now();
		const painted = el("div", "dash");
		painted.append(renderRail(at), renderPane(at));
		root.replaceChildren(painted);
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

	render();
	const ready = refresh();

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
		},
	};
}

if (typeof document !== "undefined") {
	const autoRoot = document.querySelector<HTMLElement>("#app");
	if (autoRoot) renderDashboard({ root: autoRoot });
}
