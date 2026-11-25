import type { Command } from "commander";

const load = () => import("../plugin/cli");

/** Registers plugin list, add, remove, enable, disable, update and verify. */
export function registerPlugin(program: Command): void {
	const plugin = program.command("plugin").description("Install, pin and approve skill plugins");
	plugin
		.command("list")
		.description("list installed plugins with their pin and approval")
		.option("--json", "print JSON")
		.action(async (options) => (await load()).list(options));
	plugin
		.command("add")
		.description("install a skill bundle from a git url or path, pinned and untrusted until approved")
		.argument("<source>", "git url or folder path")
		.option("--pin <pin>", "require commit:<hex> or sha256:<hex>")
		.option("--name <name>", "plugin name; defaults to the manifest name or the source name")
		.action(async (source: string, options) => (await load()).add(source, options));
	plugin
		.command("remove")
		.description("delete a plugin and its [plugins.<name>] section")
		.argument("<name>")
		.action(async (name: string) => (await load()).remove(name));
	plugin
		.command("enable")
		.description("turn on an approved plugin")
		.argument("<name>")
		.action(async (name: string) => (await load()).enable(name, true));
	plugin
		.command("disable")
		.description("turn off a plugin; it stays approved")
		.argument("<name>")
		.action(async (name: string) => (await load()).enable(name, false));
	plugin
		.command("update")
		.description("re-fetch the source; a change needs approval again")
		.argument("<name>")
		.option("--pin <pin>", "require commit:<hex> or sha256:<hex>")
		.action(async (name: string, options) => (await load()).update(name, options));
	plugin
		.command("verify")
		.description("check installed files, report what dg cannot enforce, and approve with --approve")
		.argument("<name>")
		.option("--approve", "approve the reviewed files and load the skills")
		.action(async (name: string, options) => (await load()).verify(name, options));
}
