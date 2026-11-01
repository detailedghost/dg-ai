import { selfCommand } from "@dg/common/node";
import type { HookHandler } from "../types";

const PLAN = /\.agents\/spec\/(?:todo\/)?[^/]+\/plan\.md$/;
const CHECKS = ["validate", "lint-waves"] as const;

const handler: HookHandler = async (input, ctx) => {
	const file = String(
		input.tool_response?.["filePath"] ?? input.tool_input?.["file_path"] ?? "",
	);
	if (!PLAN.test(file.replaceAll("\\", "/"))) return { exitCode: 0 };
	const cwd = input.cwd ?? process.cwd();
	const results = await Promise.all(
		CHECKS.map((check) =>
			ctx.seams.run(selfCommand(["spec", check, file]), { cwd }),
		),
	);
	const failures = results.flatMap((result, i) =>
		result.status === 0
			? []
			: [
					`spec ${CHECKS[i]} failed (exit ${result.status}):\n${`${result.stdout}${result.stderr}`.trim()}`,
				],
	);
	if (failures.length === 0) return { exitCode: 0 };
	return { exitCode: 2, stderr: `${file}\n${failures.join("\n\n")}\n` };
};

export default handler;
