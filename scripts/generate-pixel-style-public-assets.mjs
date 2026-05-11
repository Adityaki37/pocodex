import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import sharp from "sharp";
import {
  atlasRows,
  createPixelStyleSourceContext,
  frameHeight,
  frameWidth,
  pixelQualityStyles,
  pixelQualityStylesById,
  pixelStyleFingerprint,
  pixelStyleGenerationSource,
  pixelStyleId,
  transparent,
  writePixelStyleMotionSheetFromMotionSource,
  writePixelStyleSpritesheetFromMotionSource
} from "./lib/pixel-style-generation.mjs";

sharp.cache(false);
sharp.concurrency(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicRoot = path.join(rootDir, "public", "pocodex");
const publicPetsDir = path.join(publicRoot, "pets");
const publicDownloadsDir = path.join(publicRoot, "downloads");
const publicInstallDir = path.join(rootDir, "public", "install");
const manifestPath = path.join(publicRoot, "manifest.json");
const catalogPath = path.join(publicRoot, "catalog.json");
const publicBaseUrl = normalizeBaseUrl(process.env.POCODEX_URL ?? "https://pocodex.dev");
const npxPackageSource = `${publicBaseUrl}/pocodex-cli.tgz`;
const npmPackageSource = "https://codeload.github.com/Adityaki37/pocodex/tar.gz/refs/heads/main";
const previewScale = 0.5;
const workerCount = Math.max(1, Number(process.env.POCODEX_PIXEL_STYLE_WORKERS ?? 4) || 4);
const force = process.env.POCODEX_PIXEL_STYLE_FORCE === "1";

await main();

async function main() {
  const requestedIds = parseRequestedIds(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const petsById = new Map(manifest.pets.map((pet) => [pet.id, pet]));
  const styleOrder = new Map(pixelQualityStyles.map((style, index) => [style.id, index]));
  let pixelPets = manifest.pets.filter((pet) => pet.formGroup === "pixel" && pixelQualityStylesById.has(pixelStyleId(pet)));

  if (requestedIds.size > 0) {
    pixelPets = pixelPets.filter((pet) => requestedIds.has(pet.id) || requestedIds.has(pet.pixelStyle?.sourcePetId));
  }

  const groups = groupPixelPetsBySource(pixelPets, petsById, styleOrder);
  let completed = 0;

  await mapLimit(groups, workerCount, async (group) => {
    const context = await createPixelStyleSourceContext(group.sourcePet);
    for (const pet of group.pixelPets) {
      const style = pixelQualityStylesById.get(pixelStyleId(pet));
      await generatePixelStylePet({ pet, sourcePet: group.sourcePet, style, context, states: manifest.states });
      completed += 1;
      if (completed % 100 === 0 || completed === pixelPets.length) {
        console.log(`Generated ${completed}/${pixelPets.length} source-based pixel-style asset packs`);
      }
    }
  });

  await updateCatalog(pixelPets);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  console.log(`Updated manifest with source-based assets for ${pixelPets.length} pixel-style variations.`);
}

function groupPixelPetsBySource(pixelPets, petsById, styleOrder) {
  const groups = new Map();
  for (const pet of pixelPets) {
    const sourcePet = petsById.get(pet.pixelStyle?.sourcePetId);
    if (!sourcePet) {
      throw new Error(`Missing source pet ${pet.pixelStyle?.sourcePetId} for ${pet.id}`);
    }
    if (!groups.has(sourcePet.id)) {
      groups.set(sourcePet.id, { sourcePet, pixelPets: [] });
    }
    groups.get(sourcePet.id).pixelPets.push(pet);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    pixelPets: group.pixelPets.sort((a, b) => (styleOrder.get(pixelStyleId(a)) ?? 999) - (styleOrder.get(pixelStyleId(b)) ?? 999))
  }));
}

