# Raven Keep view and per-view themes: design

Spec: [spec.md](spec.md) (approved; §6 is binding). Decisions: [decision.md](decision.md).

## Approach

Two batches on separate branches, each landing alone.

**Batch 1, `feat/theme-mechanism` (no visible change).** Make a view a pluggable, lazily loaded unit, following the precedent Zen already sets (`import("./zenchunk.ts")`, `gui/main.ts:90`):

- `src/views.ts`: the one list of view names. It holds no theme code. The server and the page both import it.
- `gui/themes/registry.ts`: maps a view to `import("./<view>/index.ts")`. It is the only path into theme code.
- `gui/themes/<view>/index.ts`: imports the view's CSS and exports `{ sprite?, nouns?, icon, badge?, sounds? }`. Geek's block moves here from `gui/style.css`, and `zenchunk.ts` moves into `themes/zen/`.
- A Vite plugin with two jobs: rollup output rules route each theme's files into `dist/gui/themes/<view>/`, and it writes `themes.json` together with `<meta name="sb-themes">`. The same plugin emits a hashed `boot.js`.
- `boot.js`: hand-written classic JS that sets the view, the favicon and the theme stylesheet before the first frame. A parity test checks it against `view.ts`.
- Server (`src/gui.ts`):
  - It reads everything into memory at start except `themes/**`, which it keeps as a set of names.
  - A theme file is read from disk on its first request and cached.
  - It writes the default view's `<link>`s into the page.
- Two chokepoints, `iconRef(role)` and `noun(key)`, which fall back to Standard. The ten or so call sites that hard-code ids or messages switch to them.
- `tabicon`: re-reads the plain icon on each view change.

**Batch 2, `feat/raven-view`.** Add `raven` to `src/views.ts` and add `gui/themes/raven/`:

- CSS (palette and motion);
- an SVG sprite of 10 hand-drawn icons;
- the noun pack, in en and zh-TW;
- the favicon;
- up to 3 WebP illustrations made with Codex;
- a sounds module: Web Audio wing beats, the organ chord, and the chosen 「嗯？」 clip at 20 KB or less.

The batch also adds the Zen ensō and Geek `>_` favicons, the `view_raven` messages, and a raven contrast test.

## Interfaces and data flow

```text
page load ─ server writes <base>, sb-view, default theme <link>s ─ boot.js (stored choice) ─ main.ts
main.ts ─ view change ─ registry.load(view) ─ theme module: CSS applied, sprite injected (#<view>-<role>), nouns set, icon set
render ─ iconRef(role) / noun(key) ─ theme part if loaded, else Standard
server ─ GET themes/<view>/<file> ─ name in start-up set ? read once and cache : 404
```

## Precedent

- Zen chunk: `gui/main.ts:90`, `gui/zenchunk.ts`.
- Pages built per request: `src/gui.ts` `pageOf`.
- Reload on build change: `src/gui.ts:82`.
- Contrast test computed from the stylesheet: `tests/geek-contrast.test.ts`.

## Trade-offs and rejected alternatives

| Choice | Rejected alternative | Why |
|---|---|---|
| Lazy server read of `themes/**` | Keep reading the whole bundle at start | Illustrations would sit in every server's memory. |
| `document.write` from a sync boot script | Hide the page until a JS-loaded sheet arrives | Hiding delays every load; a parser-inserted sheet blocks render only on a themed device. |
| Id-prefixed theme sprite via `iconRef` | Duplicate ids that override Standard's | `<use>` resolves the first id in document order, so a later duplicate never wins. |
| `noun()` chokepoint over paraglide | A second paraglide project per theme | It doubles the compile step and message files for about 12 keys. |
| A sentence pack over the same messages (`say`, `gui/sentences.ts`) | A third locale per theme in paraglide, or one `Proxy` over the whole message namespace | A locale puts the theme's strings in the entry and falls back to English; a namespace-wide wrapper keeps every message in the entry (no tree shaking). One module per message, wrapped only where a pack names it, costs the entry about 1.8 KB. |
| Two batches | One branch for both | The refactor must be proven invisible before raven changes visuals; review stays readable. |

Risks:
- The boot parity test only covers the inputs a fresh load can have.
- `document.write` is a legacy API. It is allowed under `script-src 'self'` and runs only for a parser-blocking same-origin script.

## Anchor method

- Batch 1: `npm run check && npm test`, plus new tests, each seen red first:
  - the boot parity test;
  - the static dist reachability test;
  - the server lazy-read test.
- Batch 1 also needs `npm run gui:demo`, and a fresh reviewer with P0 and P1 at zero, because it changes the shared page and server contract.
- Batch 2: the same suite, the raven contrast test, and the no-trademark grep. Then the boss's human checkpoint on demo-build screenshots and the sounds.
