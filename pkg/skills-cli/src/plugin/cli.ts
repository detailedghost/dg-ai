import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { addPlugin, listPlugins, removePlugin, setPluginEnabled, updatePlugin, verifyPlugin } from "./lifecycle";
import { type Pin, parsePin } from "./source";

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const pinText = (pin: Pin): string => `${pin.kind}:${pin.value}`;
const approveHint = (name: string): string => `Next: review ${resolveDgPaths().dataDir}/plugins/${name}/src, then run dg plugin verify ${name} --approve.`;

export function list(options: { json?: boolean }): void {
	const rows = listPlugins();
	if (options.json) return out(JSON.stringify(rows, null, 2));
	if (rows.length === 0) return out("no plugins installed. Next: run dg plugin add <git url or path>.");
	for (const row of rows) out(`${row.name}\t${row.kind}\t${row.enabled ? "on" : "off"}\t${row.approved ? "approved" : "unapproved"}\t${pinText(row.pin)}`);
}

export function add(source: string, options: { pin?: string; name?: string }): void {
	const added = addPlugin({ source, ...(options.pin ? { pin: parsePin(options.pin) } : {}), ...(options.name ? { name: options.name } : {}) });
	out(`${added.name}\t${added.kind}\t${pinText(added.pin)}\tunapproved`);
	out(`Its text is untrusted and not loaded until you approve it. ${approveHint(added.name)}`);
}

export function remove(name: string): void {
	removePlugin(name);
	out(`removed ${name}`);
}

export function enable(name: string, enabled: boolean): void {
	setPluginEnabled(name, enabled);
	out(`${name} ${enabled ? "enabled" : "disabled"}`);
}

export function update(name: string, options: { pin?: string }): void {
	const result = updatePlugin(name, options.pin ? { pin: parsePin(options.pin) } : {});
	out(`${name}\t${pinText(result.pin)}\t${result.changed ? "changed" : "unchanged"}\t${result.approved ? "approved" : "unapproved"}`);
	if (result.changed) out(`It changed, so it is disabled until you approve it again. ${approveHint(name)}`);
}

export const APPROVE_NEEDS_PERSON = "dg plugin verify --approve needs a person at a terminal; run it yourself.";

export function verify(name: string, options: { approve?: boolean }, stdin: { isTTY?: boolean } = process.stdin): void {
	if (options.approve === true && stdin.isTTY !== true) {
		process.stderr.write(`${APPROVE_NEEDS_PERSON}\n`);
		process.exitCode = 1;
		return;
	}
	const report = verifyPlugin(name, { approve: options.approve === true });
	out(`${name}: ${report.approved ? "approved" : "unapproved"}`);
	for (const problem of report.problems) out(`problem: ${problem}`);
	if (report.enforced.length) out(`dg enforces:\n${report.enforced.map((line) => `  ${line}`).join("\n")}`);
	if (report.unenforced.length) out(`dg cannot enforce (declared only):\n${report.unenforced.map((line) => `  ${line}`).join("\n")}`);
	if (!report.intact) throw new DgCliError(`dg plugin: ${report.problems[0]}`);
	if (!report.approved) out(`Imported text stays untrusted until approved. ${approveHint(name)}`);
}
