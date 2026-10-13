#!/usr/bin/env python3
"""Render the app icon and splash from ../icons/icon.svg (the web app's icon).

    python3 scripts/build-app-icons.py

Writes assets/icon.png (1024x1024, opaque, as the App Store requires) and
assets/splash-icon.png. Uses the Chromium that ships with Playwright, or
$CHROME if set.
"""

import os
import pathlib
import subprocess
import tempfile

from PIL import Image

APP = pathlib.Path(__file__).resolve().parent.parent
SVG = APP.parent / "icons" / "icon.svg"
CHROME = os.environ.get("CHROME", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")


def render(size: int, out: pathlib.Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp) / "icon.html"
        page.write_text(
            "<!doctype html><style>html,body{margin:0;background:#07060B}"
            f"img{{display:block;width:{size}px;height:{size}px}}</style>"
            f'<img src="{SVG.as_uri()}">',
            encoding="utf-8",
        )
        shot = pathlib.Path(tmp) / "shot.png"
        subprocess.run(
            [CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
             "--allow-file-access-from-files", f"--window-size={size + 200},{size + 400}",
             f"--screenshot={shot}", page.as_uri()],
            check=True, capture_output=True,
        )
        Image.open(shot).convert("RGB").crop((0, 0, size, size)).save(out, optimize=True)


def main() -> None:
    assets = APP / "assets"
    assets.mkdir(exist_ok=True)
    render(1024, assets / "icon.png")
    render(1024, assets / "splash-icon.png")
    for name in ("icon.png", "splash-icon.png"):
        im = Image.open(assets / name)
        print(name, im.size, im.mode)


if __name__ == "__main__":
    main()
