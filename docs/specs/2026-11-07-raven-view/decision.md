# Raven Keep (鴉閣) view: decisions

Outcome: a fourth GUI view, Raven Keep (`raven`), a gothic skin of Standard in the tone of D&D's Ravenloft (the boss is the Count; stewards and bats work between the castle and the crypts), and a theme mechanism under which a page downloads only the assets of the view it shows and the sb server holds a theme's files in memory only after one is requested.

Actors: the boss (any device), the sb server, the GUI build.

## Scope

- In: the theme mechanism (per-view chunk of CSS, icon sprite, role-noun pack, favicon, illustrations, synthesized sounds); Geek moved out of the entry CSS into its chunk; the raven view (palette, light motion under the calm rules, icons, role nouns in en and zh-TW, favicon, illustrations, sounds); a favicon per view (Zen gets an ensō); `/boss gui view raven`; the server reading theme folders on demand.
- Out: a Zen-like layer of its own for raven; flavour text beyond role nouns; the installed-app icon and the manifest (later decision); the desk shell's window colour and icon (straw-boss-desk follow-up); mp3 assets.

## Scenarios

1. A device on Standard loads the page: no request names a geek, zen, or raven asset.
2. A device that chose Raven Keep loads the page: its first frame is in raven's palette with raven's favicon; the raven chunk is requested once.
3. The boss runs `/boss gui view raven`: following devices switch at once; a page showing Zen stays (Z-D20).
4. A server whose devices never show raven never reads `dist/gui/themes/raven/` into memory.

## Decisions

| Question | Answer | Basis | Status |
|---|---|---|---|
| Server memory after RV-F001 | Read the whole bundle at start, themes included; per-theme byte caps keep it small (Geek 6 KB, Zen 124 KB, Raven ≤ 450 KB) | review RV-F001; boss 2026-11-07 「server 改回啟動時全讀」 | confirmed |
| Can a view load alone? | Yes: Zen already does (`gui/main.ts:90`); Geek is in the entry CSS (`gui/style.css`), the icons inline in `gui/index.html:21-30` | source | grounded |
| Does front-end splitting keep the server light? | No: the server reads all of `dist/gui` into memory at start (`src/gui.ts:77`); theme folders must be read on first request | source | grounded |
| Depth of the raven view | A skin of Standard: palette, icons, role nouns, light motion; same layout and interaction | boss, 2026-11-07 「全部照你的建議」 | confirmed |
| Role mapping | Count = you; Raven Keep (castle) = head tower; crypt = base; coffin chamber = outpost; steward (keyring) = tower; spawn = main; wolf = member; bat = subagent; wandering ghost = outside unit; raven = comms; tome = document | boss, same answer | confirmed |
| Word depth | Role nouns only (about 30 strings, en and zh-TW), in the theme's chunk | boss | confirmed |
| Word depth, sentences | zh-TW sentences too: every message that said 塔台 says 管家 (the tower, `role_tower`) or 鴉閣 (the head tower), and a base with no tower says 自主活動; the theme carries a sentence pack in its chunk; English unchanged | boss, 2026-11-08 「塔台就不要叫塔台了？他是一個鑰匙，可以像是管家」「連句子一起改」「尚無管家 => 自主活動」 | confirmed |
| Lazy scope | A theme mechanism for every view; Geek moves out of the entry; Standard is the base | boss | confirmed |
| Favicon | One per view, set before the first frame; Zen an ensō, raven from the crest's raven-and-castle composition, Geek `>_`, Standard the tower; badge drawn over it as now | boss | confirmed |
| Installed-app icon | Unchanged for now | boss | confirmed |
| Sounds | Web Audio synthesis (bell toll waiting, glass chime done, low organ chord error); no files | boss | confirmed |
| Names | Original words only: 鴉閣 / Raven Keep, 伯爵 / the Count; no Strahd, Barovia, Ravenloft in shipped text; id `raven` | boss | confirmed |
| Art | Icons and favicons drawn as SVG by the agent, with the von Zarovich crest the boss supplied as style reference only (not copied); illustrations by Codex image generation, WebP, in the theme folder | boss, 2026-11-07 messages | confirmed |

Core-rule readiness: typegate and server routes untouched; the CSP (`script-src 'self'`) allows the external sync boot script; build-mismatch reload (`src/gui.ts:78`) covers a theme asset requested across a package update.
