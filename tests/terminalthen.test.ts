import assert from "node:assert/strict";
import { test } from "node:test";
import { onStep, openThen, type StepOpen } from "../gui/terminalthen.ts";

test("one tap: `then.run` with the answer's id opens the prompt step with that grant; without either, or for a pane, there is none", () => {
	const got: StepOpen[] = [];
	onStep((s) => void got.push(s));
	openThen({ terminal: true, run: true }, { key: "S", command: "x", answerId: "a1b2c3d4e5f6a7b8" });
	openThen({ terminal: true }, { key: "S", command: "x", answerId: "a1b2c3d4e5f6a7b8" });
	openThen({ terminal: true, run: true }, { key: "S", command: "x", answerId: "" });
	openThen({ pane: "g1" }, { key: "S", command: "x", answerId: "a1b2c3d4e5f6a7b8" });
	onStep(undefined);
	assert.deepEqual(got.map((s) => s.run), ["a1b2c3d4e5f6a7b8", undefined, undefined, undefined]);
});
