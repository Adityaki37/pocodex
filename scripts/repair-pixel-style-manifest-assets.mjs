import { access, readFile, writeFile } from "node:fs/promises";
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

await main();

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const catalogById = new Map(catalog.map((pet) => [pet.id, pet]));
  const sourceById = new Map(manifest.pets.filter((pet) => pet.formGroup !== "pixel").map((pet) => [pet.id, pet]));

  const stats = {
    pixelPets: 0,
    generatedPetAssets: 0,
    animatedSprites: 0,
    sourceFallbacks: 0
  };

  for (const pet of manifest.pets) {
    if (pet.formGroup !== "pixel") {
      continue;
    }
    stats.pixelPets += 1;
    const styleId = pixelStyleId(pet);
    const style = pixelQualityStylesById.get(styleId);
    const sourcePet = sourceById.get(pet.pixelStyle?.sourcePetId);
    if (!style || !sourcePet) {
      continue;
    }

    const generatedPath = path.join(generatedPetDir, pet.id, "spritesheet.webp");
    const animatedPath = path.join(animatedSpriteDir, `${pet.id}.webp`);

    if (await fileExists(generatedPath)) {
      await applyGeneratedPetAssets(pet, style, sourcePet);
      applyCatalogGeneratedAssets(catalogById.get(pet.id), pet);
      stats.generatedPetAssets += 1;
    } else if (await fileExists(animatedPath)) {
      applyAnimatedSpritesheet(pet, style, sourcePet);
      applyCatalogGeneratedAssets(catalogById.get(pet.id), pet);
      stats.animatedSprites += 1;
    } else {
      applySourceFallback(pet, style, sourcePet);
      applyCatalogGeneratedAssets(catalogById.get(pet.id), pet);
      stats.sourceFallbacks += 1;
    }
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
  console.log(JSON.stringify(stats, null, 2));
}

async function applyGeneratedPetAssets(pet, style, sourcePet) {
  const zipName = `${pet.id}.zip`;
  const preview = await fileExists(path.join(generatedPetDir, pet.id, "preview.png"))
    ? `/pocodex/pets/${pet.id}/preview.png`
    : sourcePet.assets?.preview ?? pet.assets?.preview;
  const thumbnail = await fileExists(path.join(generatedPetDir, pet.id, "thumbnail.webp"))
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
    installPs1: `/install/${pet.id}.ps1`
  };
  pet.pixelStyle = normalizedPixelStyle(pet, style, true);
}

function applyAnimatedSpritesheet(pet, style, sourcePet) {
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
  pet.pixelStyle = normalizedPixelStyle(pet, style, true);
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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
