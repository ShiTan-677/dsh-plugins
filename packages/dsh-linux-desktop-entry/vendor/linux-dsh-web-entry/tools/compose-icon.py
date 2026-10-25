#!/usr/bin/env python3
"""Compose the DSH Web desktop icon.

The Harness favicon is a bare monochrome glyph, which disappears against half
of the possible wallpapers. This script reuses the glyph from a locally
installed copy of the Web frontend and lays it on a rounded app tile, so the
desktop icon reads the same on light and dark backgrounds. Nothing is vendored:
the art comes from the DSH installation itself.
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import sys

TILE_SIZE = 128
GLYPH_BOX = 50  # the shipped favicon viewBox
GLYPH_SCALE = 1.8
GLYPH_OFFSET = (TILE_SIZE - GLYPH_BOX * GLYPH_SCALE) / 2

DARK_TILE = "#1f2024"
DARK_GLYPH = "#ffffff"
LIGHT_TILE = "#f4f4f6"
LIGHT_GLYPH = "#000000"

TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  <rect x="4" y="4" width="{inner}" height="{inner}" rx="28" fill="{tile}"/>
  <g transform="translate({offset:g} {offset:g}) scale({scale})">
{body}
  </g>
</svg>
"""

FALLBACK = """<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  <rect x="4" y="4" width="{inner}" height="{inner}" rx="28" fill="{tile}"/>
  <text x="{center}" y="{center}" text-anchor="middle" dominant-baseline="central"
        font-family="DejaVu Sans, sans-serif" font-size="40" font-weight="bold"
        fill="{glyph}">DSH</text>
</svg>
"""


def search_roots() -> list[str]:
    """Candidate favicon paths, most specific first.

    Every pattern is anchored to a known package directory: a recursive glob
    over the whole home directory would take minutes on a real machine.
    """
    patterns = [
        os.path.expanduser("~/.npm/_npx/*/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon*.svg"),
        os.path.expanduser("~/.local/share/pnpm/global/*/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon*.svg"),
        os.path.expanduser("~/.bun/install/global/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon*.svg"),
        os.path.expanduser("~/.dsh/*/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon*.svg"),
        "/usr/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon*.svg",
        "/usr/local/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon*.svg",
        "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon*.svg",
    ]
    matches: list[str] = []
    for pattern in patterns:
        matches.extend(glob.glob(pattern))
    if os.environ.get("DSH_FAVICON"):
        matches.insert(0, os.environ["DSH_FAVICON"])
    # Prefer the white glyph: it sits on the dark tile used below.
    matches.sort(key=lambda path: ("dark" not in os.path.basename(path), len(path)))
    return [path for path in matches if os.path.isfile(path)]


def glyph_body(svg_text: str) -> str:
    """Inner markup of a root <svg> element."""
    start = svg_text.index(">") + 1
    end = svg_text.rindex("</svg>")
    return svg_text[start:end].strip()


def render(source: str | None) -> str:
    inner = TILE_SIZE - 8
    if source is None:
        return FALLBACK.format(size=TILE_SIZE, inner=inner, tile=DARK_TILE,
                               glyph=DARK_GLYPH, center=TILE_SIZE / 2)
    text = open(source, encoding="utf-8").read()
    dark = "dark" in os.path.basename(source)
    return TEMPLATE.format(
        size=TILE_SIZE,
        inner=inner,
        tile=DARK_TILE if dark else LIGHT_TILE,
        body=glyph_body(text),
        offset=GLYPH_OFFSET,
        scale=GLYPH_SCALE,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="SVG file to write")
    parser.add_argument("--source", help="favicon SVG to reuse (default: auto-detect)")
    args = parser.parse_args()

    source = args.source
    if source is None:
        found = search_roots()
        source = found[0] if found else None

    svg = render(source)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(svg)
    print(f"icon: wrote {args.output} (source: {source or 'built-in DSH wordmark'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
