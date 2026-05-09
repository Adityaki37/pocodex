import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import sharp from "sharp";
import { resizeSpriteBuffer, writeSpriteWebp } from "./lib/sprite-quality.mjs";
import {
  pixelQualityStyles,
  pixelStyleFingerprint,
  pixelStyleGenerationSource,
  writePixelStyleSpritesheetFromMotionSource
} from "./lib/pixel-style-generation.mjs";

sharp.cache(false);
sharp.concurrency(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const petsDir = path.join(rootDir, "pets");
const publicRoot = path.join(rootDir, "public", "pocodex");
const publicPetsDir = path.join(publicRoot, "pets");
const publicDownloadsDir = path.join(publicRoot, "downloads");
const publicInstallDir = path.join(rootDir, "public", "install");
const publicBaseUrl = normalizeBaseUrl(process.env.POCODEX_URL ?? "http://127.0.0.1:5173");
const npxPackageSource = "github:Adityaki37/pocodex";
const npmPackageSource = "https://codeload.github.com/Adityaki37/pocodex/tar.gz/refs/heads/main";
const creditNameSources = [
  "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/credit_names.txt",
  "https://raw.githubusercontent.com/PMDCollab/RawAsset/master/spritebot_credits.txt"
];
const rawAssetCreditsUrl = "https://github.com/PMDCollab/RawAsset/blob/master/spritebot_credits.txt";
const pokemonMetadataPath = path.join(rootDir, "config", "pokemon-metadata.json");

const states = [
  { key: "idle", label: "Idle", row: 0, frames: 6, description: "Neutral breathing and blinking loop" },
  { key: "run-right", label: "Run Right", row: 1, frames: 8, description: "Right-facing movement loop" },
  { key: "run-left", label: "Run Left", row: 2, frames: 8, description: "Left-facing movement loop" },
  { key: "waving", label: "Waving", row: 3, frames: 4, description: "Greeting or active response" },
  { key: "jumping", label: "Jumping", row: 4, frames: 5, description: "Vertical task burst" },
  { key: "failed", label: "Failed", row: 5, frames: 8, description: "Error or failed task reaction" },
  { key: "waiting", label: "Waiting", row: 6, frames: 6, description: "Waiting on long-running work" },
  { key: "running", label: "Running", row: 7, frames: 6, description: "Busy work loop" },
  { key: "review", label: "Review", row: 8, frames: 6, description: "Review or inspection state" }
];
const frameWidth = 192;
const frameHeight = 208;
const atlasColumns = 8;
const atlasRows = 9;
const previewScale = 0.5;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const pixelStyleCollection = {
  id: "pixel-style",
  label: "Pixel Style",
  tone: "blue",
  detail: "Alternate sprite quality treatment"
};
const shouldWritePixelStyleAssets = process.env.POCODEX_PIXEL_STYLE_ASSETS === "1";

async function main() {
  const requestedIds = parseRequestedIds(process.argv.slice(2));
  const entries = await readdir(petsDir, { withFileTypes: true });
  const petDirs = await resolvePetDirs(entries, requestedIds);
  const creditNameLookup = await loadCreditNameLookup();
  const pokemonMetadata = await loadPokemonMetadata();

  await rm(publicRoot, { recursive: true, force: true });
  await rm(publicInstallDir, { recursive: true, force: true });
  await mkdir(publicPetsDir, { recursive: true });
  await mkdir(publicDownloadsDir, { recursive: true });
  await mkdir(publicInstallDir, { recursive: true });

  const pets = [];
  const packagedEntries = [];
  for (let index = 0; index < petDirs.length; index += 1) {
    const petDir = petDirs[index];
    const petJson = JSON.parse(await readFile(path.join(petDir, "pet.json"), "utf8"));
    const sourceJson = JSON.parse(await readFile(path.join(petDir, "source.json"), "utf8"));
    const collection = resolveCollection(sourceJson);
    if (!isExpressiveCollection(collection, sourceJson)) {
      continue;
    }

    const displayInfo = resolveDisplayInfo(sourceJson, petJson);
    const targetPetDir = path.join(publicPetsDir, petJson.id);
    await mkdir(targetPetDir, { recursive: true });

    for (const fileName of ["pet.json", "source.json", "spritesheet.webp", "preview.png"]) {
      await copyFile(path.join(petDir, fileName), path.join(targetPetDir, fileName));
    }
    await createThumbnail(path.join(petDir, "spritesheet.webp"), path.join(targetPetDir, "thumbnail.webp"));

    const zipBuffer = await createZip(petDir);
    const zipName = `${petJson.id}.zip`;
    await writeFile(path.join(publicDownloadsDir, zipName), zipBuffer);
    await writeInstallScripts(petJson.id, zipName);

    const pet = {
      number: resolveDexNumber(sourceJson),
      id: petJson.id,
      slug: petJson.id,
      displayName: displayInfo.displayName,
      packageDisplayName: petJson.displayName,
      formLabel: displayInfo.formLabel,
      formGroup: displayInfo.formGroup,
      formGroupLabel: displayInfo.formGroupLabel,
      description: petJson.description,
      collection,
      sourceId: sourceJson.sourceId ?? sourceJson.pokemonId ?? null,
      sourceName: sourceJson.sourceName ?? sourceJson.displayName ?? sourceJson.pokemonName ?? null,
      variant: sourceJson.variant ?? "front-default",
      sourceUrl: sourceJson.sourceUrl ?? sourceJson.spriteSourceUrl ?? null,
      sourceBrowserUrl: sourceJson.sourceBrowserUrl ?? sourceJson.spriteBrowserUrl ?? null,
      motionModel: sourceJson.motionModel ?? "Distinct source animation rows mapped into Codex task states.",
      motionSource: buildMotionSource(sourceJson),
      attribution: buildAttribution(sourceJson, collection, creditNameLookup),
      pokemonMeta: buildPokemonMeta(sourceJson, pokemonMetadata),
      installTarget: `~/.codex/pets/${petJson.id}/`,
      assets: {
        preview: `/pocodex/pets/${petJson.id}/preview.png`,
        thumbnail: `/pocodex/pets/${petJson.id}/thumbnail.webp`,
        spritesheet: `/pocodex/pets/${petJson.id}/spritesheet.webp`,
        petJson: `/pocodex/pets/${petJson.id}/pet.json`,
        sourceJson: `/pocodex/pets/${petJson.id}/source.json`,
        zip: `/pocodex/downloads/${zipName}`,
        installSh: `/install/${petJson.id}`,
        installPs1: `/install/${petJson.id}.ps1`
      },
      commands: buildInstallCommands(petJson.id)
    };
    pet.tags = buildTags(sourceJson, collection, displayInfo, pet.pokemonMeta);
    pets.push(pet);
    packagedEntries.push({ pet, petDir, petJson, sourceJson, displayInfo, collection });

    if (pets.length % 250 === 0) {
      console.log(`Packaged ${pets.length} expressive pets for Pocodex`);
    }
  }

  const pixelStylePets = await createPixelStylePets(packagedEntries, creditNameLookup);
  pets.push(...pixelStylePets);
  pets.sort(comparePokemonOrder);

  const collections = summarizeCollections(pets);
  const formGroups = summarizeFormGroups(pets);
  await writeInstallAllScripts();
  await writeFile(
    path.join(publicRoot, "catalog.json"),
    `${JSON.stringify(
      pets.map((pet) => ({
        number: pet.number,
        id: pet.id,
        displayName: pet.displayName,
        packageDisplayName: pet.packageDisplayName,
        collection: pet.collection.label,
        form: pet.formLabel,
        formGroup: pet.formGroup,
        zip: pet.assets.zip,
        installNpx: pet.commands.npx,
        installNpm: pet.commands.npm,
        installCurl: pet.commands.shell,
        installPowerShellCommand: pet.commands.powershell,
        install: pet.assets.installSh,
        installPowerShell: pet.assets.installPs1
      }))
    )}\n`
  );
  await writeFile(
    path.join(publicRoot, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        title: "Pocodex",
        description: "Source-differentiated Pokemon Codex pet gallery.",
        states,
        stats: {
          totalPets: pets.length,
          collections,
          formGroups
        },
        pets: pets.map(toManifestPet)
      }
    )}\n`
  );

  console.log(`Built Pocodex website data for ${pets.length} pets.`);
}

function toManifestPet(pet) {
  const { commands, ...rest } = pet;
  return rest;
}

function parseRequestedIds(args) {
  const ids = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--ids=")) {
      addIds(ids, arg.slice("--ids=".length));
      continue;
    }
    if (arg.startsWith("--id=")) {
      addIds(ids, arg.slice("--id=".length));
      continue;
    }
    if ((arg === "--id" || arg === "--ids") && args[index + 1] && !args[index + 1].startsWith("-")) {
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

async function resolvePetDirs(entries, requestedIds = new Set()) {
  const petDirs = [];
  const foundIds = new Set();
  const skippedIncomplete = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    if (requestedIds.size > 0 && !requestedIds.has(entry.name)) {
      continue;
    }
    const petDir = path.join(petsDir, entry.name);
    if (await fileExists(path.join(petDir, "pet.json"))) {
      petDirs.push(petDir);
      foundIds.add(entry.name);
    } else {
      if (requestedIds.size > 0) {
        throw new Error(`Requested pet "${entry.name}" is missing pet.json in ${petDir}`);
      }
      skippedIncomplete.push(entry.name);
    }
  }

  for (const id of requestedIds) {
    if (!foundIds.has(id)) {
      throw new Error(`Requested pet "${id}" was not found in ${petsDir}`);
    }
  }

  if (skippedIncomplete.length > 0) {
    console.warn(`Skipped ${skippedIncomplete.length} incomplete pet director${skippedIncomplete.length === 1 ? "y" : "ies"}: ${skippedIncomplete.join(", ")}`);
  }
  return petDirs;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeInstallScripts(slug, zipName) {
  await writeFile(path.join(publicInstallDir, slug), buildShellInstaller(slug, zipName));
  await writeFile(path.join(publicInstallDir, `${slug}.ps1`), buildPowerShellInstaller(slug, zipName));
}

async function writeInstallAllScripts() {
  await writeFile(path.join(publicInstallDir, "all"), buildShellInstallAll());
  await writeFile(path.join(publicInstallDir, "all.ps1"), buildPowerShellInstallAll());
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

for name in pet.json source.json; do
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$BASE_URL/pocodex/pets/$SLUG/$name" -o "$DEST/$name" 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$DEST/$name" "$BASE_URL/pocodex/pets/$SLUG/$name" 2>/dev/null || true
  fi
done

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
  foreach ($Name in @("pet.json", "source.json")) {
    try {
      Invoke-WebRequest -Uri ($BaseUrl.TrimEnd("/") + "/pocodex/pets/" + $Slug + "/" + $Name) -OutFile (Join-Path $Dest $Name) -UseBasicParsing
    } catch {}
  }
  Write-Host ("Installed " + $Slug + " to " + $Dest)
} finally {
  Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

function buildShellInstallAll() {
  return `#!/bin/sh
set -eu
BASE_URL="\${POCODEX_URL:-${publicBaseUrl}}"
if command -v curl >/dev/null 2>&1; then
  CATALOG="$(curl -fsSL "$BASE_URL/pocodex/catalog.json")"
elif command -v wget >/dev/null 2>&1; then
  CATALOG="$(wget -qO- "$BASE_URL/pocodex/catalog.json")"
else
  echo "Pocodex install failed: curl or wget is required." >&2
  exit 1
fi

printf '%s' "$CATALOG" | sed -n 's/.*"id": "\\([^"]*\\)".*/\\1/p' | while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  echo "Installing $slug"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$BASE_URL/install/$slug" | POCODEX_URL="$BASE_URL" sh
  else
    wget -qO- "$BASE_URL/install/$slug" | POCODEX_URL="$BASE_URL" sh
  fi
done
`;
}

function buildPowerShellInstallAll() {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = if ($env:POCODEX_URL) { $env:POCODEX_URL } else { "${escapePowerShell(publicBaseUrl)}" }
$Catalog = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd("/") + "/pocodex/catalog.json")
$PreviousPocodexUrl = $env:POCODEX_URL
try {
  foreach ($Pet in $Catalog) {
    Write-Host ("Installing " + $Pet.id)
    $env:POCODEX_URL = $BaseUrl
    $Script = (Invoke-WebRequest -Uri ($BaseUrl.TrimEnd("/") + "/install/" + $Pet.id + ".ps1") -UseBasicParsing).Content
    Invoke-Expression $Script
  }
} finally {
  if ($null -eq $PreviousPocodexUrl) {
    Remove-Item Env:\\POCODEX_URL -ErrorAction SilentlyContinue
  } else {
    $env:POCODEX_URL = $PreviousPocodexUrl
  }
}
`;
}

