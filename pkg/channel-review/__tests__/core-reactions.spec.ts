import { describe, expect, test } from "bun:test";
import { REACTION_STATES, transition } from "../src/reactions";

const STATES = REACTION_STATES;
type State = (typeof STATES)[number];

const IDS: Record<State, string> = {
	pending: "id-pending",
	inProgress: "id-inProgress",
	approved: "id-approved",
	changesRequested: "id-changesRequested",
	comment: "id-comment",
	failure: "id-failure",
};

const ALLOWED: [State | null, State][] = [
	[null, "pending"],
	["pending", "inProgress"],
	["inProgress", "approved"],
	["inProgress", "changesRequested"],
	["inProgress", "comment"],
	["inProgress", "failure"],
	["pending", "failure"],
	[null, "failure"],
];

const isAllowed = (from: State | null, to: State): boolean =>
	ALLOWED.some(([f, t]) => f === from && t === to);

describe("transition", () => {
	test("yields delete-then-put for pending to inProgress", () => {
		expect(transition("pending", "inProgress", IDS)).toEqual([
			{ op: "delete", reactionId: IDS.pending },
			{ op: "put", reactionId: IDS.inProgress },
		]);
	});

	test("yields only a put when there is no previous state", () => {
		expect(transition(null, "pending", IDS)).toEqual([
			{ op: "put", reactionId: IDS.pending },
		]);
		expect(transition(null, "failure", IDS)).toEqual([
			{ op: "put", reactionId: IDS.failure },
		]);
	});

	test.each(ALLOWED.filter(([from]) => from !== null))(
		"allows %s -> %s with a delete of the old id and a put of the new id",
		(from, to) => {
			expect(transition(from, to, IDS)).toEqual([
				{ op: "delete", reactionId: IDS[from as State] },
				{ op: "put", reactionId: IDS[to] },
			]);
		},
	);

	test("throws on inProgress -> pending", () => {
		expect(() => transition("inProgress", "pending", IDS)).toThrow();
	});

	const everyEdge = ([null, ...STATES] as (State | null)[]).flatMap((from) =>
		STATES.map((to): [State | null, State] => [from, to]),
	);

	test.each(everyEdge.filter(([from, to]) => !isAllowed(from, to)))(
		"throws on disallowed edge %s -> %s",
		(from, to) => {
			expect(() => transition(from, to, IDS)).toThrow();
		},
	);

	test.each(everyEdge.filter(([from, to]) => isAllowed(from, to)))(
		"does not throw on allowed edge %s -> %s",
		(from, to) => {
			expect(() => transition(from, to, IDS)).not.toThrow();
		},
	);
});
