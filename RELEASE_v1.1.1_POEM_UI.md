# DGS Auto Editor — v1.1.1 Poem Mode-only patch

**Released:** 24 October 2026. **Live:** https://editor.dgeniussolutions.com

## Approved baseline preserved
- Previous approved version: **v1.1.0**, Hostinger backup `/home/u188101251/backups/DGS_Editor_Approved_v1.1.0_BeforePoemFix_2026-10-24`
- Verified all **57** files in that backup against SHA256 manifest
- The Giant Radish and Marathi Chapter 14 saved script, VO, timeline files matched their approved backup copies after deployment
- The deployed `server.js` and original `public/assets/index-HGSMnvwf.js` are byte-identical to the baseline
- Visual QA logic unchanged; only its displayed version label now reads v1.1.1

## Poem UI changes (ONLY)
1. The Poem Text Placement Studio docks **beside** the video preview rather than obscuring it; responsive layout stacks it below on narrow screens
2. Poem text is **transparent**, with no sticker/card background, opacity fade, or border
3. The existing drag/resize/lock controls are preserved, with font, size, color, align and position options
4. During poem scenes, displayed lyric text follows **existing time-aligned script/SRT cues** and does not depend on whether normal CC preview is enabled
5. Only script scenes marked as poem are eligible to appear in the poem layer; other narration cues interleaved in old poem timelines are never misrepresented as sung lyric lines
6. No invented example lyric text; outside the poem, the editor may show the real first poem line only while styling

## QA and limitations
- Browser verified against a **separate 49-scene test clone** `9f0e2a7c4b16`, NOT against approved project edits
- Preview and studio showed as nonoverlapping columns: **577 px** frame and **330 px** studio
- Poem text card and typography preview both had **transparent** computed backgrounds
- Live route health HTTP 200, `version.json` v1.1.1, browser Visual QA v1.1.1
- No complete sung-poem export or live rendering playback approval performed; this change does not modify MP4 encoding or Filmora export. A lyric with no credible timed cue is not silently guessed.

## Recovery and reconstruction
- Exact v1.1.1 Hostinger archive: `/home/u188101251/backups/DGS_Editor_v1.1.1_PoemUI_2026-10-24.tar.gz`
- Identical local archive: `D:\Softwares\DGS Auto Editor\Benchmarks\Releases\DGS_Editor_v1.1.1_PoemUI_2026-10-24.tar.gz`
- Original compiled app SHA256: `61f5e190ce3aee7b3c67b59a7444a100a15159260c79965604d20797ba7cc4ef`
- Poem-only compiled app SHA256: `34de05f44427422236ade19a1def03a65be652af1adc14820c70fb52b4e3f78f`
- CSS SHA256: `806b72158b929d68733866418438f5d8f5ee406050dfd1ff9bc9c8b7a89b342a`

The branch includes the **narrow patch scripts and scoped CSS** for reconstruction. The complete bundled compiled output is held in the exact release archives above; do not replace the approved baseline source with this patch branch automatically.

**Do not alter English or Marathi audio-word alignment, existing approval baselines, clip order, SRT, normal playback speed, or unrelated Visual QA behavior.**
