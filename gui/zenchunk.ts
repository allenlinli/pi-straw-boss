// The Zen layer's entry: its code and its stylesheet load together, the first time a page shows Zen (zen.css is the layout; the logic is zen.ts, which tests import without a stylesheet).
import "./zen.css";
export { mountZen } from "./zen.ts";
export { zenPage } from "./zenpage.ts";
import "./zenrows.ts"; // the Zen rows of the keymap (hotkeys.ts)
