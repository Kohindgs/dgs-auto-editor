#!/usr/bin/env python3
"""DGS Auto Editor: CPU-only VO transcription with per-word timestamps.
Uses locally-installed Apache-2 Vosk model. Progress is emitted as lines.
Input audio is deleted by the caller after the job finishes.
"""
import json
import os
import subprocess
import sys

if len(sys.argv) != 3:
    print("ERROR missing audio/model arguments", flush=True)
    sys.exit(2)

audio_path, model_path = sys.argv[1:]
sys.path.insert(0, os.environ.get("DGS_VOSK_PYTHONPATH", ""))
from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)
model = Model(model_path)
recognizer = KaldiRecognizer(model, 16000)
recognizer.SetWords(True)
ffmpeg = os.environ.get("DGS_FFMPEG_BIN", "ffmpeg")
ffmpeg_cmd = [
    ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", audio_path, "-vn", "-ac", "1", "-ar", "16000",
    "-f", "s16le", "-"
]
proc = subprocess.Popen(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
words = []
total_bytes = 0
next_report = 12

def append(result_text):
    try:
        item = json.loads(result_text)
    except Exception:
        return
    for word in item.get("result", []):
        spoken = str(word.get("word", "")).strip()
        a = float(word.get("start", 0))
        b = float(word.get("end", a))
        if spoken and b >= a >= 0:
            words.append({
                "word": spoken,
                "start": round(a, 3),
                "end": round(b, 3),
                "confidence": round(float(word.get("conf", 0)), 4),
            })

try:
    while True:
        chunk = proc.stdout.read(16000)
        if not chunk:
            break
        total_bytes += len(chunk)
        if recognizer.AcceptWaveform(chunk):
            append(recognizer.Result())
        seconds = total_bytes / 32000
        if seconds >= next_report:
            print("PROGRESS " + str(int(seconds)), flush=True)
            next_report += 12
    append(recognizer.FinalResult())
    rc = proc.wait(timeout=20)
    if rc:
        raise RuntimeError("Failed to decode audio: " + proc.stderr.read().decode("utf-8", "replace")[-300:])
    if len(words) < 3:
        raise RuntimeError("Too few spoken words recognized; check narration file")
    print("RESULT " + json.dumps({
        "words": words, "decoded_duration": round(total_bytes / 32000, 3),
        "engine": "vosk-small-en-in-0.4",
    }, separators=(",", ":")), flush=True)
except Exception as exc:
    proc.kill()
    print("ERROR " + str(exc), flush=True)
    sys.exit(1)
