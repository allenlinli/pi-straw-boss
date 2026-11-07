Status: approved
Approved at: 2026-11-07
Approved from: 「核准，分兩批」 (batch 1: refactor with no visible change; batch 2: Raven Keep); voice clip: 「你去找…如果真沒有，那就用別的音效」

# Raven Keep (鴉閣) view and per-view themes: spec

Decisions: [decision.md](decision.md). Base: `main` f573fe99.

## 1. Observable behaviour

### 1.1 Views

- The view choice gains `raven`: `Choice = auto | standard | geek | zen | raven`, `View = standard | geek | zen | raven`. One list, `src/views.ts` (`VIEWS`, names only, no theme code), is read by `gui/view.ts`, `src/server/guiprefs.ts`, `GuiRecord.view`, `/boss gui view` completions, the settings control, Zen's corner menu, the palette entries, and `gui/fixture.ts`; the four hand lists named in decision.md go.
- Settings shows five buttons (Auto, Standard, Geek, Zen, Raven Keep / 鴉閣); the Auto label reads "Follow server (Raven Keep)" when the server default is raven.
- `/boss gui view raven` sets the server default as the other values do (`gui-prefs.json`, `sb-view` meta, hello, `view` event). An older build reads `raven` as `auto` and leaves the file alone (the Zen precedent, how-it-works View entry).
- Zen's rules are unchanged: a page showing Zen is not switched out by a server default change (Z-D20); Auto with `prefers-contrast: more` still resolves Geek.

### 1.2 Loading (the theme mechanism)

- A **theme** is a view's own assets: stylesheet, icon sprite, role-noun pack (en, zh-TW), favicon SVG, and optionally illustrations and a sound module. Standard is the base the entry carries; Geek, Zen, and Raven Keep are themes.
- The built bundle puts each theme's files under `dist/gui/themes/<view>/` with content-hashed names, and writes `dist/gui/themes.json`: per view, its stylesheet, sprite, favicon, and module files.
- **First frame.** The server writes into every page, after `sb-view`: a `<link rel="stylesheet">` and `<link rel="icon">` for the view the page will most likely show (the server default when it names a theme), and `<meta name="sb-themes">` with the `themes.json` map. A classic synchronous script `boot.js` (served from the bundle; CSP `script-src 'self'` allows it) runs in `<head>` before the body: it reads `sb.view`, resolves the view as `gui/view.ts` does, and when that view is a theme whose stylesheet the server did not already link, it `document.write`s its `<link rel="stylesheet">` (parser-inserted, so it blocks render) and sets the favicon; it sets `data-view` on `<html>`. A device on Standard gets no theme link at all.
- `gui/main.ts` loads the theme's module chunk (sprite, nouns, sounds, motion code) through the theme registry when the view is first shown; switching views at run time loads the new theme's stylesheet and module on first use and keeps the old ones (switching back costs no request).
- Until a theme's sprite arrives, role icons render from Standard's sprite (the entry keeps it); nouns render from the base messages. Neither waits on the network to show the page.
- **Never loaded together**: a page on view V requests no file of any theme other than V. A page on Standard requests no theme file.
- **Server memory.** The server reads the whole bundle, `themes/**` included, into memory at start, as before (a package update under a running server must not strand a page whose assets were deleted: review RV-F001, boss 2026-11-07 「server 改回啟動時全讀」). The server stays light through each theme folder's byte cap (§5.1), not through lazy reads.

### 1.3 Geek moved

- Geek's `[data-view="geek"]` rules leave `gui/style.css` for `gui/themes/geek/geek.css`; Geek renders as today (tests/geek-contrast.test.ts reads the new file and keeps its 7 : 1 and 3 : 1 rules). The entry CSS shrinks by that block.
- Geek's state tags, `[On]`/`[Off]`, inverse selections, and `calm.ts`'s no-timer rule are unchanged.

### 1.4 Favicons

- Each view has a favicon: Standard the current tower, Geek `>_`, Zen an ensō (open ink circle), Raven Keep a raven before a castle in a pointed frame, drawn as original SVG after the crest the boss supplied. The waiting badge draws over the active view's favicon; in Zen it still shows no count.
- The installed-app icon, `apple-touch-icon`, and the manifest do not change.

### 1.5 Raven Keep's look

