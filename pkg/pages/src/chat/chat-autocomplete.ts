import type { CommandEntry } from "@dg/common";

export type AttachCommandAutocompleteOptions = {
	getCommands: () => CommandEntry[];
	getSubagents?: () => string[];
	onDispatch: (commandLabel: string) => void;
};

export type CommandAutocomplete = {
	listElement: HTMLElement;
	destroy(): void;
};

type Trigger =
	| { type: "command"; startIndex: number; query: string }
	| { type: "mention"; startIndex: number; query: string };

const TRAILING_MENTION = /@([A-Za-z0-9_-]*)$/;

function parseTrigger(value: string): Trigger | undefined {
	if (value.startsWith("$")) {
		return { type: "command", startIndex: 0, query: value.slice(1) };
	}
	const match = TRAILING_MENTION.exec(value);
	return match
		? { type: "mention", startIndex: match.index, query: match[1] }
		: undefined;
}

function matchesQuery(text: string, query: string): boolean {
	return text.toLowerCase().includes(query.toLowerCase());
}

export function attachCommandAutocomplete(
	inputElement: HTMLInputElement,
	options: AttachCommandAutocompleteOptions,
): CommandAutocomplete {
	const doc = inputElement.ownerDocument;
	const listElement = doc.createElement("ul");
	listElement.setAttribute("role", "listbox");
	listElement.className = "chat-autocomplete";
	(doc.body ?? doc.documentElement).appendChild(listElement);

	let trigger: Trigger | undefined;
	let commandMatches: CommandEntry[] = [];
	let subagentMatches: string[] = [];
	let activeIndex = -1;

	function optionCount(): number {
		return trigger?.type === "command"
			? commandMatches.length
			: subagentMatches.length;
	}

	function updateActiveDescendant(): void {
		const option =
			activeIndex >= 0 ? listElement.children[activeIndex] : undefined;
		if (option) inputElement.setAttribute("aria-activedescendant", option.id);
		else inputElement.removeAttribute("aria-activedescendant");
	}

	function render(): void {
		listElement.replaceChildren();
		const count = optionCount();
		for (let i = 0; i < count; i++) {
			const option = doc.createElement("li");
			option.setAttribute("role", "option");
			option.id = `chat-autocomplete-option-${i}`;
			option.textContent =
				trigger?.type === "command"
					? `${commandMatches[i].label} — ${commandMatches[i].argv.join(" ")}`
					: subagentMatches[i];
			listElement.appendChild(option);
		}
		updateActiveDescendant();
	}

	function close(): void {
		trigger = undefined;
		commandMatches = [];
		subagentMatches = [];
		activeIndex = -1;
		listElement.replaceChildren();
		inputElement.removeAttribute("aria-activedescendant");
	}

	function recompute(): void {
		trigger = parseTrigger(inputElement.value);
		activeIndex = -1;
		if (!trigger) {
			commandMatches = [];
			subagentMatches = [];
			listElement.replaceChildren();
			inputElement.removeAttribute("aria-activedescendant");
			return;
		}
		const query = trigger.query;
		if (trigger.type === "command") {
			commandMatches = options
				.getCommands()
				.filter((entry) => matchesQuery(entry.label, query));
			subagentMatches = [];
		} else {
			subagentMatches = (options.getSubagents?.() ?? []).filter((name) =>
				matchesQuery(name, query),
			);
			commandMatches = [];
		}
		render();
	}

	function moveActive(delta: number): void {
		const count = optionCount();
		if (count === 0) return;
		activeIndex = (activeIndex + delta + count) % count;
		updateActiveDescendant();
	}

	function acceptActive(): void {
		if (!trigger || activeIndex < 0) return;
		if (trigger.type === "command") {
			const label = commandMatches[activeIndex].label;
			inputElement.value = "";
			close();
			options.onDispatch(label);
		} else {
			const name = subagentMatches[activeIndex];
			const startIndex = trigger.startIndex;
			inputElement.value = `${inputElement.value.slice(0, startIndex)}@${name} `;
			close();
		}
	}

	function onInput(): void {
		recompute();
	}

	function onKeydown(event: KeyboardEvent): void {
		if (optionCount() === 0) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				moveActive(1);
				return;
			case "ArrowUp":
				event.preventDefault();
				moveActive(-1);
				return;
			case "Enter":
				if (activeIndex < 0) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				acceptActive();
				return;
			case "Escape":
				event.preventDefault();
				close();
				return;
		}
	}

	const captureTarget = inputElement.parentElement ?? inputElement;
	const keydownListener = onKeydown as EventListener;
	inputElement.addEventListener("input", onInput);
	captureTarget.addEventListener("keydown", keydownListener, { capture: true });

	return {
		listElement,
		destroy(): void {
			inputElement.removeEventListener("input", onInput);
			captureTarget.removeEventListener("keydown", keydownListener, {
				capture: true,
			} as EventListenerOptions);
			listElement.remove();
		},
	};
}
