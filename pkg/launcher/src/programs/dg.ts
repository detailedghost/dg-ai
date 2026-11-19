import { main as route } from "@dg/dg/main";

export const main = (argv: string[]): Promise<number> =>
	route(argv, {
		"dg-daemon": () => import("./daemon"),
		"dg-skills": () => import("./skills"),
		"dg-agent": () => import("./agent"),
	});