async function generatePixelStylePet({ pet, sourcePet, style, context, states }) {
  const targetDir = path.join(publicPetsDir, pet.id);
  await mkdir(targetDir, { recursive: true });
  const packageDisplayName = pet.packageDisplayName ?? `${sourcePet.displayName} ${style.label}`;

  const targetPetJson = path.join(targetDir, "pet.json");
  const targetSpritesheet = path.join(targetDir, "spritesheet.webp");
  const targetPreview = path.join(targetDir, "preview.png");
  const targetThumbnail = path.join(targetDir, "thumbnail.webp");
  const targetSourceJson = path.join(targetDir, "source.json");
  const targetMotionDir = path.join(targetDir, "motion");
  const sourceJson = await readJsonIfExists(targetSourceJson);
  const styleFingerprint = pixelStyleFingerprint(style);
  const motionActions = pixelStyleMotionActions(pet, style, context);
  const sourceGenerated =
    sourceJson?.pixelStyle?.generationSource === pixelStyleGenerationSource &&
    sourceJson?.pixelStyle?.generatedAssets === true &&
    sourceJson?.pixelStyle?.styleFingerprint === styleFingerprint;
  const needsRender =
    force ||
    !sourceGenerated ||
    !(await fileExists(targetSpritesheet)) ||
    !(await fileExists(targetPreview)) ||
    !(await fileExists(targetThumbnail));

  if (needsRender) {
    await writePixelStyleSpritesheetFromMotionSource({
      context,
      sourcePet,
      style,
      outputPath: targetSpritesheet,
      states
    });
    await writePreviewFromSpritesheet(targetDir, style);
    await createThumbnail(targetSpritesheet, targetThumbnail, style);
  }
  if (
    motionActions.length > 0 &&
    (needsRender || force || await anyMotionSpriteMissing(targetMotionDir, motionActions))
  ) {
    await mkdir(targetMotionDir, { recursive: true });
    for (const action of motionActions) {
      await writePixelStyleMotionSheetFromMotionSource({
        context,
        sourcePet,
        action,
        style,
        outputPath: path.join(targetMotionDir, `${action}-Anim.webp`)
      });
    }
  }

  await writeFile(
    targetPetJson,
    `${JSON.stringify(
      {
        id: pet.id,
        displayName: packageDisplayName,
        description: `${style.description} Based on the ${sourcePet.displayName} Pocodex pet.`,
        spritesheetPath: "spritesheet.webp"
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    targetSourceJson,
    `${JSON.stringify(
      {
        ...sourceJson,
        displayName: packageDisplayName,
        formLabel: style.label,
        sourceName: packageDisplayName,
        variant: style.id,
        pixelStyle: {
          ...sourceJson?.pixelStyle,
          id: style.id,
          label: style.label,
          description: style.description,
          sourcePetId: sourcePet.id,
          rendering: style.rendering ?? "auto",
          generationSource: pixelStyleGenerationSource,
          generatedAssets: true,
          styleFingerprint
        }
      },
      null,
      2
    )}\n`
  );

  const zipName = `${pet.id}.zip`;
  const zipPath = path.join(publicDownloadsDir, zipName);
  await mkdir(publicDownloadsDir, { recursive: true });
  await writeFile(zipPath, await createZip(targetDir));
  await writeInstallScripts(pet.id, zipName);

  pet.assets = {
    ...pet.assets,
    preview: `/pocodex/pets/${pet.id}/preview.png`,
    thumbnail: `/pocodex/pets/${pet.id}/thumbnail.webp`,
    spritesheet: `/pocodex/pets/${pet.id}/spritesheet.webp`,
    zip: `/pocodex/downloads/${zipName}`,
    installSh: `/install/${pet.id}`,
    installPs1: `/install/${pet.id}.ps1`,
    ...(motionActions.length > 0
      ? {
          motionSpriteLayout: "codex-cell-v1",
          motionSprites: Object.fromEntries(
            motionActions.map((action) => [action, `/pocodex/pets/${pet.id}/motion/${action}-Anim.webp`])
          )
        }
      : {})
  };
  pet.pixelStyle = {
    ...pet.pixelStyle,
    id: style.id,
    label: style.label,
    description: style.description,
    sourcePetId: sourcePet.id,
    rendering: style.rendering ?? "auto",
    generationSource: pixelStyleGenerationSource,
    generatedAssets: true,
    styleFingerprint
  };
}

function pixelStyleMotionActions(pet, style, context) {
  const existing = Object.keys(pet.assets?.motionSprites ?? {});
  if (existing.length > 0) {
    return existing;
  }
  if (!["plain-xbrz", "hq4x"].includes(style.id)) {
    return [];
  }
  return [...context.animMap.keys()]
    .filter((action) => action && action !== "Head")
    .sort((a, b) => a.localeCompare(b));
}

async function anyMotionSpriteMissing(targetMotionDir, actions) {
  for (const action of actions) {
    if (!(await fileExists(path.join(targetMotionDir, `${action}-Anim.webp`)))) {
      return true;
    }
  }
  return false;
}

async function writePreviewFromSpritesheet(targetDir, style) {
  const sheet = path.join(targetDir, "spritesheet.webp");
  const composites = [];
  for (let row = 0; row < atlasRows; row += 1) {
    composites.push({
      input: await sharp(sheet)
        .extract({ left: 0, top: row * frameHeight, width: frameWidth, height: frameHeight })
        .png()
        .toBuffer(),
      left: row * frameWidth,
      top: 0
    });
  }

  const previewBuffer = await sharp({
    create: {
      width: frameWidth * atlasRows,
      height: frameHeight,
      channels: 4,
      background: transparent
    }
  })
    .composite(composites)
    .png()
    .toBuffer();

  await sharp(previewBuffer)
    .resize({
      width: Math.round(frameWidth * atlasRows * previewScale),
      height: Math.round(frameHeight * previewScale),
      kernel: resolvePreviewKernel(style)
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 80 })
    .toFile(path.join(targetDir, "preview.png"));
}

async function createThumbnail(spritesheetPath, outputPath, style) {
  const { data, info } = await sharp(spritesheetPath)
    .extract({ left: 0, top: 0, width: frameWidth, height: frameHeight })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(data, info);
  if (!bounds) {
    await writeStyledPreviewWebp(
      sharp({
        create: {
          width: 132,
          height: 132,
          channels: 4,
          background: transparent
        }
      }),
      outputPath,
      style
    );
    return;
  }

  const { data: spriteBuffer } = await resizePreviewBuffer(
    await sharp(data, { raw: info }).extract(bounds).png().toBuffer(),
    {
      width: 132,
      height: 132,
      background: transparent
    },
    style
  );
  const spriteMeta = await sharp(spriteBuffer).metadata();

  await writeStyledPreviewWebp(
    sharp({
      create: {
        width: 132,
        height: 132,
        channels: 4,
        background: transparent
      }
    }).composite([
      {
        input: spriteBuffer,
        left: Math.floor((132 - spriteMeta.width) / 2),
        top: Math.floor((132 - spriteMeta.height) / 2)
      }
    ]),
    outputPath,
    style
  );
}

async function resizePreviewBuffer(input, options, style) {
  return sharp(input)
    .resize({
      ...options,
      fit: options.fit ?? "inside",
      kernel: resolvePreviewKernel(style),
      withoutEnlargement: options.withoutEnlargement ?? false
    })
    .png()
    .toBuffer({ resolveWithObject: true });
}

async function writeStyledPreviewWebp(image, outputPath, style) {
  await image.webp(resolvePreviewWebpOptions(style)).toFile(outputPath);
}

function resolvePreviewKernel(style) {
  const kernel = style?.previewKernel ?? style?.thumbnailKernel ?? style?.kernel;
  return sharp.kernel[kernel] ?? sharp.kernel.lanczos3;
}

function resolvePreviewWebpOptions(style) {
  return style?.webp?.lossless
    ? { lossless: true, effort: 6 }
    : { quality: 90, alphaQuality: 95, effort: 5, smartSubsample: true };
}

function alphaBounds(data, info) {
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (alpha <= 8) {
        continue;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    return null;
  }

  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1
  };
}

async function createZip(petDir) {
  const zip = new JSZip();
  for (const fileName of ["pet.json", "spritesheet.webp", "source.json", "preview.png"]) {
    zip.file(fileName, await readFile(path.join(petDir, fileName)));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

async function writeInstallScripts(slug, zipName) {
  await mkdir(publicInstallDir, { recursive: true });
  await writeFile(path.join(publicInstallDir, slug), buildShellInstaller(slug, zipName));
  await writeFile(path.join(publicInstallDir, `${slug}.ps1`), buildPowerShellInstaller(slug, zipName));
}

function buildShellInstaller(slug, zipName) {
  return `#!/bin/sh
set -eu
BASE_URL="\${POCODEX_URL:-${publicBaseUrl}}"
SLUG="${escapeShell(slug)}"
ZIP_NAME="${escapeShell(zipName)}"
CODEX_HOME_DIR="\${CODEX_HOME:-$HOME/.codex}"
DEST="$CODEX_HOME_DIR/pets/$SLUG"
TMP_DIR="\${TMPDIR:-/tmp}/pocodex-$SLUG-$$"
ZIP_PATH="$TMP_DIR/$ZIP_NAME"

mkdir -p "$TMP_DIR" "$DEST"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT HUP INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BASE_URL/pocodex/downloads/$ZIP_NAME" -o "$ZIP_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$ZIP_PATH" "$BASE_URL/pocodex/downloads/$ZIP_NAME"
else
  echo "Pocodex install failed: curl or wget is required." >&2
  exit 1
fi

if command -v unzip >/dev/null 2>&1; then
  unzip -oq "$ZIP_PATH" -d "$DEST"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$ZIP_PATH" "$DEST" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    zf.extractall(sys.argv[2])
PY
elif command -v python >/dev/null 2>&1; then
  python - "$ZIP_PATH" "$DEST" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as zf:
    zf.extractall(sys.argv[2])
PY
else
  echo "Pocodex install failed: unzip or python is required." >&2
  exit 1
fi

echo "Installed $SLUG to $DEST"
`;
}

function buildPowerShellInstaller(slug, zipName) {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = if ($env:POCODEX_URL) { $env:POCODEX_URL } else { "${escapePowerShell(publicBaseUrl)}" }
$Slug = "${escapePowerShell(slug)}"
$ZipName = "${escapePowerShell(zipName)}"
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$Dest = Join-Path (Join-Path $CodexHome "pets") $Slug
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pocodex-" + $Slug + "-" + [Guid]::NewGuid().ToString("N"))
$ZipPath = Join-Path $TempDir $ZipName

New-Item -ItemType Directory -Force -Path $TempDir, $Dest | Out-Null
try {
  Invoke-WebRequest -Uri ($BaseUrl.TrimEnd("/") + "/pocodex/downloads/" + $ZipName) -OutFile $ZipPath -UseBasicParsing
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $Dest -Force
  Write-Host ("Installed " + $Slug + " to " + $Dest)
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

async function updateCatalog(pixelPets) {
  if (!(await fileExists(catalogPath))) {
    return;
  }
  const byId = new Map(pixelPets.map((pet) => [pet.id, pet]));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  for (const entry of catalog) {
    const pet = byId.get(entry.id);
    if (!pet) {
      continue;
    }
    entry.zip = pet.assets.zip;
    entry.install = pet.assets.installSh;
    entry.installPowerShell = pet.assets.installPs1;
    entry.installNpx = buildInstallCommands(pet.id).npx;
    entry.installNpm = buildInstallCommands(pet.id).npm;
    entry.installCurl = buildInstallCommands(pet.id).shell;
    entry.installPowerShellCommand = buildInstallCommands(pet.id).powershell;
    entry.form = pet.formLabel;
    entry.packageDisplayName = pet.packageDisplayName;
  }
  await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
}

function buildInstallCommands(slug) {
  return {
    npx: `npx --yes --package ${npxPackageSource} pocodex install ${slug} --url ${publicBaseUrl}`,
    npm: `npm install -g ${npmPackageSource} && pocodex install ${slug} --url ${publicBaseUrl}`,
    shell: `curl -fsSL ${publicBaseUrl}/install/${slug} | sh`,
    powershell: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${publicBaseUrl}/install/${slug}.ps1 | iex"`
  };
}

function parseRequestedIds(args) {
  const ids = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--ids=") || arg.startsWith("--source-ids=")) {
      addIds(ids, arg.slice(arg.indexOf("=") + 1));
      continue;
    }
    if (arg.startsWith("--id=") || arg.startsWith("--source-id=")) {
      addIds(ids, arg.slice(arg.indexOf("=") + 1));
      continue;
    }
    if (["--id", "--ids", "--source-id", "--source-ids"].includes(arg) && args[index + 1] && !args[index + 1].startsWith("-")) {
      addIds(ids, args[index + 1]);
      index += 1;
    }
  }
  return ids;
}

function addIds(ids, rawValue) {
  for (const id of rawValue.split(",").map((value) => value.trim()).filter(Boolean)) {
    ids.add(id);
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeShell(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "");
}

function escapePowerShell(value) {
  return String(value).replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}
