import type { DaemonHandler } from "../../core/spec";

const dialogAccept: DaemonHandler = async (ctx, args) => {
	const dialog = ctx.events.takeDialog(ctx.page());
	if (!dialog) throw new Error("No dialog visible");
	const prompt = args.positionals[0];
	await dialog.accept(prompt);
	return {
		code: `await dialog.accept(${prompt === undefined ? "" : JSON.stringify(prompt)});`,
		snapshot: true,
	};
};

export default dialogAccept;
