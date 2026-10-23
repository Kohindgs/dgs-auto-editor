# Marathi Audio-Led Auto Align — 23 October 2026

Marathi Chapter 14 (`1d9165e70315`) was tested **on a separate copy**, `marathi-audio-regression-20261023`. The live deployment now routes Marathi VO through offline AI4Bharat IndicConformer INT8 CTC recognition (community ONNX export), rather than the English recognizer or estimated Devanagari durations.

## Verified integration test
- 86 / 86 Marathi script scenes matched to **1,038** recognized words across VO 1 (281.52s) and VO 2 (338.80s), with 0.5s track gap.
- HTTP 200; `language: mr`, `align_engine: audio_word`, `words_source: indicconformer_mr`.
- 126 Marathi SRT cues; 86 media assignments unchanged; 85 scene starts retimed; **0 overlapping clips and 0 accelerated videos**; timeline 620.82 seconds.
- English regression still passes: 120 scenes, 153 SRT cues, 0 overlaps, 0 accelerated videos.
- The current manually edited Chapter 14 project `64b4157cbf7b` was **not overwritten**. It contains an unrelated Garden Walk poem track; review that attachment before editing.

## Deployment requirements
- `marathi-align-worker.py`, `audio-align-routes.js`, `server.js`, browser bundle.
- Python 3.9, matching sherpa-onnx/sherpa-onnx-core **1.12.39**, NumPy 1.26.4, FFmpeg.
- ONNX INT8 model (~189 MB) in `~/dgs_audio_align/models/indicconformer-mr/` with `tokens.txt` (not included in GitHub). Runtime library location: `~/dgs_audio_align/mr_python_legacy/sherpa_onnx/lib`.
- Language-isolated audio recognition caches; Devanagari marks preserved in matching; no silent estimate fallback when real audio lock is requested.

## Still required
The full rendered Marathi video has not been visually/audio approved. Recognition may mishear names, repeated dialogue or poems. Separate sung poem matching still requires explicit review; do not report `SYNC OK` when word-lock failed. The approved English baseline branch `benchmark/audio-led-auto-align-2026-10-23` remains unchanged.