- Dark only. Palette: near-black ground with a cold violet cast, bone/parchment text, candle gold for attention (waiting), blood crimson for errors, fog grey for idle; every text colour at least 4.5 : 1 on its surface (a test computes it as geek-contrast does).
- Art direction follows the official Curse of Strahd look (Castle Ravenloft's gothic architecture, the von Zarovich crest's ink line work, mist, candlelight) as reference only; nothing official is copied.
- Motion: a slow fog drift on the background and a candle flicker on waiting units; both stop under `prefers-reduced-motion` and under `data-calm`.
- Role icons (one sprite): Count (you), Raven Keep castle (head tower), keyring (tower = steward), spawn in cape (main), wolf (member), bat (subagent), crypt entrance (base, where a base icon is shown), coffin (outpost), ghost (outside unit), raven (comms), tome (document). Drawn as SVG in one hand-drawn gothic line style; the game-icons credit in the page is joined by none (these are original); `gui/ICONS.md` lists them.
- Role nouns (en / zh-TW): head tower → Raven Keep / 鴉閣; tower → Steward / 管事; main → Spawn / 衍裔; member → Wolf / 狼; subagent → Bat / 蝙蝠; base → Crypt / 墓穴; outpost → Coffin chamber / 棺室; outside → Ghost / 遊魂; comms → Ravens / 渡鴉; document → Tome / 典籍; you → the Count / 伯爵. Only the strings that name a role (legend, plates, crumbs, role labels, the dossier's role row) take them; sentences keep the base words. The exact key list is fixed in design.md.
- Illustrations: up to three WebP images (the map's empty state, the head page's backdrop, the settings banner), each at most 120 KB, in `themes/raven/`, made with Codex image generation in the crest's ink-line style; the raven theme's total is at most 450 KB.
- Sounds (behind the Sound switch and Volume as now): wing beats of a bat or raven, synthesized with Web Audio (filtered noise bursts), when a unit starts or finishes work; when a unit asks the boss a question, a low, resonant male voice saying 「嗯？」 (one short clip, the theme's only audio file, at most 20 KB, in `themes/raven/`, fetched on first play); a low organ chord on an error. (Revised 2026-11-07 by the boss: wings, and the voice for questions.)
- Shipped text has no "Strahd", "Barovia", or "Ravenloft" (a test greps the bundle and the messages).

## 2. Edge cases

- Stored `raven` on an older build: Auto (choiceOf), no crash.
- `boot.js` fails or storage is refused: the page shows the server default's theme (linked by the server) or Standard; `main.ts` corrects `data-view` and loads the theme as today, with a possible flash only then.
- A theme file 404 (build changed): the stylesheet stays missing until the reload the hello triggers.
- `forced-colors`: system colours as today; raven's motion off.
- Demo build (`npm run gui:demo`, no server): `boot.js` and the map come from the built `index.html`'s own `themes.json` meta written at build time.

## 3. Non-goals

A raven layer of its own; flavour text beyond role nouns; installed-app icons; the desk shell (straw-boss-desk follow-up); mp3 assets; a light variant.

## 4. Applied standards

AGENTS.md test rules (no wall-clock waits); `tests/imports.test.ts` size and byte budgets (raised only with measured figures, named as gate changes); ui-design.md (uniform borders); the typegate untouched.

## 5. Reality anchor

`npm run check && npm test`, including new assertions:
1. `tests/imports.test.ts`: the entry JS and CSS contain no theme asset (no `data-view="geek"` rule, no raven sprite id); the entry CSS budget drops by the Geek block; each theme folder has its own byte cap (raven ≤ 450 KB).
2. A page-load test over the built bundle (fixture server) per view: the set of requested files contains only that view's theme files.
3. A server test: `startGui` holds no `themes/**` buffer before a request, serves it after, and answers 404 for an unknown one.
4. `tests/geek-contrast.test.ts` on the moved file; a raven contrast test.
5. `tests/view.test.ts` cases for `raven` (choice, auto, server default, Zen hold).
Checkpoint: the demo build's screenshots of raven (map, session, settings, phone) and Zen's and raven's favicons for the boss's visual review.

## 6. Resolutions of the fresh read (2026-11-07)

1. **Build layout.** Each theme has an entry module `gui/themes/<view>/index.ts` that imports its CSS and exports its parts (sprite text, nouns, favicon URL, sounds, badge colours); `main.ts` reaches it only through `import()` in `gui/themes/registry.ts`. Rollup `output.chunkFileNames`/`assetFileNames` put every chunk and asset reached only from `themes/<view>/` into `dist/gui/themes/<view>/` with hashed names. Zen moves in: `zenchunk.ts` becomes `gui/themes/zen/index.ts` (its files unchanged otherwise).
2. **The map.** A Vite plugin (`generateBundle`) writes `themes.json` (per view: `css`, `module`, `icon`) and the same map into `index.html` as `<meta name="sb-themes">`, so the page's `build` hash (`src/gui.ts:82`) changes whenever any theme file changes and the hello reload covers stale maps. The server reads `themes.json` once at start (names only) to write the default's `<link>`s; it does not write `sb-themes`. The demo build gets the same meta from the same plugin.
3. **boot.js.** Hand-written classic JS `gui/boot.js` (no imports), emitted hashed by the same plugin and referenced by a `<script src>` placed in `index.html`'s `<head>` after the charset; the server's `<base>` and metas are inserted at the top of `<head>`, so they precede it. It resolves the view on a fresh load only (`choiceOf`, `autoView` with `prefers-contrast`, `sb-view`; `held` and `zen-away` cannot exist yet), sets `data-view`, `theme-color`, the favicon `href`, and `document.write`s the theme stylesheet link unless the server linked it. Parity: `boot.js` also assigns `globalThis.sbBoot = { resolve }`; `tests/view.test.ts` loads it in a vm context and compares with `view.ts` `resolve` over every choice × contrast × server default.
4. **Favicon link.** boot.js rewrites the one existing `<link rel="icon">` (relative to `<base>`, so the token path is implied). `main.ts` re-reads the plain icon on every view change (`plainOf` per view, cached); the badge's colours come from the theme (Standard's today by default); in Zen no count (as now, `pagecore` badge rule).
5. **Server reads.** (Revised after review RV-F001.) Everything, `themes/**` included, is read at start as before; `TYPES` gains `.webp`; files under `themes/` get the hashed-asset immutable cache headers.
6. **Nouns.** One chokepoint `gui/nouns.ts` `noun(key)`: the active theme's pack for `getLocale()` if it has the key, else `m[key]()`. The pack covers only these existing keys (fixed by grep in design.md): the `role_*` keys `roleName` reads (`render.ts:31`), `head_tower`, `outposts`, `outside_net`, `comms`, and the base word in the legend. Call sites that print those keys switch to `noun`. Sentences that embed a role word stay on the base messages. A locale switch re-renders as today; the pack holds both locales.
7. **Sprite.** The theme's sprite is injected into a hidden `<svg id="theme-sprite">` with ids prefixed by the view (`raven-tower`, …). One function `iconRef(role)` returns `#<view>-<role>` when the theme's sprite is loaded and has it, else Standard's `#i-<role>`; every `<use href="#i-…">` call site (render.ts, chat.ts, deploy.ts, headpage.ts, drawer.ts, layer.ts, link.ts, workspace.ts, static templates) goes through it. Standard's inline sprite and its game-icons credit stay for every view. Raven has no base icon, since Standard draws none: "crypt" is a noun only, so raven draws 10 icons, not 11.
8. **Lists.** `src/views.ts` (runtime import from `gui/`, as `../src/headkey.ts` already is) replaces `gui/view.ts` `Choice`/`View`/`choiceOf`, `gui/viewlabel.ts:6`, `gui/paletteentries.ts:30`, `gui/zenmenu.ts:33`, `gui/fixture.ts:87`, `src/server/guiprefs.ts:9`, the `guihost.ts` error text, `boss.ts` completions, and `GuiRecord.view`. New messages `view_raven` (en "Raven Keep", zh-TW "鴉閣"). Raven `theme-color` `#0d0a10`.
9. **Rules confirmed.** Auto with `prefers-contrast: more` resolves Geek; an explicit Raven stays Raven. Zen's hold (Z-D20) applies to any default that moves away from Zen, raven included.
10. **Anchor 2 without a browser.** A static test over `dist/gui`: the files `index.html` names and the entry's static import closure contain no `themes/` file; each `themes/<view>/` file is reachable only from that view's module. Tests that read Geek rules from `gui/style.css` (geek-contrast, gui-css, calm, and others found by grep) are repointed to `gui/themes/geek/geek.css`, listed in the change's report. Budget figures raised are named with measured values in the report.
