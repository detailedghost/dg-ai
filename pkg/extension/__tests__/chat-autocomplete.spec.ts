import { expect, test } from "bun:test";
import type { CommandEntry } from "@dg/common";
import { createComposer } from "@/lib/features/chat-node";
import { createTestContainer, keydown, typeValue } from "./utils/dom-events";

const { attachCommandAutocomplete } = await import(
	"@/lib/features/chat-autocomplete"
);

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
	const container = createTestContainer();
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

	keydown(input, "ArrowDown");
	expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

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
	typeValue(input, "$");
	expect(autocomplete.listElement.isConnected).toBe(true);

	autocomplete.destroy();
	expect(autocomplete.listElement.isConnected).toBe(false);

	typeValue(input, "$");
	expect(input.ownerDocument.querySelectorAll('[role="listbox"]').length).toBe(
		0,
	);
});
