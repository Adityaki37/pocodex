import { access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pixelQualityStylesById,
  pixelStyleFingerprint,
  pixelStyleGenerationSource,
  pixelStyleId
} from "./lib/pixel-style-generation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const manifestPath = path.join(publicDir, "pocodex", "manifest.json");
const catalogPath = path.join(publicDir, "pocodex", "catalog.json");
const animatedSpriteDir = path.join(rootDir, "dist", "pocodex-animated-sprites");
const generatedPetDir = path.join(publicDir, "pocodex", "pets");
const remoteAssetOrigin = normalizeBaseUrl(process.env.POCODEX_PIXEL_ASSET_ORIGIN ?? "");
const workerCount = Math.max(1, Number(process.env.POCODEX_REPAIR_WORKERS ?? 32) || 32);
const useLocalGeneratedPacks = process.env.POCODEX_REPAIR_LOCAL_GENERATED !== "0";
const remoteAssetCache = new Map();
const pixelStyleOrder = ["original-unchanged", "scale2x", "epx", "plain-xbrz", "hq4x"];

await main();

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const catalogById = new Map(catalog.map((pet) => [pet.id, pet]));
  const sourceById = new Map(manifest.pets.filter((pet) => pet.formGroup !== "pixel").map((pet) => [pet.id, pet]));

  const stats = {
    pixelPets: 0,
    generatedPetAssets: 0,
    remoteGeneratedPetAssets: 0,
    animatedSprites: 0,
    sourceFallbacks: 0
  };

  await mapLimit(manifest.pets, workerCount, async (pet) => {
    if (pet.formGroup !== "pixel") {
      return;
    }
    stats.pixelPets += 1;
    const styleId = pixelStyleId(pet);
    const style = pixelQualityStylesById.get(styleId);
    const sourcePet = sourceById.get(pet.pixelStyle?.sourcePetId);
    if (!style || !sourcePet) {
      return;
    }

    const hasLocalGeneratedPack = useLocalGeneratedPacks && await hasLocalGeneratedAssets(pet, style);
    const hasRemoteGeneratedPack = !hasLocalGeneratedPack && await hasRemoteGeneratedAssets(pet, style);

    if (hasLocalGeneratedPack || hasRemoteGeneratedPack) {
      await applyGeneratedPetAssets(pet, style, sourcePet, { remote: hasRemoteGeneratedPack });
      applyCatalogGeneratedAssets(catalogById.get(pet.id), pet);
      if (hasRemoteGeneratedPack) {
        stats.remoteGeneratedPetAssets += 1;
      } else {
        stats.generatedPetAssets += 1;
      }
    } else {
      const animatedPath = path.join(animatedSpriteDir, `${pet.id}.webp`);
      if (await fileExists(animatedPath)) {
        applyAnimatedFallback(pet, style, sourcePet);
        stats.animatedSprites += 1;
      } else {
        applySourceFallback(pet, style, sourcePet);
        stats.sourceFallbacks += 1;
      }
      applyCatalogGeneratedAssets(catalogById.get(pet.id), pet);
    }
  });

  stats.duplicateStyleFallbacks = await hideDuplicateVisualStyles(manifest.pets, sourceById, catalogById);

  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
  console.log(JSON.stringify(stats, null, 2));
}

async function applyGeneratedPetAssets(pet, style, sourcePet, options = {}) {
  const zipName = `${pet.id}.zip`;
  const hasPreview = options.remote
    ? await remoteAssetExists(`/pocodex/pets/${pet.id}/preview.png`)
    : await fileExists(path.join(generatedPetDir, pet.id, "preview.png"));
  const hasThumbnail = options.remote
    ? await remoteAssetExists(`/pocodex/pets/${pet.id}/thumbnail.webp`)
    : await fileExists(path.join(generatedPetDir, pet.id, "thumbnail.webp"));
  const preview = hasPreview
    ? `/pocodex/pets/${pet.id}/preview.png`
    : sourcePet.assets?.preview ?? pet.assets?.preview;
  const thumbnail = hasThumbnail
    ? `/pocodex/pets/${pet.id}/thumbnail.webp`
    : sourcePet.assets?.thumbnail ?? pet.assets?.thumbnail;
  pet.assets = {
    ...pet.assets,
    preview,
    thumbnail,
    spritesheet: `/pocodex/pets/${pet.id}/spritesheet.webp`,
    petJson: `/pocodex/pets/${pet.id}/pet.json`,
    sourceJson: `/pocodex/pets/${pet.id}/source.json`,
    zip: `/pocodex/downloads/${zipName}`,
    installSh: `/install/${pet.id}`,
    installPs1: `/install/${pet.id}.ps1`,
    motionSpriteLayout: undefined,
    motionSprites: undefined
  };
  pet.pixelStyle = normalizedPixelStyle(pet, style, true);
}

