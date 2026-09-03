import {
	applyRefresh,
	connectDashboardApi,
	createDashboardState,
	DASHBOARD_POLL_MS,
	type DashboardApi,
	type DashboardState,
	firstFailure,
	type JobPayload,
	selectJob,
	summarize,
	toFeedView,
	toJobView,
	visibleItems,
} from "@/lib/features/dashboard";
import "../options/style.css";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

let state: DashboardState = createDashboardState();
let api: DashboardApi | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
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

function renderJob(job: JobPayload, now: Date): HTMLLIElement {
	const view = toJobView(job, now);
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
			view.state === "failed" ? "dash__prog dash__prog--failed" : "dash__prog",
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

function renderItems(now: Date): HTMLElement {
	const list = el("ul", "dash__feed");
	const items = visibleItems(state);

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
		const view = toFeedView(item, now);
		const row = el(
			"li",
			view.unread
				? "dash__item dash__item--unread"
				: "dash__item dash__item--read",
		);

		const body = el("div");
		const top = el("div", "dash__top");
		const job = state.jobs.find((candidate) => candidate.id === item.jobId);
		const source = job ? toJobView(job, now).source : "Job";
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

function renderRail(now: Date): HTMLElement {
	const rail = el("aside", "dash__rail");

	const head = el("div", "dash__head");
	const brand = el("h1", "dash__brand");
	brand.append(el("span", "dash__mk"), document.createTextNode("Jobs"));
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
	for (const job of state.jobs) list.append(renderJob(job, now));
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

function renderPane(now: Date): HTMLElement {
	const pane = el("section", "dash__pane");
	const selected = state.jobs.find((job) => job.id === state.selectedJobId);

	const head = el("div", "dash__head");
	head.append(
		el("h2", "dash__title", selected ? selected.label : "All jobs"),
		el(
			"span",
			"dash__sub",
			selected
				? `${toJobView(selected, now).detail} · ${toJobView(selected, now).when}`
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
			document.createTextNode(" Showing the last data it gave."),
		);
		pane.append(alert);
	}

	const failure = firstFailure(state.jobs, now);
	if (failure) {
		const alert = el("div", "dash__alert");
		alert.append(
			el("b", undefined, failure.label),
			document.createTextNode(` ${failure.message}`),
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

	pane.append(renderItems(now));
	return pane;
}

function render(): void {
	if (!app) return;
	const now = new Date();
	const root = el("div", "dash");
	root.append(renderRail(now), renderPane(now));
	app.replaceChildren(root);
}

async function refresh(): Promise<void> {
	if (!api) {
		api = await connectDashboardApi();
		if (!api) {
			state = applyRefresh(state, { ok: false });
			render();
			return;
		}
	}
	const result = await api.refresh();
	if (!result.ok) api = undefined;
	state = applyRefresh(state, result);
	render();
}

function startPolling(): void {
	if (timer !== undefined) return;
	timer = setInterval(() => void refresh(), DASHBOARD_POLL_MS);
}

function stopPolling(): void {
	if (timer === undefined) return;
	clearInterval(timer);
	timer = undefined;
}

document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		stopPolling();
		return;
	}
	void refresh();
	startPolling();
});

render();
void refresh();
startPolling();
