# Sound effects and background sound (todo #139)

Boss, 2026-11-09: separate background sound from sound effects in Settings. Until 0.68.0 one Sound switch and one Volume governed everything the page played. Now there are two settings, each with its own on/off switch and volume: **Sound effects** (音效) and **Background sound** (背景音).

## Classification

Every sound the page can make, and the class it plays in. A class is a gain in the page's one audio core (`gui/audio.ts`); a source asks the core for its class by name (`out("effects")`, `out("background")`), so no sound reaches the output without one. `tests/sound-split.test.ts` keeps this table: its first test fails when a file asks for a class it is not listed in, makes an audio context besides the core, or makes sound and is not listed.

| Source | File | Class | Why |
|---|---|---|---|
| The question, finish, and failure clips of Standard and Geek (waiting, done, error), and the unit-ready chime | `notify.ts` through `audio.play` | effects | cues of events |
| A theme's own clips for those cues (Raven's bell, caw, door) | `themes/raven/index.ts`, `themesounds.ts` through `audio.play` | effects | the same cues |
| The settings page's Try, and the clip that says Sound effects was turned on | `notify.ts` | effects | a sample of a cue |
| Zen's bowl, knock, and low bowl, and Zen's Try buttons and volume sample | `zensound.ts` | effects | cues of events |
| Zen's music (the tracks of the music folder, cross-faded) | `zenmusic.ts`, `audiobus.ts` | background | plays under the page |
| Zen's duck node (the way the music reaches the core, which an effect ducks by 6 dB) | `zensound.ts` | background | it carries the music |
| Raven's rain loop | `themes/raven/weather.ts` | background | ambience |
| Raven's thunder (1 to 2 s after each flash) | `themes/raven/weather.ts` | background | it belongs to the weather (boss) |

Not sound: system notifications (Remind) are not touched, and a tab's `<video>` (`link.ts`) is a camera preview, silent.

## Behavior

- **Two settings** under *This device*, in this order: Remind; Sound effects (switch, volume, Try); Background sound (switch, volume). Both off by default, volume 60 by default, volume 0 to 100 reaching the core as the square, for its class only. Each switch and slider is a labelled control of the existing rows, so the phone's 44 px rules apply (`.set-row`, `.pair-btn`, the range).
- **Each switch silences its class only.** Effects off: no cue plays (batch, chime, Zen's bowl and knock), the rain, thunder, and music go on. Background off: no rain, thunder, or music; the cues go on. The check is each source's own (`notify.ts`, `zensound.ts`, `weather.ts`, `zenmusicbar.ts`), as before for the one switch; the Try buttons and the volume samples ignore the Effects switch, as before.
- **Each volume scales its class only.** `audio.volume(class, v)` sets that class's gain to `(v / 100) ** 2`; the other is untouched. Zen's music bus keeps its half level under the Background gain.
- **Background has no Try.** What it plays (a Zen track, the rain) is already audible while you move the slider. The slider's release and the palette's volume steps play a sample for Effects only.
- **The Zen ♪.** It stays Zen's own pick (`sb.zen.music`): whether Zen plays its music at all. The music sounds only while Background is on. With Background off and ♪ on the music is not started or fetched, a playing track stops at once, and the ♪ says *Music: on, but background sound is off* (`data-state="muted"`, dimmed like off). Background turned on starts it again (the press that turned it on is the gesture; another tab's change may be refused by the browser and then waits for a tap, as a stored-on switch does). A user who had Sound off and ♪ on before this change hears no music until Background is turned on; that follows from the migration the boss set (old off → both off).
- **Views.** Standard, Geek, Zen, and Raven Keep all show the two settings page rows (the settings page is one markup, the themes restyle it). Zen's corner menu has a switch and a volume for each class (its Try plays the effects), and its palette has a switch and two volume steps for each (`effects`, `effects-louder`, `effects-quieter`, `background`, `background-louder`, `background-quieter`). The menu scrolls (`max-height`) so its longer list fits a short phone. Raven's weather reads the Background switch (and the `#background` button's state for its unlock).
- **Words** (`gui/messages`, en and zh-TW): `sound_effects` (Sound effects / 音效), `sound_background` (Background sound / 背景音), their titles, the four palette steps, and `zen_music_muted`. The single `sound`, `sound_title`, `pal_louder`, and `pal_quieter` are gone.

## Storage and migration

`sb.effects`, `sb.effects.volume`, `sb.background`, `sb.background.volume` (`gui/prefs.ts`). The old `sb.sound` and `sb.volume` are the **legacy** of all four: a read finds the class's own key first and, when it has none (`null`; a refused storage stays the default), reads the legacy key. So the old on is both on at the old volume, the old off is both off (the old volume is kept for when they are turned on), and a device that never stored anything is both off at 60. The legacy keys are never written, so a rolled-back or older page on the same browser still reads its own; after the first change of a class that class has its own value and the other keeps inheriting until it is changed. Another tab's write of the old keys is not heard.

## Tests

`tests/sound-split.test.ts` (classification, the core's two gains and each volume scaling its class only, the migration in five cases, the settings page rows, the words, Zen's CSS), and the changes in `notify.test.ts` (each switch and volume per class, migration on the page, the cues are effects), `zen-sound.test.ts` (effects gain and the duck node on the background gain), `zen-music.test.ts` (Background gates the music: start, stop, armed gesture), `raven-weather*.test.ts` (rain and thunder in the background class, no effects pref read), `zen-extras.test.ts` and `palette.test.ts` (rows and entries per class), `prefs.test.ts`, `audio.test.ts`, `audiobus.test.ts`, `settings-page.test.ts`. Mutation-checked: a volume that moves both gains, the chime on the wrong switch, no legacy fallback, the duck node or music bus on the effects gain, the music ignoring Background (at start and at an armed gesture), the music not stopping, the weather on the effects gain or reading the effects pref, a cue played for either switch, the palette's Background steps moving the effects each fail a test.

## Notes from the task

- Byte budgets in `tests/imports.test.ts` (the entry, the Zen chunk, the Raven theme folder) were not re-measured: the task ran without `npm run gui:build`. The line budget was (page 8651 to 8690, `zenmusicbar.ts` 190, `prefs.ts` 45). Re-measure the byte caps after the next fresh build.
- Not done: no browser check of the settings page or the Zen menu, no listening check.
