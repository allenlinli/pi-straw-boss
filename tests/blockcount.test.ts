import assert from "node:assert/strict";
import { test } from "node:test";
import { blockCount } from "../src/blockcount.ts";
import "./pbs-loader.ts";

// The server cannot import the parser (pi-better-show is bundled into the page, not shipped to the server), so it counts the places a block can be, with the parser's own line scan: fences whose first word names a kind, and alert quotes. It is an upper bound on
// the blocks the page draws (a block that does not fit its schema is shown as source and has no index); this test holds it equal to the parser's blocks plus its invalid ones, for the demo documents and a set of awkward ones.

const { parse } = await import("pi-better-show");
const { DEMO_BLOCKS_DOC, DEMO_CHAT_BLOCKS } = await import("../gui/demo-blocks.ts");
const ticks = "```";
const awkward: Record<string, string> = {
	empty: "",
	prose: "just words\n\n> a quote that is no alert\n\n    indented\n",
	"two alerts in a row": "> [!NOTE] one\n> body\n\n> [!TIP]\n> two\n",
	"an alert with no marker": "> [!NOPE] x\n> body\n",
	"an unknown fence": `${ticks}js\nlet a = 1\n${ticks}\n\n${ticks}suggest\n- Go\n${ticks}\n`,
	"a fence in a longer fence": `~~~~\n${ticks}suggest\n- Go\n${ticks}\n~~~~\n\n${ticks}suggest\n- Stop\n${ticks}\n`,
	"an unclosed fence": `${ticks}form\nquestions: []\n`,
	"an invalid block": `${ticks}form\nquestions: not-a-list\n${ticks}\n\n${ticks}suggest\n- Go\n${ticks}\n`,
	"a tilde block with an info word after": `~~~Suggest extra words\n- Go\n~~~\n`,
	"an indented fence": `   ${ticks}suggest\n   - Go\n   ${ticks}\n`,
	"CRLF": `${ticks}suggest\r\n- Go\r\n${ticks}\r\n\r\n> [!WARNING] w\r\n> b\r\n`,
	"an alert inside a fence": `${ticks}js\n> [!NOTE] x\n${ticks}\n`,
	"every kind": ["mermaid", "diff", "cards", "options", "form", "review", "mindmap", "suggest", "checklist", "table", "steps", "stats"].map((k) => `${ticks}${k}\nx\n${ticks}`).join("\n\n"),
};

test("the count equals the parser's blocks plus its invalid ones, so no valid block's index is ever past it", () => {
	for (const [name, text] of Object.entries({ ...awkward, demo: DEMO_BLOCKS_DOC, chat: DEMO_CHAT_BLOCKS })) {
		const want = parse(text).filter((s: { type: string }) => s.type !== "markdown").length;
		assert.equal(blockCount(text), want, name);
		const valid = parse(text).filter((s: { type: string }) => s.type === "block").length;
		assert.ok(blockCount(text) >= valid, name);
	}
});
