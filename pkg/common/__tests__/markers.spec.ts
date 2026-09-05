import { describe, expect, it } from "bun:test";
import {
	DEMO_MARKER_KEY,
	EDIT_MARKER_KEY,
	MARKER_KEY,
	MARKER_POS_KEY,
	PROTO_MARKER_KEY,
} from "../src/index";

describe("URL-fragment marker keys", () => {
	it("are the fixed keys the CLI writes and the extension reads", () => {
		expect(MARKER_KEY).toBe("_tab_group");
		expect(MARKER_POS_KEY).toBe("_tab_group_pos");
		expect(DEMO_MARKER_KEY).toBe("_demo");
		expect(EDIT_MARKER_KEY).toBe("_edit");
		expect(PROTO_MARKER_KEY).toBe("_proto");
	});
});