async function createPixelStylePets(entries, creditNameLookup) {
  const sourceEntries = entries
    .filter((entry) => Number.isFinite(entry.pet.number) && entry.pet.number > 0 && entry.pet.number < 99999)
    .sort((a, b) => comparePokemonOrder(a.pet, b.pet));
  const generated = [];

  for (let index = 0; index < sourceEntries.length; index += 1) {
    const sourceEntry = sourceEntries[index];
    for (const style of pixelQualityStyles) {
      generated.push(await createPixelStylePet(sourceEntry, style, creditNameLookup));
    }
    if ((index + 1) % 150 === 0) {
      console.log(`Added pixel style selections for ${index + 1} Pokemon variations`);
    }
  }

  console.log(`Added ${generated.length} pixel style pet variations for ${sourceEntries.length} Pokemon variations.`);
  return generated;
}

function pickPixelStyleSource(entries) {
  return [...entries].sort((a, b) => pixelSourceRank(a) - pixelSourceRank(b) || comparePokemonOrder(a.pet, b.pet))[0] ?? null;
}

function pixelSourceRank(entry) {
  let rank = 0;
  if (entry.pet.formGroup !== "base") {
    rank += 100;
  }
  if (entry.pet.collection.id === "pmd-rawasset") {
    rank += 10;
  } else if (entry.pet.collection.id !== "pmd") {
    rank += 30;
  }
  return rank;
}

