"""Pull a .wfpbundle apart on disk.

The bundle is a zip that can be larger than a gigabyte. Reading it all into
memory is what made the editor refuse the file. This writes each picture,
video, and voice file out, plus the small project inside, and prints one
JSON object.
"""

from __future__ import annotations

import json
import shutil
import sys
import zipfile
from pathlib import Path

IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".svg", ".avif", ".jfif", ".heic"}
VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".3gp", ".ts", ".mts", ".flv", ".wmv", ".mpeg", ".mpg"}
AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".wma"}


def main() -> None:
    src = Path(sys.argv[1])
    root = Path(sys.argv[2])
    manifest = {"comment": "", "inner_wfp": "", "files": []}
    with zipfile.ZipFile(src) as zf:
        manifest["comment"] = zf.comment.decode("utf-8", "replace") if zf.comment else ""
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if not name or name.endswith("/"):
                continue
            low = name.lower()
            if low.endswith(".wfp") and "/" not in low:
                dest = root / "_inner.wfp"
                dest.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info, "r") as src_f, dest.open("wb") as dst:
                    shutil.copyfileobj(src_f, dst, 1024 * 1024)
                manifest["inner_wfp"] = str(dest)
                continue
            if "projectfolder/" in low or low == "medias/project_media.json":
                continue
            is_media = (
                low.startswith("medias/")
                or "/medias/" in low
                or low.startswith("resources/")
                or low.startswith("media/")
                or "/media/" in low
            )
            if not is_media:
                continue
            ext = Path(name).suffix.lower()
            if ext in IMAGE:
                folder = root / "media" / "images"
            elif ext in VIDEO:
                folder = root / "media" / "videos"
            elif ext in AUDIO:
                folder = root / "voiceover"
            else:
                continue
            folder.mkdir(parents=True, exist_ok=True)
            dest = folder / Path(name).name
            with zf.open(info, "r") as src_f, dest.open("wb") as dst:
                shutil.copyfileobj(src_f, dst, 1024 * 1024)
            manifest["files"].append({"name": name, "path": str(dest)})
    sys.stdout.write(json.dumps(manifest, ensure_ascii=True))


if __name__ == "__main__":
    main()
