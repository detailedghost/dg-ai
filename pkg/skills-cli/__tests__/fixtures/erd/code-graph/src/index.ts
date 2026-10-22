import path from "node:path";
import { helper } from "./utils";

export function run(): string {
	return path.basename(helper());
}