async function hasLocalGeneratedAssets(pet, style) {
  const petId = pet.id;
  const required = await Promise.all([
    fileExists(path.join(generatedPetDir, petId, "spritesheet.webp")),
    fileExists(path.join(generatedPetDir, petId, "preview.png")),
    fileExists(path.join(generatedPetDir, petId, "thumbnail.webp")),
    fileExists(path.join(generatedPetDir, petId, "pet.json")),
    fileExists(path.join(generatedPetDir, petId, "source.json")),
    fileExists(path.join(publicDir, "pocodex", "downloads", `${petId}.zip`))
  ]);
  return required.every(Boolean) && await localGeneratedMetadataMatches(pet, style);
}

async function hasRemoteGeneratedAssets(pet, style) {
  if (!remoteAssetOrigin) {
    return false;
  }
  const petId = pet.id;
  return Promise.all([
    remoteAssetExists(`/pocodex/pets/${petId}/spritesheet.webp`),
    remoteAssetExists(`/pocodex/pets/${petId}/preview.png`),
    remoteAssetExists(`/pocodex/pets/${petId}/thumbnail.webp`),
    remoteAssetExists(`/pocodex/pets/${petId}/pet.json`),
    remoteAssetExists(`/pocodex/pets/${petId}/source.json`),
    remoteAssetExists(`/pocodex/downloads/${petId}.zip`)
  ]).then(async (results) => results.every(Boolean) && await remoteGeneratedMetadataMatches(pet, style));
}

function applyAnimatedFallback(pet, style, sourcePet) {
  pet.assets = {
    ...pet.assets,
    preview: sourcePet.assets?.preview ?? pet.assets?.preview,
    thumbnail: sourcePet.assets?.thumbnail ?? pet.assets?.thumbnail,
    spritesheet: `/pocodex-animated-sprites/${pet.id}.webp`,
    petJson: `/pocodex/pets/${pet.id}/pet.json`,
    sourceJson: `/pocodex/pets/${pet.id}/source.json`,
    zip: sourcePet.assets?.zip ?? pet.assets?.zip,
    installSh: `/install/${pet.id}`,
    installPs1: `/install/${pet.id}.ps1`
  };
  pet.pixelStyle = normalizedPixelStyle(pet, style, false);
}

function applySourceFallback(pet, style, sourcePet) {
  pet.assets = {
    ...pet.assets,
    preview: sourcePet.assets?.preview ?? pet.assets?.preview,
    thumbnail: sourcePet.assets?.thumbnail ?? pet.assets?.thumbnail,
    spritesheet: sourcePet.assets?.spritesheet ?? pet.assets?.spritesheet,
    petJson: `/pocodex/pets/${pet.id}/pet.json`,
    sourceJson: `/pocodex/pets/${pet.id}/source.json`,
    zip: sourcePet.assets?.zip ?? pet.assets?.zip,
    installSh: `/install/${pet.id}`,
    installPs1: `/install/${pet.id}.ps1`
  };
  pet.pixelStyle = normalizedPixelStyle(pet, style, false);
}

function normalizedPixelStyle(pet, style, generatedAssets) {
  return {
    ...pet.pixelStyle,
    id: style.id,
    label: style.label,
    description: style.description,
    rendering: style.rendering ?? "auto",
    generationSource: pixelStyleGenerationSource,
    generatedAssets,
    styleFingerprint: pixelStyleFingerprint(style)
  };
}

function applyCatalogGeneratedAssets(catalogPet, manifestPet) {
  if (!catalogPet) {
    return;
  }
  catalogPet.zip = manifestPet.assets?.zip;
  catalogPet.install = manifestPet.assets?.installSh;
  catalogPet.installPowerShell = manifestPet.assets?.installPs1;
}

