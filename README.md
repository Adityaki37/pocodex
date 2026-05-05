# Pocodex

Pokemon-inspired Codex pet packs generated from expressive PMD-style animation sources.

This project builds 772 Codex-compatible custom pets and syncs them into:

```powershell
$env:USERPROFILE\.codex\pets
```

The generated pet format follows the Petdex/Codex convention: each pet folder contains a root `pet.json` and a 1536x1872 `spritesheet.webp` arranged as an 8x9 frame grid. Rows use the Codex frame counts from `hatch-pet`: 6/8/8/4/5/8/6/6/6, with unused cells transparent.

## Build

```powershell
bun install
bun run sync
bun run site:dev
```

Then open Codex, go to Settings -> Appearance -> Pets, and select one of the `pocodex-*` custom pets. Use `/pet` to show or hide it.

The Pocodex website runs at `http://127.0.0.1:5173/` during `bun run site:dev`. It lets you search, filter by source, inspect the nine Codex state rows, download each pet as a zip, or copy Petdex-style `bunx` terminal install commands.

The CLI mirrors Petdex's install shape:

```sh
bunx --bun --package @crafter-station/pocodex pocodex install pocodex-pmd-pikachu --url http://127.0.0.1:5173
```

During local development, the same command can be tested directly from this checkout:

```sh
bunx --bun --package . pocodex install pocodex-pmd-pikachu --url http://127.0.0.1:5173
```

Install a single pet from the local site:

```sh
bunx --bun --package @crafter-station/pocodex pocodex install pocodex-pmd-pikachu --url http://127.0.0.1:5173
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm http://127.0.0.1:5173/install/pocodex-pmd-pikachu.ps1 | iex"
```

```sh
curl -fsSL http://127.0.0.1:5173/install/pocodex-pmd-pikachu | sh
```

Install the full generated gallery:

```sh
bunx --bun --package @crafter-station/pocodex pocodex install all --url http://127.0.0.1:5173
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm http://127.0.0.1:5173/install/all.ps1 | iex"
```

```sh
curl -fsSL http://127.0.0.1:5173/install/all | sh
```

The CLI and install scripts honor `CODEX_HOME` for the target Codex home. The CLI accepts `--url`, while the shell/PowerShell scripts also honor `POCODEX_URL` when the gallery is hosted somewhere other than local dev.

## Scripts

- `bun run generate` builds the expressive PMD-style batches under `pets/`.
- `bun run generate:pmd` downloads PMD Collab `AnimData.xml` files and animation strips, then maps distinct PMD actions into Codex task rows.
- `bun run generate:pmd-rawasset` downloads named PMD RawAsset form folders and maps their distinct PMD-style actions into Codex task rows.
- `bun run generate:pokeapi` downloads every front-facing animated Gen V Black/White GIF available in PokeAPI. It is kept for experiments, but it is not included in the public Pocodex catalog because those loops are less expressive.
- `bun run generate:showdown` downloads every public animated GIF listed in Pokemon Showdown's `ani` sprite directory. It is kept for experiments, but it is not included in the public Pocodex catalog because those loops are less expressive.
- `bun run site:data` builds the website manifest, public pet assets, zip downloads, install scripts, and the compact `catalog.json`.
- `bun run site:pixel-styles` regenerates downloadable pixel-style spritesheets from the credited PMD motion source rows, then writes matching zips and installers.
- `bun run site:build` builds the production Pocodex frontend.
- `bun run site:dev` starts the local Pocodex website.
- `bun run validate` checks manifest fields, dimensions, used/unused cells, and edge clipping.
- `bun run install:pets` copies the generated packs into `~/.codex/pets/`.
- `bun run sync` runs the full flow.

## Current Batches

The PMD Collab batch auto-discovers every canonical base Pokemon in the SpriteCollab tracker that has enough completed overworld animation data for the Codex pet rows. The current run generated 406 PMD pets. Forms and shinies are excluded from this base batch, and 620 base tracker entries were skipped because completed overworld action data was not available yet. The generated/skip audit is saved at `pets/pocodex-pmd-selection.json`.

The PMD RawAsset batch scans the RawAsset `transfer.json` for named form folders, skips shiny/palette-only placeholders, and converts direct folders that have enough usable PMD-style action data. The current run generated 366 PMD RawAsset pets from 519 candidates; 153 entries were skipped because the referenced folder was missing or did not contain enough action rows. The generated/skip audit is saved at `pets/pocodex-pmd-rawasset-selection.json`.

PMD preview proof sheets are paginated 40 pets per image: `pets/pocodex-pmd-preview-gallery.png` through `pets/pocodex-pmd-preview-gallery-011.png`, with an index at `pets/pocodex-pmd-preview-gallery-index.json`.

PMD rows use distinct source actions where available: `Idle`, directional `Walk`, `Pose`, `Hop`, `Faint`, `Eat`, and `LookUp`, with per-pet provenance saved in each `source.json`.

For the PMD batch, `hatch-pet` validation was run for all 406 pets. Sample contact sheets and all nine state videos were generated for Bulbasaur, Charizard, Eevee, Giratina, Magikarp, Phione, Pikachu, Rayquaza, Rotom, and Unown. A combined sample contact gallery is saved at `pets/pocodex-pmd-sample-contact-gallery.png`.

Website assets are generated under `public/pocodex/`. Each pet has copied package files, a zip download, a shell installer under `public/install/<slug>`, and a PowerShell installer under `public/install/<slug>.ps1`. Production `dist/` is intentionally reproducible from `bun run site:build`.

Pixel style pets are separate generated packs, not browser-only filters. The style build replays the original PMDCollab/RawAsset motion rows and writes new `spritesheet.webp`, `preview.png`, `thumbnail.webp`, zip, and installer assets for each pixel-style slug.

## Verification

The latest verification pass checked:

- PMD RawAsset focused atlas validation: 366/366 packs passed, with expected cells populated, unused cells transparent, no edge-touching sprites, and 1536x1872 atlas dimensions each.
- `hatch-pet` atlas validation: 406/406 PMD packs passed.
- Website data: public pets are PMD-style and have zip download links, `bunx` install commands, and install script links in `public/pocodex/manifest.json`.
- Installer QA: the `pocodex-pmd-rawasset-pikachu-female.ps1` endpoint installed `pet.json` and `spritesheet.webp` into a temporary `CODEX_HOME`.

## Sources

- Pet package format and install target: [Petdex docs](https://petdex.crafter.run/docs)
- PMD sprite source: [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab) and [sprites.pmdcollab.org](https://sprites.pmdcollab.org/)
- PMD form/override source: [PMDCollab/RawAsset](https://github.com/PMDCollab/RawAsset) and [CustomSpriteCollab](https://github.com/audinowho/CustomSpriteCollab)

These are local fan-art pet packs for personal use. Pokemon names and sprites are owned by their respective rights holders.
