# pi-better-show in the GUI (todo #129, items 2, 3 and 5)

Status: built on `feat/better-show`; waits for pi-better-show 0.1.0 on npm (this branch depends on a packed tarball until then). Design of the package: `~/projects/pi-better-show/docs/specs/2026-11-07-better-show/spec.md` (D10 to D14, Hosts, pi-straw-boss GUI). Boss decisions: sb supports the package's blocks in documents and chat, restyles them to its own look, and the package follows light and dark (the light palette comes with the theme mechanism, not here).

## What the page does

- **Where a block can appear.** In an agent's message in the comms log (every base: Standard, Geek, Zen's companion log and history, a phone, a box's unit shown through operate: they all mount `gui/chat.ts`), and in a Markdown document card (`.md`, `.markdown`). An `html` document keeps its sandboxed frame; a plain text document stays text.
- **Prose and blocks.** The text is split by the package's `parse`; prose is sb's own `markdown.ts`; each block is the element of its kind fed with the block's data (`gui/blocks.ts`); a block that does not parse shows its source in code, with the reason as its tooltip. The hand-made alert callout of todo #128 is gone: an alert is `pbs-callout`. Where no block is drawn (an ally run's report) a `> [!NOTE]` quote is a plain quote.
- **Lazy.** `gui/mdbody.ts` draws every message and document as Markdown first, and only when its text holds a block (a hint: a fence of a block kind or an alert) imports `gui/blockschunk.ts` (the package's parser with `yaml`, the thirteen elements, `blocks.ts`, and `pbs.css`). The eager bundle holds none of it (`tests/imports.test.ts` asserts it).
- **Density.** `compact` in the comms log, `comfortable` in a document.

## Answers

An element's `pbs-answer` is cancelled by the page (the host takes it); the element stays open while the answer is on its way, a failed delivery shows its reason under the block and leaves it open, and only a delivered answer locks the element (`answered`) and is stored.

- **Chat block** → the boss's message to that unit: `encodeAnswer(answer)` (a chip's text as it is) through the composer's input route, `POST api/sessions/<key>/input {text, as: "send", guarded: true}`. `guarded` puts it under the guards of a paired device's write (no local-only `/boss` command), because the text comes from an agent. A text that begins with `!` or `/` is never sent (the page says so): a chip's label says nothing of a shell line or a command. For a tower the same route is the boss event; a box's unit (Link operate) goes through the bridge like any composer send, with the operate guards of the box.
- **Document block** → `POST api/doc/<capability>/answer {answerId, fields}` (`src/docs.ts` `answer`, routed by `control.ts` scope `doc`). The owner gets the v1 form message an HTML document's pi-answer form sends, once per answer id (the outcome of an id is kept 30 minutes and replayed). A form's fields go as they are, a review and page feedback under `pi-kind`, and a pick, chip, or checklist (no v1 kind) as a form whose first field `block` names it. Contract v2 (`better-show:answer` with an `Answer`) is a later task; this route is the one place to change then. An operate session never reaches it (decision 12: `doc/**` is refused in `operateroutes.ts`).
- **Lock key.** Chat: session key, entry id, block index. Document: `doc`, capability, revision, block index. Stored in `localStorage` (`sb-answered`, 300 answers, oldest dropped first; a browser that refuses it keeps them for the page). An edited document (new revision) opens its blocks again.

## Security

- No `pageUrl` hook: a review `page` item shows its one-line pointer. `imageUrl` resolves only through the host: in a document, a relative image path (no `..`, no `.`, a raster or svg extension) becomes the document's own capability route (`doc/<cap>/<path>`), which `docs.ts` serves for a Markdown document as images only, from the document's folder, under the same CSP `sandbox` as every `/doc/` response; in chat there is no image route, so none shows. The package's default (any http(s) or data image) is replaced.
- **Diagrams.** `diagramUrl` is not set: `pi-better-show/server` needs `beautiful-mermaid`, a new runtime dependency of the server bundle, and the manifest test allows `tsx` only. A Mermaid block shows its source with the package's note.
- Nothing from a block becomes HTML: elements build text nodes; the block code has no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, or `DOMParser` (a test greps for them and a mutation check writes through them). CSP is unchanged (`style-src 'self' 'unsafe-inline'`, the elements use constructed stylesheets).

## Look

`gui/pbs.css` is the only place the page's tokens meet `--pbs-*`, on `.pbs-block` (the wrapper), not `:root`: Geek and Zen set the page's tokens below `:root`, and a custom property that names another is resolved where it is declared, so the block reads the palette of the view it is in. Dark only (no `light-dark()` needed yet: the package's own defaults are overridden). On a touch screen or a phone's width every control of every element is 44 px tall (`::part()` rules in the same file). Geek's font size is 13 px. Zen needs no mapping of its own (its tokens already restyle the page).

## Build notes

pi-better-show ships TypeScript. Vite bundles it; the root `tsc` never imports the GUI's block files except through tests, which load `tests/pbs-loader.ts` (strips the package's types, which Node refuses under `node_modules`, and gives `*.css` an empty module). `package.json` names the tarball by absolute path; the merge swaps it for an exact npm pin of 0.1.0.
