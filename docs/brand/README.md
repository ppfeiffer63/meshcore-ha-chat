# Brand assets

Source SVGs and rendered PNGs for the MeshCore Chat integration.

## Files

| File | Type | Used by |
|---|---|---|
| `meshcore-chat-icon.svg` | source | square-icon master (256×256) |
| `icon.png` | render @ 256×256 | `home-assistant/brands` PR (`custom_integrations/meshcore_chat/icon.png`) |
| `icon@2x.png` | render @ 512×512 | `home-assistant/brands` PR (retina variant) |
| `meshcore-chat-logo.svg` | source | wordmark logo (1024×256, transparent bg, navy text) |
| `logo.png` | render @ 512×128 | `home-assistant/brands` PR (`logo.png`) |
| `logo@2x.png` | render @ 1024×256 | `home-assistant/brands` PR (retina variant) |
| `meshcore-chat-readme-banner.svg` | source | wide banner (1280×320, dark navy bg, white) |
| `readme-banner.png` | render @ 1280×320 | top of repo `README.md` |

The banner SVG is mechanically derived from the logo SVG (1.25× scale, white-on-navy recolor, hairline stroke added to the icon panel for definition against the dark background). If the logo source changes, the banner is rebuilt by re-running the render command below.

The logo SVG was authored in Pixelmator Pro. The icon SVG and banner SVG are hand-written. The MESHCORE wordmark glyphs come from `../brand-reference/meshcore.svg` (the upstream wordmark, embedded directly).

## Re-rendering PNGs

PNGs are generated from the SVG sources via `cairosvg` (Python). Install once:

```sh
pip install cairosvg --break-system-packages
```

Then from this directory:

```sh
python3 - <<'PY'
import cairosvg
cairosvg.svg2png(url="meshcore-chat-icon.svg",          write_to="icon.png",          output_width=256,  output_height=256)
cairosvg.svg2png(url="meshcore-chat-icon.svg",          write_to="icon@2x.png",       output_width=512,  output_height=512)
cairosvg.svg2png(url="meshcore-chat-logo.svg",          write_to="logo.png",          output_width=512,  output_height=128)
cairosvg.svg2png(url="meshcore-chat-logo.svg",          write_to="logo@2x.png",       output_width=1024, output_height=256)
cairosvg.svg2png(url="meshcore-chat-readme-banner.svg", write_to="readme-banner.png", output_width=1280, output_height=320)
PY
```

Note: cairosvg's font fallback for `Helvetica` is Liberation Sans on Linux. The subtitle uses `text-anchor="middle"` so centering is preserved regardless of which font the renderer picks.

## Brand colors

- Navy: `#1A2238` (background panels, dark text)
- White: `#FFFFFF` (foreground icon, light text)

## Reference

`../brand-reference/` holds the upstream MeshCore brand sources (icon JPEG, wordmark JPEG, wordmark SVG). Treat as read-only — never edit, only reference.
