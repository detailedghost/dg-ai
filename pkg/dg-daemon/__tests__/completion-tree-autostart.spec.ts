import { describe, expect, test } from "bun:test";
import tree from "../src/completion-tree.json";

type Node = { name: string; commands?: Node[] };

describe("the dg daemon completion tree", () => {
	test("holds the autostart group with install, remove and status", () => {
		const group = (tree as Node).commands?.find((command) => command.name === "autostart");

		expect(group?.commands?.map((command) => command.name).sort()).toEqual(["install", "remove", "status"]);
	});
});
