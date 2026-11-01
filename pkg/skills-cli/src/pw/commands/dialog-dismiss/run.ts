import type { DaemonHandler } from "../../core/spec";

const dialogDismiss: DaemonHandler = async (ctx) => {
	const dialog = ctx.events.takeDialog(ctx.page());
	if (!dialog) throw new Error("No dialog visible");
	await dialog.dismiss();
	return { code: "await dialog.dismiss();", snapshot: true };
};

export default dialogDismiss;