function pixelStyleSourceDisplayName(pet) {
  return pet.formLabel && pet.formLabel !== "Base" ? `${pet.displayName} ${pet.formLabel}` : pet.displayName;
}

async function createPixelStylePet(entry, style, creditNameLookup) {
  const basePet = entry.pet;
  const slug = `${basePet.slug}-${style.id}`;
  const zipName = shouldWritePixelStyleAssets ? `${slug}.zip` : path.basename(basePet.assets.zip);
  const targetPetDir = path.join(publicPetsDir, slug);
  const styleFingerprint = pixelStyleFingerprint(style);
  const styleSourceDisplayName = pixelStyleSourceDisplayName(basePet);
  await rm(targetPetDir, { recursive: true, force: true });
  await mkdir(targetPetDir, { recursive: true });

  const petJson = {
    ...entry.petJson,
    id: slug,
    displayName: `${styleSourceDisplayName} ${style.label}`,
    description: `${style.description} Based on the ${styleSourceDisplayName} Pocodex pet.`
  };
  const sourceJson = {
    ...entry.sourceJson,
    baseName: basePet.displayName,
    displayName: `${styleSourceDisplayName} ${style.label}`,
    formLabel: style.label,
    sourceName: `${styleSourceDisplayName} ${style.label}`,
    variant: style.id,
    pixelStyle: {
      id: style.id,
      label: style.label,
      description: style.description,
      sourcePetId: basePet.id,
      rendering: style.rendering ?? "auto",
      generationSource: pixelStyleGenerationSource,
      generatedAssets: shouldWritePixelStyleAssets,
      styleFingerprint
    }
  };

  await writeFile(path.join(targetPetDir, "pet.json"), `${JSON.stringify(petJson, null, 2)}\n`);
  await writeFile(path.join(targetPetDir, "source.json"), `${JSON.stringify(sourceJson, null, 2)}\n`);
  if (shouldWritePixelStyleAssets) {
    await writePixelStyleSpritesheetFromMotionSource({
      sourcePet: basePet,
      style,
      states,
      outputPath: path.join(targetPetDir, "spritesheet.webp")
    });
    await writePreviewFromSpritesheet(targetPetDir);
    await createThumbnail(path.join(targetPetDir, "spritesheet.webp"), path.join(targetPetDir, "thumbnail.webp"));
    await writeFile(path.join(publicDownloadsDir, zipName), await createZip(targetPetDir));
  }
  await writeInstallScripts(slug, zipName);

  const attribution = buildAttribution(sourceJson, entry.collection, creditNameLookup);
  const styleAssets = shouldWritePixelStyleAssets
    ? {
        preview: `/pocodex/pets/${slug}/preview.png`,
        thumbnail: `/pocodex/pets/${slug}/thumbnail.webp`,
        spritesheet: `/pocodex/pets/${slug}/spritesheet.webp`,
        zip: `/pocodex/downloads/${zipName}`
      }
    : {
        preview: basePet.assets.preview,
        thumbnail: basePet.assets.thumbnail,
        spritesheet: basePet.assets.spritesheet,
        zip: basePet.assets.zip
      };
  return {
    number: basePet.number,
    id: slug,
    slug,
    displayName: basePet.displayName,
    packageDisplayName: petJson.displayName,
    formLabel: style.label,
    formGroup: "pixel",
    formGroupLabel: "Pixel Styles",
    description: petJson.description,
    collection: pixelStyleCollection,
    sourceId: basePet.sourceId,
    sourceName: basePet.sourceName,
    variant: style.id,
    sourceUrl: basePet.sourceUrl,
    sourceBrowserUrl: basePet.sourceBrowserUrl,
    motionModel: basePet.motionModel,
    motionSource: basePet.motionSource,
    pixelStyle: sourceJson.pixelStyle,
    attribution,
    pokemonMeta: basePet.pokemonMeta,
    installTarget: `~/.codex/pets/${slug}/`,
    tags: buildTags(entry.sourceJson, entry.collection, entry.displayInfo, basePet.pokemonMeta),
    assets: {
      preview: styleAssets.preview,
      thumbnail: styleAssets.thumbnail,
      spritesheet: styleAssets.spritesheet,
      petJson: `/pocodex/pets/${slug}/pet.json`,
      sourceJson: `/pocodex/pets/${slug}/source.json`,
      zip: styleAssets.zip,
      installSh: `/install/${slug}`,
      installPs1: `/install/${slug}.ps1`
    },
    commands: buildInstallCommands(slug)
  };
}

