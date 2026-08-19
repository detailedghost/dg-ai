/**
 * lib/features/chat-autocomplete.ts: attaches directly to the ratified
 * composer mount seam's inputElement (chat-node.ts's createComposer) —
 * offers only published manifest entries on a leading $, subagent names on
 * any @, arrow traversal, Enter accepts (never also submitting the raw
 * composer text), Escape dismisses without sending.
 *
 * [SPEC] invented module surface — plan.md names no shape for this file,
 * only that it "attaches to slice 6's documented composer mount seam" and
 * "renders the resolved argv on each row". See deferrals for the full
 * proposed contract, including the cross-slice gap this surfaced: no file
 * in any current slice owns turning a submitted "$label" body into an
 * actual command-invocation wire frame (entrypoints/chat/main.ts is outside
 * slice 8's file list) — attachCommandAutocomplete's onDispatch callback is
 * the seam a later pass must wire to a real ChatClient.
 */

import { expect, test } from "bun:test";
import type { CommandEntry } from "@dg/common";
import { Window } from "happy-dom";
import { createComposer } from "@/lib/features/chat-node";

const { attachCommandAutocomplete } = await import(
	"@/lib/features/chat-autocomplete"
);

function newContainer(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	return document.createElement("div") as unknown as HTMLElement;
}

function keydown(el: HTMLElement, key: string): void {
	const KeyboardEventCtor = (
		el.ownerDocument.defaultView as unknown as {
			KeyboardEvent: typeof KeyboardEvent;
		}
	).KeyboardEvent;
	el.dispatchEvent(
		new KeyboardEventCtor("keydown", {
			key,
			bubbles: true,
			cancelable: true,
		}),
	);
}

function typeValue(el: HTMLInputElement, value: string): void {
	el.value = value;
	const EventCtor = (
		el.ownerDocument.defaultView as unknown as { Event: typeof Event }
	).Event;
	el.dispatchEvent(new EventCtor("input", { bubbles: true }));
}

const COMMANDS: CommandEntry[] = [
	{
		label: "Echo",
		argv: ["echo", "{msg}"],
		params: [{ name: "msg", type: "string" }],
	},
	{ label: "List files", argv: ["ls", "-la"], params: [] },
];

function mountWithAutocomplete(options: {
	getSubagents?: () => string[];
	onSubmit?: (body: string) => void;
	onDispatch?: (label: string) => void;
}) {
	const container = newContainer();
	const submitted: string[] = [];
	const dispatched: string[] = [];
	createComposer(container, options.onSubmit ?? ((b) => submitted.push(b)));
	const input = container.querySelector("input") as HTMLInputElement;
	const autocomplete = attachCommandAutocomplete(input, {
		getCommands: () => COMMANDS,
		getSubagents: options.getSubagents,
		onDispatch: options.onDispatch ?? ((l) => dispatched.push(l)),
	});
	return { container, input, autocomplete, submitted, dispatched };
}

test("typing a leading $ offers only manifest entries, rendering each row's resolved argv", () => {
	const { input, autocomplete } = mountWithAutocomplete({});

	typeValue(input, "$");

	const options = [
		...autocomplete.listElement.querySelectorAll('[role="option"]'),
	];
	expect(options.length).toBe(2);
	expect(options[0]?.textContent).toContain("Echo");
	expect(options[0]?.textContent).toContain("echo {msg}");
	expect(options[1]?.textContent).toContain("ls -la");
	autocomplete.destroy();
});

test("filters manifest entries by the text typed after $", () => {
	const { input, autocomplete } = mountWithAutocomplete({});

	typeValue(input, "$list");

	const options = [
		...autocomplete.listElement.querySelectorAll('[role="option"]'),
	];
	expect(options.length).toBe(1);
	expect(options[0]?.textContent).toContain("List files");
	autocomplete.destroy();
});

test("plain prose with no $ or @ shows no suggestions at all", () => {
	const { input, autocomplete } = mountWithAutocomplete({});

	typeValue(input, "just chatting, no trigger here");

	expect(
		autocomplete.listElement.querySelectorAll('[role="option"]').length,
	).toBe(0);
	autocomplete.destroy();
});

test("the listbox carries role=listbox, and the input's aria-activedescendant tracks arrow traversal (wrapping at each end)", () => {
	const { input, autocomplete } = mountWithAutocomplete({});
	expect(autocomplete.listElement.getAttribute("role")).toBe("listbox");

	typeValue(input, "$");
	const options = [
		...autocomplete.listElement.querySelectorAll('[role="option"]'),
	];

	keydown(input, "ArrowDown");
	expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

	keydown(input, "ArrowDown");
	expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);

	// Wraps back to the first option past the last.
	keydown(input, "ArrowDown");
	expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

	// ArrowUp from the first wraps to the last.
	keydown(input, "ArrowUp");
	expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
	autocomplete.destroy();
});

test("Enter accepts the highlighted command, dispatching it and never submitting the raw composer text", () => {
	const { input, autocomplete, submitted, dispatched } = mountWithAutocomplete(
		{},
	);

	typeValue(input, "$list");
	keydown(input, "ArrowDown");
	keydown(input, "Enter");

	expect(dispatched).toEqual(["List files"]);
	expect(submitted).toEqual([]);
	expect(input.value).toBe("");
	expect(
		autocomplete.listElement.querySelectorAll('[role="option"]').length,
	).toBe(0);
	autocomplete.destroy();
});

test("Escape dismisses the listbox without dispatching or submitting anything, leaving the typed text intact", () => {
	const { input, autocomplete, submitted, dispatched } = mountWithAutocomplete(
		{},
	);

	typeValue(input, "$list");
	keydown(input, "ArrowDown");
	keydown(input, "Escape");

	expect(dispatched).toEqual([]);
	expect(submitted).toEqual([]);
	expect(input.value).toBe("$list");
	expect(
		autocomplete.listElement.querySelectorAll('[role="option"]').length,
	).toBe(0);
	autocomplete.destroy();
});

test("an @ mention triggers subagent suggestions from anywhere in the text, not just a leading position", () => {
	const { input, autocomplete } = mountWithAutocomplete({
		getSubagents: () => ["reviewer", "planner"],
	});

	typeValue(input, "could @rev");

	const options = [
		...autocomplete.listElement.querySelectorAll('[role="option"]'),
	];
	expect(options.length).toBe(1);
	expect(options[0]?.textContent).toContain("reviewer");
	autocomplete.destroy();
});

test("accepting an @ suggestion inserts the resolved name in place, rather than dispatching a command", () => {
	const { input, autocomplete, dispatched } = mountWithAutocomplete({
		getSubagents: () => ["reviewer", "planner"],
	});

	typeValue(input, "could @rev");
	keydown(input, "ArrowDown");
	keydown(input, "Enter");

	expect(dispatched).toEqual([]);
	expect(input.value).toBe("could @reviewer ");
	autocomplete.destroy();
});

test("destroy() removes the listbox and stops the input from reacting to further $ input", () => {
	const { input, autocomplete } = mountWithAutocomplete({});
	typeValue(input, "$"); // render it live first, so disconnection below is meaningful
	expect(autocomplete.listElement.isConnected).toBe(true);

	autocomplete.destroy();
	expect(autocomplete.listElement.isConnected).toBe(false);

	typeValue(input, "$");
	expect(input.ownerDocument.querySelectorAll('[role="listbox"]').length).toBe(
		0,
	);
});
