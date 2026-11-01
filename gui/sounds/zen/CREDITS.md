# Zen view music credits

`bowls`, `rain` and `night` are instrumental background tracks made with [Suno](https://suno.com) by Wei Hung (model v6, generated 2026-11-01 on the Suno **Pro** plan).

| File | Take (Suno clip id) | Prompt (Styles) |
| --- | --- | --- |
| `bowls.ogg`, `bowls.m4a` | `42366ddb-a750-4ad8-920c-667dfe74a094` | meditation ambient, Tibetan singing bowls, low warm drone, very slow, sparse, long sustained resonant tones, soft reverb, calm, spacious, no percussion, instrumental, gentle fade out ending |
| `rain.ogg`, `rain.m4a` | `0d3ff893-a001-4e5e-b8ce-7cf4992a35ad` | calm focus music, soft felt piano and koto-like plucks, gentle rain texture, slow tempo, sparse notes, warm, soft reverb, no drums, instrumental, gentle fade out ending |
| `night.ogg`, `night.m4a` | `46b168fb-9730-41ba-80b2-0ed92e2fde8a` | ambient night music, warm low pads, very sparse, slow evolving, deep soft drone, calm and dark, minimal, no drums, no melody, instrumental, gentle fade out ending |

Every take used empty lyrics (instrumental), a 3:00 duration, and the excluded styles `vocals, singing, humming, choir, voice, drums, percussion, beat, crescendo, cinematic, swell`. Each take was generated several times (four clips per track); the one listed here was picked by loudness and spectrum inspection. The clips stay private in the Suno account and were never published.

## Licence

The tracks were made on a paid Suno Pro subscription and obtained through Suno's own Download function (the account's download allotment was used for each take).

Suno Terms of Service (<https://suno.com/terms>, effective 2026-09-03, read 2026-11-01):

- **Pro and Premier Accounts**: "if you are a user who has subscribed to the Pro or Premier paid tier of the Service, Suno hereby assigns to you all of its right, title and interest in and to any Output owned by Suno and generated from Submissions made by you through the Service". Suno makes no representation that any copyright will vest in an Output.
- **Permitted Commercial Use**: "You may commercially exploit Output solely to the extent it adheres to Suno's Conditions of Access and Use ... provided you have obtained a permitted download of that Output". These rights are perpetual and survive the end of the subscription.

The rights in these files belong to Wei Hung and are shared with this package under its MIT licence. Anyone redistributing the files should keep this notice. Suno's provenance metadata (the `comment` tag, "made with suno; id=...") is kept in the encoded files and must not be removed.

## Processing

The Suno downloads (WAV, 48 kHz stereo, kept outside the repository) were gain-adjusted to -23 LUFS integrated (EBU R128), given a 0.5 s fade in and a 0.5 s fade out, and encoded with ffmpeg:

- `.ogg`: Opus in Ogg, 64 kbps stereo, 48 kHz. Plays in desktop Chrome, Firefox, Edge and Android Chrome; Safari added Ogg Opus in 18.4 (not verified on a device here).
- `.m4a`: AAC-LC in MP4, 48 kbps stereo, 48 kHz. A fallback for iOS and Safari versions that cannot play Ogg Opus.

Measured on the encoded files: integrated loudness -23.0 to -23.1 LUFS, true peak -10.0 to -11.8 dBTP.
