# DGS Auto Editor — V168 release gates and local/live asset consistency

**State (2 November 2026): V168a is a read-only diagnostic, not a completed content-matching release. No benchmark approval.**

## The demonstrated fault

The new working Chapter 18 project `763dd8973eac` has 93 scenes, 112 media records and narration/poem metadata. The server actually returns HTTP 404 for **all 112 media files and both audio tracks**. The browser's HTML5 audio elements report media error code 4 and do not advance playback. The project has no corresponding files in its media and voiceover directories.

Two older Chapter 18 server projects, `v155ch18flow261101` and `v160ch18poem261101`, have their physical media and audio. The 112 common filenames and recorded byte sizes match the working project's manifest. However their narration source is an older 377.626-second recording; **never substitute that for** the working project's 399.754-second cleaned voiceover.

The exact 399.754208-second cleaned MP3 was found on the authorized Notebook. SHA-256: `01f880e404cf0b1a3cd038968e518e8b7f4b49b34c9f667cd2a0e4fc5f6cfea8`. An isolated recovery script is staged on the server, with a preflight that verified 112 missing destination assets, source name/byte-size consistency and audio SHA. **Recovery was not executed**. Do not represent the working project as restored.

## Why V167b and V167c both gave misleading signals

- V167b treated every `local_only` metadata flag as missing and put opaque RELINK overlays on all correctly assigned timeline media.
- V167c stopped those false overlays but incorrectly treated a media ID as proof that the referenced physical file was playable.
- Neither version completed a semantic OCR/VLM-to-VO match. They tested UI hooks and missing placeholders, not the actual content of each card.
- The former green release checks verified HTML rendering and UI behaviour, not audio bytes, decode, visual content and export. This was insufficient.

## Mandatory architecture work to eliminate local/server divergence

1. **Canonical binary store.** Asset IDs must resolve to immutable content-addressed server blobs by SHA-256. Local FileSystemAccess handles/cache are a separate device-local state, never conflated with hosted availability. A project copy must copy-on-write reference a valid server blob, or perform verified binary transfer before marking the project synced.
2. **Atomic upload transaction.** For each imported image, video, narration VO and poem VO: upload bytes with retry/resume; stream/compute SHA-256 and byte length; verify server storage and MIME/decode; only then commit `media.json` and `voiceover.json` with `server_verified=true`. Upload failures must leave a visible recoverable placeholder, never a fake healthy reference. Do not modify timing windows during restoration.
3. **Load-time and Auto-align health.** Under the existing single Smart Match popup, probe all current-project media URLs and both audio tracks. Fail on 404, HTML fallbacks with HTTP 200, byte-length mismatch, or browser media error. Distinguish confirmed MISSING from local-only **CLOUD NOT AVAILABLE**. Block benchmark and export when verified bytes are required but absent.
4. **Semantic SmartMatch.** OCR/card-content analysis plus video keyframes and a visual-language model, compared against the actual script/VO meaning (not scene filename alone). Cache evidence by content SHA. Propose confidence-ranked reassignments; never auto-move ambiguous assets. After moving a verified media asset, keep the original narration scene and duration with a clickable missing-slot placeholder. Deliberately silent scenes must not be counted as missing VO.
5. **Project isolation.** All cache, indexes, OCR/vision evidence, asset manifests and review decisions keyed by stable project ID and media SHA. Opening New Session must not retain another chapter's analysis.
6. **Fail-closed benchmark evidence.** Require checks on the *exact live URL and project*: full file HTTP coverage, actual narration and poem playback at beginning/middle/end, correct source windows, sample scene visuals, at least one deliberately swapped-image regression, missing-image/video/VO replacement, export playback, and independent checks for Marathi and English. Status vocabulary must be **PASSED, FAILED, NOT VERIFIED**. No overall green check unless every mandatory test passed.

## V168a implemented scope

An additive, read-only integrity gate in the existing Smart Match popup. It checks every current-project media URL and required narration/poem audio URLs via HEAD, validates expected bytes/MIME, displays failed browser audio status, and explicitly reports semantic OCR/vision matching as NOT RUN. It is versioned separately from V164b/V165b/V167b/V167c and writes no project data.

**Passing this asset gate is necessary, never sufficient, for a content benchmark.**

## Recovery procedure (authorized operator only)

Inspect the recovery preflight report and backups, then restore the 112 **byte-identical** media sources from the verified older server project into the active project without replacing IDs or altering cuts; restore the **exact** 399.754-second VO from the Notebook, and copy the matching poem recording. Verify hashes before updating the local/server availability flags. Afterward, rerun the entire live URL test and compare `timeline.json`, `script.json`, VO workbook and clock fingerprints against the backups. Revert metadata and newly copied files if any verification fails.

The staged recovery path and backup procedure are **not** equivalent to execution. Sound is not fixed until browser playback has passed.