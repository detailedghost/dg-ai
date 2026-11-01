import type { ClientHandler } from "../../core/spec";

const installBrowserCommand: ClientHandler = async (_args, env) => {
	const { browserStatus, installBrowser } = await import("../../browsers");
	const { version } = await installBrowser();
	const status = browserStatus();
	env.out(`### Chromium ${version} installed\n- system: ${status.system}\n- downloaded: ${status.downloaded}`);
	return 0;
};

export default installBrowserCommand;
