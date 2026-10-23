# DGS Auto Editor — Approved Audio-Led Auto Align Benchmark

**Approved:** 2026-10-23. **Project:** Chapter 4.2 — The Giant Radish. **ID:** `74e339ef1759`.

## Behavior to preserve

**Script scene -> actual voiceover timing -> assigned image/video cut -> SRT.**

The editor must use the real VO recording, map the spoken words to the corresponding script scene, then set scene image/video start and end. Do not advance cards according to estimated line length. Keep original asset assignments. Videos must play at 1x speed: trim excess footage or hold the last frame. Avoid independently recalculating the server cuts in the browser.

## Reference acceptance metrics

| Check | Approved result |
| --- | --- |
| Scenes | 120 |
| Video clips | 47 |
| SRT cues | 153 |
| Total VO / timeline | 546.669 seconds |
| VO recognizer | Offline Vosk English-India, `vosk-model-small-en-in-0.4` |
| Recognized words | 1,128, across VO 1 and VO 2 |
| Engine / word source | `audio_word` / `vosk_offline` |
| Scene starts corrected from earlier estimate | 119 |
| Maximum scene start correction | 5.85 seconds |
| Overlapping cuts | 0 |
| Speed-accelerated videos | 0 |
| Reassigned scene media | 0 (all 120 original assignments retained) |

Reference picture intervals: scene 4 7.030–10.150s; scene 5 10.150–17.500s; scene 6 17.500–20.860s; scene 43 198.190–204.190s; scene 44 204.190–208.190s; scene 58 277.545–285.134s; scene 59 285.134–287.338s.

## Caveats

Word recognition can mishear proper names, spelling, accents, pauses and dialogue. A fully rendered MP4 has not been manually watched and accepted end to end. Structural tests are not independent proof of perfect storytelling sync.

Poems use a separate audio track. The 40.64-second **Our Smart Village** sung-poem regression recognized audio but could not credibly match all lyric cards. The benchmark rejects that mismatch (HTTP 422) instead of silently distributing poem cards by time or falsely claiming word-locked sync. This known limitation must remain visible pending improved sung-lyric alignment.

Do not reintroduce browser Whisper's 96-chunk listening process as a requirement for the approved baseline. The offline audio-led recognition engine is separate.

## Immutable recovery copies

- **GitHub:** branch `benchmark/audio-led-auto-align-2026-10-23`, created from release commit `83a5a41d9633cb1576a21f2214e439ffb878520e`. It is a frozen code checkpoint, not the branch for future experimentation.
- **Hostinger:** `/home/u188101251/backups/DGS_Editor_BENCHMARK_2026-10-23_Audio-Led_Approved/` with corresponding `.tar.gz` in the parent directory.
- **Kohins-Notebook D:** `D:\Softwares\DGS Auto Editor\Benchmarks\2026-10-23_Audio-Led_Approved\`.

The Hostinger and D: snapshots contain the **exact deployed server/frontend and worker files**, the 120-scene golden timeline/script/media metadata/SRT, both VO MP3 recordings, Vosk model, and a failed-poem regression fixture. The D: copy additionally contains the full original chapter media from the user's Downloads: 120 images, 48 video sources, source VO folder and workbook. Project metadata may contain absolute Linux paths and require relinking for portable restore.

## Future regression gate

Preserve the gold reference unchanged. Make new changes in a separate working branch. Before accepting changes, re-check real spoken timing against the script and images, both VO track boundaries, SRT cue timing/order, no accelerated videos, no overlapping or missing clips, and the fail-safe for uncertain poem lyrics. A rendered MP4 needs a listening/watching QA pass before being called final.