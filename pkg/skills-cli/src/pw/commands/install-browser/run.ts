import type { ClientHandler } from "../../core/spec";

const installBrowserCommand: ClientHandler = async (args, env) => {
	if (args.flags["remove"] === true) {
		const { removeBrowser } = await import("../../browsers");
		env.out(removeBrowser() ? "### Downloaded Chromium removed" : "### No downloaded Chromium to remove");
		return 0;
	}
	const { browserStatus, installBrowser } = await import("../../browsers");
	const { version } = await installBrowser();
	const status = browserStatus();
	env.out(`### Chromium ${version} installed\n- system: ${status.system}\n- downloaded: ${status.downloaded}`);
	return 0;
};

export default installBrowserCommand;
