import { describe, expect, test } from "bun:test";
import { Argument, Command, Option } from "commander";
import { type CompletionNode, completeWords, completionScript, FILES_DIRECTIVE, treeOf } from "../src/completion";

const tree: CompletionNode = {
	name: "dg-skills",
	options: [{ flags: ["--version", "-V"], description: "print the version" }],
	commands: [
		{
			name: "stat",
			description: "track a checklist",
			commands: [
				{ name: "checklist", description: "print the checklist", options: [{ flags: ["--json"] }] },
				{ name: "status" },
			],
		},
		{ name: "stash", options: [{ flags: ["--out", "-o"], value: "path" }, { flags: ["--kind"], value: ["html", "md"] }] },
		{
			name: "pw",
			commands: [{ name: "goto" }],
			options: [{ flags: ["--ext"], mode: { name: "pw --ext", commands: [{ name: "snapshot" }, { name: "click" }] } }],
		},
		{ name: "sniff", path: true },
		{ name: "completion", values: ["bash", "zsh", "fish"] },
	],
};

const values = (lines: string[]): string[] => lines.map((line) => line.split("\t")[0] ?? "");

describe("completeWords", () => {
	test("completes a top-level command from its prefix, with its description", () => {
		expect(completeWords(tree, ["st"])).toEqual(["stat\ttrack a checklist", "stash"]);
	});

	test("completes a nested command", () => {
		expect(values(completeWords(tree, ["stat", "ch"]))).toEqual(["checklist"]);
		expect(values(completeWords(tree, ["stat", ""]))).toEqual(["checklist", "status"]);
	});

	test("completes long flags of the command and its parents, plus --help", () => {
		expect(values(completeWords(tree, ["stat", "checklist", "--"]))).toEqual(["--json", "--version", "--help"]);
	});

	test("an option that switches mode replaces the command set", () => {
		expect(values(completeWords(tree, ["pw", "--ext", ""]))).toEqual(["snapshot", "click"]);
		expect(values(completeWords(tree, ["pw", ""]))).toEqual(["goto"]);
	});

	test("a path option value asks the shell for files", () => {
		expect(completeWords(tree, ["stash", "--out", ""])).toEqual([FILES_DIRECTIVE]);
		expect(completeWords(tree, ["stash", "-o", "x"])).toEqual([FILES_DIRECTIVE]);
	});

	test("an option with choices completes them, also after an equals sign", () => {
		expect(completeWords(tree, ["stash", "--kind", "h"])).toEqual(["html"]);
		expect(completeWords(tree, ["stash", "--kind=m"])).toEqual(["--kind=md"]);
	});

	test("a word after a value option is not read as a command", () => {
		expect(values(completeWords(tree, ["stash", "--kind", "html", "--k"]))).toEqual(["--kind"]);
	});

	test("flags still complete after a positional argument, but not after --", () => {
		expect(values(completeWords(tree, ["stash", "notes", "--k"]))).toEqual(["--kind"]);
		expect(completeWords(tree, ["stash", "notes", "--kind", "m"])).toEqual(["md"]);
		expect(completeWords(tree, ["stash", "--", "--k"])).toEqual([]);
	});

	test("a path argument asks the shell for files", () => {
		expect(completeWords(tree, ["sniff", ""])).toEqual([FILES_DIRECTIVE]);
	});

	test("argument choices complete", () => {
		expect(completeWords(tree, ["completion", "z"])).toEqual(["zsh"]);
	});

	test("an unknown word gives no candidates", () => {
		expect(completeWords(tree, ["nope", ""])).toEqual([]);
		expect(completeWords(tree, ["zz"])).toEqual([]);
	});

	test("an empty word list completes the top-level commands", () => {
		expect(values(completeWords(tree, []))).toEqual(["stat", "stash", "pw", "sniff", "completion"]);
	});
});

describe("treeOf", () => {
	test("reads commands, options, choices and path arguments from Commander", () => {
		const program = new Command("prog");
		program.option("--verbose", "say more");
		program.command("hidden", { hidden: true });
		const sub = program.command("load").description("load a\nfile");
		sub.argument("<file>");
		sub.option("--out <path>", "where to write");
		sub.addOption(new Option("--mode <mode>").choices(["a", "b"]));
		sub.option("--name <name>");
		program.command("pick").addArgument(new Argument("<shell>").choices(["bash", "zsh"]));

		expect(treeOf(program)).toEqual({
			name: "prog",
			options: [{ flags: ["--verbose"], description: "say more" }],
			commands: [
				{
					name: "load",
					description: "load a file",
					path: true,
					options: [
						{ flags: ["--out"], description: "where to write", value: "path" },
						{ flags: ["--mode"], value: ["a", "b"] },
						{ flags: ["--name"], value: "any" },
					],
				},
				{ name: "pick", values: ["bash", "zsh"] },
			],
		});
	});
});

describe("completionScript", () => {
	test("each script calls the program back for words", () => {
		for (const shell of ["bash", "zsh", "fish"] as const)
			expect(completionScript(shell, "dg-skills")).toContain("dg-skills __complete");
	});

	test("the zsh script starts with the compdef tag that fpath autoload reads", () => {
		expect(completionScript("zsh", "dg-agent").split("\n")[0]).toBe("#compdef dg-agent");
	});
});
