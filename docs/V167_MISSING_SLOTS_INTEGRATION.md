# DGS V167 — Missing image, video and narration placeholders

Status: additive, read-only UI implementation. **Not deployed** to the hosted V165b demo.

## Integrate with the V165b demo without modifying it

For a new, isolated demo clone, include these two files:
- `public/assets/dgs167-missing-slots.css` inside the new demo document's `<head>`.
- `public/assets/dgs167-missing-slots.js` as a deferred script **after** the existing Smart Match popup and replacement-modal scripts.

Do not attach to the original V164b/V165b HTML. Do not change source timing, narration, poem audio, exports, or existing project records.

The addon reads the active project via `DGS140C_GET_SMART_CONTEXT` and the existing read-only `/api/projects/:id/load` endpoint. It detects explicit MISSING IMAGE/VIDEO slots, unassigned media, local-only assets (RELINK rather than MISSING), missing master narration on scripted spoken scenes, and unaligned narration source windows. It preserves intentional silent and poem scenes and always uses the current project ID.

Indicators are:
- image/video timeline: red MISSING IMAGE/VIDEO (amber RELINK for local-only)
- VO lane: MISSING VO, RELINK VO, or VO NOT ALIGNED
- selected/playhead preview: black/red MISSING visual and separate narration warning
- current Smart Match popup: shared issue/replacement UI (master VO issues are grouped to avoid dozens of duplicate rows)

Clicking a marker opens the single existing Smart Match popup. The upload/relink button delegates to the existing replacement UI or the native master VO import; **per-scene VO replacement may still be staged rather than directly spliced**, and that limitation must remain visible.

The script does not write project timelines or attempt silent automatic media moves. The old V164b/V165b builds remain untouched.

## Tests run

- Node classifier fixtures: missing image, video, narration, local-only image and VO, unaligned VO, silence exemptions, duration invariance.
- Headless browser on current hosted V165b page with locally injected addon: Chapter17 shows 7 missing images, 22 relink videos, 16 relink images, 69 VO relink timeline markers; 39 grouped recommendations with one Smart Match dialog; scene 58 preview shows MISSING IMAGE plus RELINK VO; click opens existing popup.
- Chapter18: 20 MISSING IMAGE markers and 0 false VO missing markers.
- Synthetic in-browser Chapter18 clip/audio fixture (not server write): 1 missing video and 79 missing narration slots visible; reverting fake fetch restores the original status.

## Deployment gates

1. Clone demo to new versioned path.
2. Add JS/CSS references and run actual browser QA on cloned URL.
3. Confirm new-session import, scene selection, timeline scrubbing, file relink and original project preservation.
4. Confirm no false missing when media is local-only.
5. Keep replacement upload limited by existing authenticated server policies.
6. Announce the new link only after a successful live server check.
