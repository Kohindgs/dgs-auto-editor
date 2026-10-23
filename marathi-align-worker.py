#!/usr/bin/env python3
"""DGS Auto Editor Marathi ASR. AI4Bharat IndicConformer CTC (community sherpa ONNX export).
Runs locally on Hostinger CPU; returns recognized Marathi words with timestamps.
Never generates substitute scene timing if no credible words were heard.
"""
import sys, os, json, time, subprocess, math

MR_HOME = os.environ.get("DGS_MR_ASR_HOME", "/home/u188101251/dgs_audio_align")
sys.path.insert(0, os.path.join(MR_HOME, "mr_python"))
sys.path.insert(0, os.path.join(MR_HOME, "mr_python_legacy"))
import numpy as np
import sherpa_onnx

if len(sys.argv) != 3:
    print("ERROR audio_path and model_path required", flush=True)
    sys.exit(2)
audio_path, model_dir = sys.argv[1:]
model_file = os.path.join(model_dir, "model.int8.onnx")
tokens_file = os.path.join(model_dir, "tokens.txt")
if not os.path.isfile(model_file) or not os.path.isfile(tokens_file):
    print("ERROR Marathi speech recognition model is not installed", flush=True)
    sys.exit(2)

def heard_words(tokens, stamps, segment_offset):
    acc = []
    cur = None
    for tok, ts in zip(tokens, stamps):
        raw = str(tok)
        t = max(0.0, float(ts))
        if not raw or not math.isfinite(t):
            continue
        text = raw.lstrip()
        word_break = raw[0].isspace()
        if word_break and cur is not None:
            cur["end"] = max(cur["start"] + 0.08, cur["last"] + 0.08)
            acc.append(cur)
            cur = None
        if not text:
            continue
        if cur is None:
            cur = {"word": text, "start": t, "last": t}
        else:
            cur["word"] += text
            cur["last"] = t
    if cur:
        cur["end"] = max(cur["start"] + 0.08, cur["last"] + 0.08)
        acc.append(cur)
    for i, item in enumerate(acc):
        if i + 1 < len(acc):
            item["end"] = min(item["end"], acc[i + 1]["start"] - 0.005)
        item["end"] = max(item["start"] + 0.035, item["end"])
        item["start"] += segment_offset
        item["end"] += segment_offset
    return acc

ffmpeg = os.environ.get("DGS_FFMPEG_BIN", "ffmpeg")
try:
    decoder = subprocess.Popen([
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", audio_path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    raw, err = decoder.communicate(timeout=180)
    if decoder.returncode != 0:
        raise RuntimeError("Failed to decode the Marathi VO recording")
    audio = np.frombuffer(raw, dtype=np.float32)
    if len(audio) < 16000:
        raise RuntimeError("Marathi narration is empty or too short")
    duration = len(audio) / 16000.0
    rec = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
        model=model_file, tokens=tokens_file, num_threads=2, decoding_method="greedy_search"
    )
    step = 22.0
    overlap = 2.0
    collected = []
    starts = np.arange(0.0, duration, step, dtype=np.float64).tolist()
    for i, start in enumerate(starts):
        end = min(duration, start + step + overlap)
        samples = audio[int(start * 16000):int(end * 16000)]
        if samples.size < 1200:
            continue
        stream = rec.create_stream()
        stream.accept_waveform(16000, samples)
        rec.decode_stream(stream)
        result = stream.result
        tokens = list(getattr(result, "tokens", []) or [])
        timestamps = list(getattr(result, "timestamps", []) or [])
        if len(tokens) != len(timestamps):
            raise RuntimeError("Marathi model produced no token timestamps; cuts not changed")
        current = heard_words(tokens, timestamps, start)
        lower = start + (overlap / 2 if i else 0)
        upper = start + step + (overlap / 2 if i + 1 < len(starts) else overlap + 1)
        for w in current:
            mid = (w["start"] + w["end"]) / 2
            if mid >= lower and mid < upper and w["word"].strip():
                collected.append({"word": w["word"], "start": round(w["start"], 3),
                                  "end": round(min(duration, w["end"]), 3)})
        print("PROGRESS " + str(int(min(duration, end))), flush=True)
        del stream
    if len(collected) < 10:
        raise RuntimeError("Too few Marathi words recognized; preserving the existing timeline")
    collected.sort(key=lambda x: x["start"])
    cleaned = []
    for item in collected:
        if cleaned and item["start"] < cleaned[-1]["start"] - 0.05:
            continue
        if item["end"] <= item["start"]:
            item["end"] = round(item["start"] + 0.04, 3)
        cleaned.append(item)
    print("RESULT " + json.dumps({
        "words": cleaned,
        "decoded_duration": round(duration, 3),
        "engine": "ai4bharat-indicconformer-mr-ctc-int8"
    }, ensure_ascii=False, separators=(",", ":")), flush=True)
except Exception as exc:
    print("ERROR " + str(exc), flush=True)
    sys.exit(1)
