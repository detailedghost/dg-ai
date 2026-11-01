import { defineCommand } from "../../core/spec";

export default defineCommand({
	name: "upload",
	group: "core",
	side: "daemon",
	positionals: [{ name: "file", required: true, variadic: true }],
	flags: [],
	help: "Upload one or multiple files\nAn absolute path works from anywhere. A relative path resolves against the current directory. Each file is capped at 50 MB.",
	changesPage: true,
});
