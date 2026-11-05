// The commands that end or replace a session, alone in a module with no imports, so the page (gui/termcard.ts, gui/confirmwords.ts) can
// load it in the browser; src/probe.ts, which loads node:crypto through runs.ts, re-exports it for the server side.

/** Commands that end the session or switch its pane to another one: the page asks first, and the server refuses them unconfirmed. */
export const ENDING = /^\s*\/(quit|exit|new|resume|fork|clone|import|reload)(?=\s|$)/;