async function hideDuplicateVisualStyles(pets, sourceById, catalogById) {
  const bySource = new Map();
  for (const pet of pets) {
    if (pet.formGroup !== "pixel" || !isVisualReady(pet)) {
      continue;
    }
    const sourcePetId = pet.pixelStyle?.sourcePetId;
    const styleId = pixelStyleId(pet);
    if (!sourcePetId || !styleId) {
      continue;
    }
    if (!bySource.has(sourcePetId)) {
      bySource.set(sourcePetId, []);
    }
    bySource.get(sourcePetId).push(pet);
  }

  let hidden = 0;
  for (const [sourcePetId, groupPets] of bySource) {
    const seenHashes = new Map();
    const sourcePet = sourceById.get(sourcePetId);
    if (!sourcePet) {
      continue;
    }
    for (const pet of groupPets.sort(comparePixelStylePets)) {
      const hash = await localAssetHash(pet.assets?.spritesheet);
      if (!hash) {
        continue;
      }
      const previous = seenHashes.get(hash);
      if (previous) {
        const style = pixelQualityStylesById.get(pixelStyleId(pet));
        if (!style) {
          continue;
        }
        applySourceFallback(pet, style, sourcePet);
        applyCatalogGeneratedAssets(catalogById.get(pet.id), pet);
        hidden += 1;
      } else {
        seenHashes.set(hash, pet.id);
      }
    }
  }
  return hidden;
}

function isVisualReady(pet) {
  const styleId = pixelStyleId(pet);
  const generatedAssets = pet.pixelStyle?.generatedAssets === true;
  const spritesheet = normalizePublicPath(pet.assets?.spritesheet);
  const selfSheet = `/pocodex/pets/${pet.id}/spritesheet.webp`;

  if (!styleId) {
    return false;
  }
  return generatedAssets && spritesheet === selfSheet;
}

function comparePixelStylePets(a, b) {
  return pixelStyleOrder.indexOf(pixelStyleId(a)) - pixelStyleOrder.indexOf(pixelStyleId(b)) ||
    a.id.localeCompare(b.id);
}

async function localAssetHash(publicPath) {
  const diskPath = publicPathToDiskPath(publicPath);
  if (!diskPath) {
    return "";
  }
  try {
    return createHash("sha256").update(await readFile(diskPath)).digest("hex");
  } catch {
    return "";
  }
}

async function localGeneratedMetadataMatches(pet, style) {
  try {
    const sourceJson = JSON.parse(await readFile(path.join(generatedPetDir, pet.id, "source.json"), "utf8"));
    return generatedMetadataMatches(sourceJson?.pixelStyle, pet, style);
  } catch {
    return false;
  }
}

async function remoteGeneratedMetadataMatches(pet, style) {
  try {
    const sourceJson = await remoteAssetJson(`/pocodex/pets/${pet.id}/source.json`);
    return generatedMetadataMatches(sourceJson?.pixelStyle, pet, style);
  } catch {
    return false;
  }
}

function generatedMetadataMatches(pixelStyle, pet, style) {
  return pixelStyle?.id === style.id &&
    pixelStyle?.sourcePetId === pet.pixelStyle?.sourcePetId &&
    pixelStyle?.generationSource === pixelStyleGenerationSource &&
    pixelStyle?.generatedAssets === true &&
    pixelStyle?.styleFingerprint === pixelStyleFingerprint(style);
}

function normalizePublicPath(value) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value, "https://pocodex.dev").pathname;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

function publicPathToDiskPath(publicPath) {
  const cleanPath = normalizePublicPath(publicPath).replace(/^\/+/, "");
  if (!cleanPath) {
    return "";
  }
  if (cleanPath.startsWith("pocodex-animated-sprites/")) {
    return path.join(rootDir, "dist", cleanPath);
  }
  return path.join(publicDir, cleanPath);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function remoteAssetExists(assetPath) {
  if (!remoteAssetOrigin) {
    return false;
  }
  if (remoteAssetCache.has(assetPath)) {
    return remoteAssetCache.get(assetPath);
  }
  const promise = remoteHeadOk(`${remoteAssetOrigin}${assetPath}`);
  remoteAssetCache.set(assetPath, promise);
  return promise;
}

async function remoteAssetJson(assetPath) {
  const cacheKey = `json:${assetPath}`;
  if (remoteAssetCache.has(cacheKey)) {
    return remoteAssetCache.get(cacheKey);
  }
  const promise = fetch(`${remoteAssetOrigin}${assetPath}`).then(async (response) => {
    if (!response.ok) {
      throw new Error(`${assetPath} returned ${response.status}`);
    }
    return response.json();
  });
  remoteAssetCache.set(cacheKey, promise);
  return promise;
}

async function remoteHeadOk(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) {
        return true;
      }
      if (response.status === 404) {
        return false;
      }
    } catch {
      // Retry transient network failures; the deployed asset set is large.
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  return false;
}

async function mapLimit(items, limit, callback) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await callback(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function normalizeBaseUrl(value) {
  return String(value ?? "").replace(/\/+$/, "");
}
