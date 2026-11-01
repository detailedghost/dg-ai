import { buildFilePayloads } from "../../core/files";
import type { DaemonHandler } from "../../core/spec";

const upload: DaemonHandler = async (ctx, args) => {
	const page = ctx.page();
	if (!ctx.events.hasChooser(page)) throw new Error("No file chooser visible");
	const payloads = await buildFilePayloads(args.positionals, ctx.clientCwd);
	const chooser = ctx.events.takeChooser(page);
	if (!chooser) throw new Error("No file chooser visible");
	await chooser.setFiles(payloads);
	return {
		code: `await fileChooser.setFiles(${JSON.stringify(args.positionals)});`,
		snapshot: true,
	};
};

export default upload;
