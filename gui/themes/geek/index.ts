// The Geek theme: a stylesheet only (geek.css, black, monospace, nothing moves). It loads the first time a page shows Geek (gui/themes/registry.ts), or boot.js links it before the first frame.
import "./geek.css";
import type { ThemeParts } from "../theme.ts";

export const theme: ThemeParts = {};
