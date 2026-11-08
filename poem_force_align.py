#!/usr/bin/env python3
"""Place a known lyric on a poem recording.

Demucs lifts the vocal out of the music. Meta MMS then force-aligns the
script line onto that vocal, so each Devanagari word keeps the time it was
sung. This does not guess the words. A failed run prints ERROR and exits 2.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEVANAGARI = re.compile(r"[\u0900-\u097F]+")
CACHE = Path(os.environ.get("DGS_POEM_ALIGN_CACHE", r"D:\AI Editor\dgs_data\cache\poem_vocals"))


def progress(msg: str) -> None:
    print("PROGRESS " + msg, flush=True)


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg"):
        return
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    found = next(root.glob("Gyan.FFmpeg*/ffmpeg-*-full_build/bin/ffmpeg.exe"), None) if root.is_dir() else None
    if found:
        os.environ["PATH"] = str(found.parent) + os.pathsep + os.environ.get("PATH", "")


def fail(msg: str) -> None:
    print("ERROR " + msg, flush=True)
    raise SystemExit(2)


def lyric_words(text: str) -> list[str]:
    return DEVANAGARI.findall(text)


def vocal_stem(audio: Path) -> Path:
    digest = hashlib.sha1()
    st = audio.stat()
    digest.update(str(audio.resolve()).encode("utf-8", errors="replace"))
    digest.update(str(st.st_size).encode())
    digest.update(str(int(st.st_mtime)).encode())
    dest_dir = CACHE / digest.hexdigest()[:16]
    dest = dest_dir / "vocals.wav"
    if dest.is_file() and dest.stat().st_size > 1000:
        progress("Using the saved vocal stem")
        return dest
    dest_dir.mkdir(parents=True, exist_ok=True)
    work = dest_dir / "work"
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    src = work / "poem.mp3"
    shutil.copyfile(audio, src)
    progress("Lifting the vocal out of the poem")
    cmd = [
        sys.executable, "-m", "demucs.separate",
        "-n", "htdemucs",
        "--two-stems", "vocals",
        "-d", "cpu",
        "--shifts", "1",
        "-o", str(work / "out"),
        str(src),
    ]
    run = subprocess.run(cmd, capture_output=True)
    if run.returncode != 0:
        err = (run.stderr or b"").decode("utf-8", errors="replace")[-500:]
        fail("Could not lift the vocal out of the poem. " + " ".join(err.split()))
    found = list((work / "out").rglob("vocals.wav"))
    if not found:
        fail("Vocal stem was not written")
    shutil.copyfile(found[0], dest)
    shutil.rmtree(work, ignore_errors=True)
    return dest


def _as_words(raw) -> list[dict]:
    rows = []
    if isinstance(raw, dict):
        raw = raw.get("words") or raw.get("segments") or []
    for item in raw or []:
        if isinstance(item, dict):
            text = str(item.get("text") or item.get("word") or "").strip()
            start = item.get("start")
            end = item.get("end")
            score = item.get("score")
        elif isinstance(item, (list, tuple)) and len(item) >= 3:
            text, start, end = item[0], item[1], item[2]
            score = item[3] if len(item) > 3 else None
            text = str(text).strip()
        else:
            continue
        try:
            start_f = float(start)
            end_f = float(end)
        except (TypeError, ValueError):
            continue
        if not text or end_f <= start_f:
            continue
        row = {"text": text, "start": start_f, "end": end_f}
        if score is not None:
            try:
                row["score"] = float(score)
            except (TypeError, ValueError):
                pass
        rows.append(row)
    return rows


def align_vocal(vocal: Path, words: list[str]) -> list[dict]:
    import torch
    from ctc_forced_aligner import (
        generate_emissions,
        get_alignments,
        get_spans,
        load_alignment_model,
        load_audio,
        postprocess_results,
        preprocess_text,
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    progress(f"Placing the lyric on the vocal ({device})")
    model, tokenizer = load_alignment_model(device, dtype=dtype)
    wave = load_audio(str(vocal), model.dtype, model.device)
    duration = float(wave.shape[0]) / 16000.0
    emissions, stride = generate_emissions(model, wave, batch_size=4)
    tokens_starred, text_starred = preprocess_text(
        " ".join(words),
        romanize=True,
        language="mar",
    )
    # A star before every word lets the music between lines stay unsung.
    # One more star after the last word keeps the outro off that word.
    if not tokens_starred or tokens_starred[-1] != "<star>":
        tokens_starred = list(tokens_starred) + ["<star>"]
        text_starred = list(text_starred) + ["<star>"]
    segments, scores, blank = get_alignments(emissions, tokens_starred, tokenizer)
    spans = get_spans(tokens_starred, segments, blank)
    timed = _as_words(postprocess_results(text_starred, spans, stride, scores))
    del model
    if len(timed) != len(words):
        fail(
            f"The lyric has {len(words)} words and the aligner returned {len(timed)}. "
            "The poem was not cut."
        )
    out = []
    prev = 0.0
    for src, row in zip(words, timed):
        start = max(prev, min(duration - 0.08, float(row["start"])))
        end = max(start + 0.04, min(duration, float(row["end"])))
        item = {"word": src, "text": src, "start": round(start, 3), "end": round(end, 3)}
        if "score" in row:
            item["score"] = round(float(row["score"]), 3)
        out.append(item)
        prev = end
    span = out[-1]["end"] - out[0]["start"]
    if span < 8:
        fail("The lyric collapsed into a few seconds. The poem was not cut.")
    durs = [w["end"] - w["start"] for w in out]
    if max(durs) - min(durs) < 0.05 and len(out) > 8:
        fail("Every word was given the same length. The poem was not cut.")
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--no-demucs", action="store_true")
    args = parser.parse_args()
    ensure_ffmpeg()
    audio = Path(args.audio)
    if not audio.is_file():
        fail("Poem audio is not on this PC")
    words = lyric_words(Path(args.text).read_text(encoding="utf-8"))
    if len(words) < 6:
        fail("The poem lyric is too short to place")
    vocal = audio if args.no_demucs else vocal_stem(audio)
    placed = align_vocal(vocal, words)
    payload = {
        "words": placed,
        "words_source": "mms_fa",
        "vocal": str(vocal),
        "word_count": len(placed),
    }
    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"RESULT words={len(placed)} first={placed[0]['start']:.2f} last={placed[-1]['end']:.2f}",
        flush=True,
    )


if __name__ == "__main__":
    main()