function buildInstallCommands(slug) {
  return {
    npx: `npx --yes --package ${npxPackageSource} pocodex install ${slug} --url ${publicBaseUrl}`,
    npm: `npm install -g ${npmPackageSource} && pocodex install ${slug} --url ${publicBaseUrl}`,
    shell: `curl -fsSL ${publicBaseUrl}/install/${slug} | sh`,
    powershell: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${publicBaseUrl}/install/${slug}.ps1 | iex"`
  };
}

async function writePreviewFromSpritesheet(targetDir) {
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
      kernel: sharp.kernel.lanczos3
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 80 })
    .toFile(path.join(targetDir, "preview.png"));
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function escapeShell(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "");
}

function escapePowerShell(value) {
  return String(value).replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

async function createZip(petDir) {
  const zip = new JSZip();
  for (const fileName of ["pet.json", "spritesheet.webp", "source.json", "preview.png"]) {
    zip.file(fileName, await readFile(path.join(petDir, fileName)));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function resolveDexNumber(sourceJson) {
  const rawId = sourceJson.sourceId ?? sourceJson.pokemonId;
  const numeric = Number.parseInt(String(rawId ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 99999;
}

function comparePokemonOrder(a, b) {
  return (
    a.number - b.number ||
    a.displayName.localeCompare(b.displayName) ||
    formOrderValue(a.formGroup) - formOrderValue(b.formGroup) ||
    String(a.formLabel ?? "").localeCompare(String(b.formLabel ?? "")) ||
    a.collection.id.localeCompare(b.collection.id) ||
    a.packageDisplayName.localeCompare(b.packageDisplayName)
  );
}

function formOrderValue(formGroup) {
  const order = ["base", "pixel", "shiny", "regional", "mega", "gmax", "alternate", "form"];
  const index = order.indexOf(formGroup);
  return index === -1 ? 99 : index;
}

function buildMotionSource(sourceJson) {
  const rowSources = Array.isArray(sourceJson.rowSources) ? sourceJson.rowSources : [];
  if (sourceJson.spriteSource === "PMDCollab/SpriteCollab" && sourceJson.pokemonId) {
    const spritePath = sourceJson.spriteSourcePath ?? `sprite/${sourceJson.pokemonId}`;
    const baseUrl = `https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/${spritePath}`;
    return {
      type: "pmd-collab",
      baseUrl,
      animDataUrl: `${baseUrl}/AnimData.xml`,
      rowSources
    };
  }

  if ((sourceJson.sourceFamily === "pmd-rawasset" || sourceJson.spriteSource === "PMDCollab/RawAsset") && sourceJson.pokemonId && sourceJson.formPath != null) {
    const baseUrl = `https://raw.githubusercontent.com/PMDCollab/RawAsset/master/Sprite/${sourceJson.pokemonId}${sourceJson.formPath ? `/${sourceJson.formPath}` : ""}`;
    return {
      type: "pmd-rawasset",
      baseUrl,
      animDataUrl: `${baseUrl}/AnimData.xml`,
      rowSources
    };
  }

  return rowSources.length ? { type: "static", rowSources } : null;
}

async function loadCreditNameLookup() {
  const lookup = new Map();
  await Promise.all(
    creditNameSources.map(async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return;
        }
        mergeCreditNameText(lookup, await response.text());
      } catch {
        // Attribution still works from local credits if the optional name tables are unavailable.
      }
    })
  );
  return lookup;
}

async function loadPokemonMetadata() {
  try {
    return JSON.parse(await readFile(pokemonMetadataPath, "utf8"));
  } catch {
    return {};
  }
}

function buildPokemonMeta(sourceJson, pokemonMetadata) {
  const number = resolveDexNumber(sourceJson);
  const padded = String(number).padStart(4, "0");
  const formKey = normalizePokemonMetadataKey(sourceJson.sourceName ?? sourceJson.displayName ?? sourceJson.pokemonName);
  const formMetadata = formKey ? pokemonMetadata.forms?.[formKey] : null;
  const metadata = formMetadata ?? pokemonMetadata[padded] ?? pokemonMetadata[String(number)] ?? {};
  const types = Array.isArray(metadata.types) ? metadata.types.filter(Boolean) : [];
  return {
    types,
    generation: metadata.generation ?? generationFromNumber(number)
  };
}

function normalizePokemonMetadataKey(value) {
  return String(value ?? "")
    .replace(/^(pmd|pokeapi|showdown)[-\s]+/i, "")
    .trim()
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generationFromNumber(number) {
  if (number <= 151) return "Gen I";
  if (number <= 251) return "Gen II";
  if (number <= 386) return "Gen III";
  if (number <= 493) return "Gen IV";
  if (number <= 649) return "Gen V";
  if (number <= 721) return "Gen VI";
  if (number <= 809) return "Gen VII";
  if (number <= 905) return "Gen VIII";
  if (number <= 1025) return "Gen IX";
  return "Unknown gen";
}

function mergeCreditNameText(lookup, text) {
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [name, discord] = line.split("\t").map((part) => part.trim());
    if (!name || !discord) {
      continue;
    }
    lookup.set(discord.toLowerCase(), name);
    const mention = discord.match(/^<@!?(\d+)>$/);
    if (mention) {
      lookup.set(mention[1], name);
    }
  }
}

function buildAttribution(sourceJson, collection, creditNameLookup) {
  const authors = parseCreditAuthors(sourceJson.credits, creditNameLookup);
  const sourceLabel = sourceJson.spriteSource ?? collection.label;
  const sourceUrl = sourceJson.spriteBrowserUrl ?? sourceJson.sourceBrowserUrl ?? sourceJson.spriteSourceUrl ?? sourceJson.sourceUrl ?? null;
  const licenseLabel = summarizeLicense(sourceJson.license);
  const projectCredit = sourceLabel === "PMDCollab/RawAsset" ? "PMDCollab RawAsset contributors" : `${collection.label} contributors`;
  const creditUrl = authors.length || sourceLabel !== "PMDCollab/RawAsset" ? sourceUrl : rawAssetCreditsUrl;

  return {
    title: authors.length ? "Sprite Credit" : "Source Credit",
    authors,
    summary: summarizeAuthors(authors, projectCredit),
    license: licenseLabel,
    source: sourceLabel,
    sourceUrl: creditUrl
  };
}

function parseCreditAuthors(credits, creditNameLookup) {
  if (!credits || typeof credits !== "string") {
    return [];
  }

  const authors = new Map();
  for (const line of credits.split(/\r?\n/)) {
    const parts = line.split("\t").map((part) => part.trim()).filter(Boolean);
    const author = cleanCreditName(parts[1] ?? parts[0], creditNameLookup);
    if (!author) {
      continue;
    }
    const key = author.toLowerCase();
    if (!authors.has(key)) {
      authors.set(key, author);
    }
  }
  return [...authors.values()].sort((a, b) => a.localeCompare(b));
}

function cleanCreditName(value, creditNameLookup) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "Unspecified") {
    return "";
  }
  const mapped = creditNameLookup?.get(raw.toLowerCase());
  if (mapped) {
    return mapped;
  }
  const mention = raw.match(/^<@!?(\d+)>$/);
  if (mention) {
    const mappedMention = creditNameLookup?.get(mention[1]);
    if (mappedMention) {
      return mappedMention;
    }
    return `Discord user ${mention[1]}`;
  }
  return raw
    .replace(/^@+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeAuthors(authors, fallback) {
  if (!authors.length) {
    return fallback;
  }
  const visibleAuthors = authors.slice(0, 3);
  const remaining = authors.length - visibleAuthors.length;
  return remaining > 0 ? `${visibleAuthors.join(", ")} +${remaining} more` : visibleAuthors.join(", ");
}

function summarizeLicense(license) {
  if (!license) {
    return null;
  }
  if (/CC[_\s-]*BY[_\s-]*NC[_\s-]*4/i.test(license)) {
    return "CC BY-NC 4.0";
  }
  if (/PMDCollab\/RawAsset/i.test(license)) {
    return "See source repository";
  }
  return String(license).replace(/,\s*with Pokemon ownership.*$/i, "").trim();
}

async function createThumbnail(spritesheetPath, outputPath) {
  const { data, info } = await sharp(spritesheetPath)
    .extract({ left: 0, top: 0, width: 192, height: 208 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(data, info);
  if (!bounds) {
    await writeSpriteWebp(
      sharp({
      create: {
        width: 132,
        height: 132,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
      }),
      outputPath
    );
    return;
  }

  const { data: spriteBuffer } = await resizeSpriteBuffer(
    await sharp(data, { raw: info }).extract(bounds).png().toBuffer(),
    {
      width: 132,
      height: 132,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  );
  const spriteMeta = await sharp(spriteBuffer).metadata();

  await writeSpriteWebp(
    sharp({
    create: {
      width: 132,
      height: 132,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
    }).composite([
      {
        input: spriteBuffer,
        left: Math.floor((132 - spriteMeta.width) / 2),
        top: Math.floor((132 - spriteMeta.height) / 2)
      }
    ]),
    outputPath
  );
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

function resolveCollection(sourceJson) {
  const sourceFamily = sourceJson.sourceFamily ?? sourceJson.spriteSource;
  if (sourceFamily === "pmd-rawasset" || sourceJson.spriteSource === "PMDCollab/RawAsset") {
    return {
      id: "pmd-rawasset",
      label: "PMD RawAsset",
      tone: "green",
      detail: "Distinct PMD-style forms"
    };
  }
  if (sourceFamily === "pokeapi-gen5-animated" || sourceJson.spriteSource === "PokeAPI/sprites") {
    return {
      id: "pokeapi",
      label: "PokeAPI B/W",
      tone: "blue",
      detail: "B/W animated GIF"
    };
  }
  if (sourceFamily === "showdown-ani") {
    return {
      id: "showdown",
      label: "Showdown",
      tone: "amber",
      detail: "Animated battle GIF"
    };
  }
  if (sourceJson.spriteSource === "PMDCollab/SpriteCollab") {
    return {
      id: "pmd",
      label: "PMD Collab",
      tone: "green",
      detail: "Distinct overworld actions"
    };
  }
  return {
    id: "other",
    label: "Other",
    tone: "gray",
    detail: "Codex pet"
  };
}

function isExpressiveCollection(collection, sourceJson) {
  return (
    collection.id === "pmd" ||
    collection.id === "pmd-rawasset" ||
    sourceJson.sourceFamily === "pmd-rawasset" ||
    sourceJson.spriteSource === "PMDCollab/RawAsset"
  );
}

const hyphenSpecies = new Set([
  "brute-bonnet",
  "chien-pao",
  "chi-yu",
  "flutter-mane",
  "gouging-fire",
  "great-tusk",
  "hakamo-o",
  "ho-oh",
  "iron-boulder",
  "iron-bundle",
  "iron-crown",
  "iron-hands",
  "iron-jugulis",
  "iron-leaves",
  "iron-moth",
  "iron-thorns",
  "iron-treads",
  "jangmo-o",
  "kommo-o",
  "mime-jr",
  "mr-mime",
  "mr-rime",
  "porygon-z",
  "raging-bolt",
  "roaring-moon",
  "sandy-shocks",
  "scream-tail",
  "slither-wing",
  "tapu-bulu",
  "tapu-fini",
  "tapu-koko",
  "tapu-lele",
  "ting-lu",
  "type-null",
  "walking-wake",
  "wo-chien"
]);

const formNames = new Map([
  ["alola", "Alolan"],
  ["galar", "Galarian"],
  ["hisui", "Hisuian"],
  ["paldea", "Paldean"],
  ["f", "Female"],
  ["m", "Male"],
  ["gmax", "Gigantamax"],
  ["mega", "Mega"],
  ["megax", "Mega X"],
  ["megay", "Mega Y"],
  ["blue-striped", "Blue Striped"],
  ["exclamation", "Exclamation"],
  ["question", "Question"],
  ["shiny", "Shiny"],
  ["altcolor", "Alt Color"],
  ["alternate", "Alternate"]
]);

const baseSlugByPokemonId = new Map([
  ["0029", "nidoran-f"],
  ["0032", "nidoran-m"],
  ["0083", "farfetch-d"]
]);

const baseDisplayNameByPokemonId = new Map([
  ["0029", "Nidoran F"],
  ["0032", "Nidoran M"],
  ["0083", "Farfetch'd"]
]);

function resolveDisplayInfo(sourceJson, petJson) {
  if (sourceJson.baseName && sourceJson.formLabel) {
    const displayName = normalizeHumanLabel(sourceJson.baseName);
    const formLabel = normalizeHumanLabel(sourceJson.formLabel ?? "Base") || "Base";
    const formSlug = formLabel === "Base" ? "" : slugifyLabel(formLabel);
    const { id: formGroup, label: formGroupLabel } = resolveFormGroup(formSlug);
    return {
      displayName,
      formLabel,
      formGroup,
      formGroupLabel
    };
  }

  const rawSourceName = sourceJson.sourceName ?? sourceJson.displayName ?? sourceJson.pokemonName ?? petJson.displayName;
  const slug = String(rawSourceName)
    .replace(/^(pmd|pokeapi|showdown)[-\s]+/i, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  let { baseSlug, formSlug } = splitPokemonSlug(slug);
  const pokemonId = String(sourceJson.pokemonId ?? "").padStart(4, "0");
  if (baseSlugByPokemonId.get(pokemonId) === slug) {
    baseSlug = slug;
    formSlug = "";
  }
  const displayName = baseDisplayNameByPokemonId.get(pokemonId) ?? titleFromSlug(baseSlug || slug || petJson.displayName);
  const formLabel = formatFormLabel(formSlug, baseSlug);
  const { id: formGroup, label: formGroupLabel } = resolveFormGroup(formSlug);

  return {
    displayName,
    formLabel,
    formGroup,
    formGroupLabel
  };
}

function normalizeHumanLabel(value) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\bAltcolor\b/gi, "Alt Color")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPokemonSlug(slug) {
  if (!slug) {
    return { baseSlug: "", formSlug: "" };
  }

  const parts = slug.split("-").filter(Boolean);
  for (let size = Math.min(parts.length, 4); size > 1; size -= 1) {
    const candidate = parts.slice(0, size).join("-");
    if (hyphenSpecies.has(candidate)) {
      return {
        baseSlug: candidate,
        formSlug: parts.slice(size).join("-")
      };
    }
  }

  if (parts[0] === "unown" && parts.length > 1) {
    return { baseSlug: "unown", formSlug: parts.slice(1).join("-") };
  }
  if (parts[0] === "nidoran" && ["f", "m"].includes(parts[1])) {
    return { baseSlug: "nidoran", formSlug: parts[1] };
  }

  return {
    baseSlug: parts[0] ?? slug,
    formSlug: parts.slice(1).join("-")
  };
}

function formatFormLabel(formSlug, baseSlug = "") {
  if (!formSlug) return "Base";
  if (baseSlug === "unown" && /^[a-z]$/.test(formSlug)) return formSlug.toUpperCase();
  if (formNames.has(formSlug)) return formNames.get(formSlug);
  if (/^[a-z]$/.test(formSlug)) return formSlug.toUpperCase();
  return formSlug
    .split("-")
    .filter(Boolean)
    .map((part) => formNames.get(part) ?? titleWord(part))
    .join(" ");
}

function resolveFormGroup(formSlug) {
  if (!formSlug) return { id: "base", label: "Base" };
  if (formSlug.includes("shiny")) return { id: "shiny", label: "Shiny" };
  if (formSlug === "gmax" || formSlug === "gigantamax") return { id: "gmax", label: "Gigantamax" };
  if (formSlug.startsWith("mega")) return { id: "mega", label: "Mega" };
  if (["alola", "galar", "hisui", "paldea"].some((region) => formSlug.includes(region))) {
    return { id: "regional", label: "Regional" };
  }
  if (formSlug.includes("altcolor") || formSlug.includes("alternate")) {
    return { id: "alternate", label: "Alternate" };
  }
  return { id: "form", label: "Other Forms" };
}

function slugifyLabel(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleFromSlug(slug) {
  return String(slug)
    .split("-")
    .filter(Boolean)
    .map(titleWord)
    .join(" ");
}

function titleWord(word) {
  if (!word) return "";
  if (word === "jr") return "Jr";
  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

function buildTags(sourceJson, collection, displayInfo, pokemonMeta) {
  const tags = new Set();
  for (const type of pokemonMeta?.types ?? []) {
    tags.add(type);
  }
  if (pokemonMeta?.generation) {
    tags.add(pokemonMeta.generation);
  }
  return [...tags];
}

function summarizeCollections(pets) {
  return Object.values(
    pets.reduce((acc, pet) => {
      const id = pet.collection.id;
      acc[id] ??= { ...pet.collection, count: 0 };
      acc[id].count += 1;
      return acc;
    }, {})
  ).sort((a, b) => a.label.localeCompare(b.label));
}

function summarizeFormGroups(pets) {
  const order = ["base", "pixel", "shiny", "regional", "mega", "gmax", "alternate", "form"];
  const labels = {
    base: "Base",
    pixel: "Pixel Styles",
    shiny: "Shiny",
    regional: "Regional",
    mega: "Mega",
    gmax: "Gigantamax",
    alternate: "Alternate",
    form: "Other Forms"
  };
  return order
    .map((id) => ({
      id,
      label: labels[id],
      count: pets.filter((pet) => pet.formGroup === id).length
    }))
    .filter((group) => group.count > 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
