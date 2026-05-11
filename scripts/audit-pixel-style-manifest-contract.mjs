import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "public", "pocodex", "manifest.json");
const reportPath = path.join(rootDir, "output", "pixel-style-manifest-contract.json");

const stylesThatMayUseAnimatedSprites = new Set(["original-unchanged", "scale2x", "epx"]);
const generatedOnlyStyles = new Set(["plain-xbrz", "hq4x"]);

await main();

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const petsById = new Map(manifest.pets.map((pet) => [pet.id, pet]));
  const failures = [];
  const summary = {
    pixelPets: 0,
    visualReady: 0,
    hiddenFallbacks: 0,
    generatedPetAssets: 0,
    animatedSprites: 0,
    sourceFallbacks: 0
  };

  for (const pet of manifest.pets) {
    if (pet.formGroup !== "pixel") {
      continue;
    }

    summary.pixelPets += 1;
    const styleId = pixelStyleId(pet);
    const sourcePetId = pet.pixelStyle?.sourcePetId;
    const generatedAssets = pet.pixelStyle?.generatedAssets === true;
    const spritesheet = normalizePublicPath(pet.assets?.spritesheet);
    const expectedPetSheet = `/pocodex/pets/${pet.id}/spritesheet.webp`;
    const expectedAnimatedSheet = `/pocodex-animated-sprites/${pet.id}.webp`;
    const sourcePet = petsById.get(sourcePetId);
    const sourceSheet = normalizePublicPath(sourcePet?.assets?.spritesheet);
    const usesGeneratedPetAsset = spritesheet === expectedPetSheet;
    const usesAnimatedSprite = spritesheet === expectedAnimatedSheet;
    const usesSourceFallback = sourceSheet && spritesheet === sourceSheet;
    const visualReady = isVisualReady(pet);

    if (visualReady) {
      summary.visualReady += 1;
    } else {
      summary.hiddenFallbacks += 1;
    }
    if (usesGeneratedPetAsset) {
      summary.generatedPetAssets += 1;
    } else if (usesAnimatedSprite) {
      summary.animatedSprites += 1;
    } else if (usesSourceFallback) {
      summary.sourceFallbacks += 1;
    }

    if (!styleId || !sourcePetId || !sourcePet) {
      failures.push({
        petId: pet.id,
        reason: "pixel pet is missing style/source metadata"
      });
      continue;
    }

    if (generatedAssets && usesSourceFallback) {
      failures.push({
        petId: pet.id,
        styleId,
        spritesheet,
        reason: "generated pixel style points at the source pet spritesheet"
      });
    }

    if (generatedOnlyStyles.has(styleId)) {
      if (visualReady && !usesGeneratedPetAsset) {
        failures.push({
          petId: pet.id,
          styleId,
          spritesheet,
          reason: "HQ/xBRZ visual style must use its own generated pet asset"
        });
      }
      if (!visualReady && generatedAssets) {
        failures.push({
          petId: pet.id,
          styleId,
          spritesheet,
          reason: "HQ/xBRZ fallback should not be marked generated"
        });
      }
      continue;
    }

    if (stylesThatMayUseAnimatedSprites.has(styleId) && visualReady && !usesGeneratedPetAsset && !usesAnimatedSprite) {
      failures.push({
        petId: pet.id,
        styleId,
        spritesheet,
        reason: "visual-ready pixel style must use generated pet or animated spritesheet asset"
      });
    }
  }

  const missingAssets = await findMissingVisualAssets(manifest.pets);
  failures.push(...missingAssets);

  const report = {
    manifest: path.relative(rootDir, manifestPath),
    summary,
    failures
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Pixel style manifest contract checked ${summary.pixelPets} pixel pets.`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Report: ${path.relative(rootDir, reportPath)}`);

  if (failures.length > 0) {
    console.error(`Pixel style manifest contract found ${failures.length} failure(s).`);
    process.exitCode = 1;
  }
}

function isVisualReady(pet) {
  const styleId = pixelStyleId(pet);
  const generatedAssets = pet.pixelStyle?.generatedAssets === true;
  const spritesheet = normalizePublicPath(pet.assets?.spritesheet);
  const selfSheet = `/pocodex/pets/${pet.id}/spritesheet.webp`;
  const animatedSheet = `/pocodex-animated-sprites/${pet.id}.webp`;

  if (!styleId) {
    return false;
  }
  if (styleId === "original-unchanged") {
    return true;
  }
  if (generatedOnlyStyles.has(styleId)) {
    return generatedAssets && spritesheet === selfSheet;
  }
  return generatedAssets && (spritesheet === selfSheet || spritesheet === animatedSheet);
}

function pixelStyleId(pet) {
  return pet.pixelStyle?.styleId ?? pet.pixelStyle?.id ?? "";
}

async function findMissingVisualAssets(pets) {
  const failures = [];
  for (const pet of pets) {
    if (pet.formGroup !== "pixel" || !isVisualReady(pet)) {
      continue;
    }
    const spritesheet = normalizePublicPath(pet.assets?.spritesheet);
    if (!spritesheet) {
      failures.push({
        petId: pet.id,
        reason: "visual-ready pixel pet is missing a spritesheet"
      });
      continue;
    }
    try {
      await access(publicPathToDiskPath(spritesheet));
    } catch {
      failures.push({
        petId: pet.id,
        spritesheet,
        reason: "visual-ready pixel pet references a missing spritesheet"
      });
    }
  }
  return failures;
}

function normalizePublicPath(value) {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value, "https://pocodex.dev");
    return url.pathname;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

function publicPathToDiskPath(publicPath) {
  const cleanPath = publicPath.replace(/^\/+/, "");
  if (cleanPath.startsWith("pocodex-animated-sprites/")) {
    return path.join(rootDir, "dist", cleanPath);
  }
  return path.join(rootDir, "public", cleanPath);
}
