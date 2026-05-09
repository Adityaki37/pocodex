import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  pixelQualityStyles,
  pixelQualityStylesById,
  pixelStyleGenerationSource,
  pixelStyleId
} from "./lib/pixel-style-generation.mjs";

sharp.cache(false);
sharp.concurrency(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "public", "pocodex", "manifest.json");
const reportPath = path.join(rootDir, "output", "pixel-style-rendering-audit.json");
const expectedStyleIds = pixelQualityStyles.map((style) => style.id);

await main();

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const petsById = new Map(manifest.pets.map((pet) => [pet.id, pet]));
  const pixelPets = manifest.pets.filter((pet) => pet.formGroup === "pixel");
  const groups = groupPixelPets(pixelPets);
  const missing = [];
  const duplicateSpritesheets = [];
  const duplicatePreviews = [];
  const metadataMismatches = [];
  let checkedAssets = 0;

  for (const group of groups) {
    const sourcePet = petsById.get(group.sourcePetId);
    if (!sourcePet) {
      metadataMismatches.push({
        sourcePetId: group.sourcePetId,
        problem: "missing source pet"
      });
      continue;
    }

    for (const styleId of expectedStyleIds) {
      if (!group.byStyle.has(styleId)) {
        missing.push({
          sourcePetId: group.sourcePetId,
          missingStyleId: styleId
        });
      }
    }

    const rendered = [];
    for (const styleId of expectedStyleIds) {
      const pet = group.byStyle.get(styleId);
      if (!pet) {
        continue;
      }

      const style = pixelQualityStylesById.get(styleId);
      const expectedFingerprint = style ? pixelStyleFingerprint(style) : "";
      const styleMeta = pet.pixelStyle ?? {};
      if (
        styleMeta.sourcePetId !== group.sourcePetId ||
        styleMeta.generationSource !== pixelStyleGenerationSource ||
        styleMeta.generatedAssets !== true ||
        styleMeta.styleFingerprint !== expectedFingerprint
      ) {
        metadataMismatches.push({
          sourcePetId: group.sourcePetId,
          petId: pet.id,
          styleId,
          expectedFingerprint,
          actualFingerprint: styleMeta.styleFingerprint ?? null,
          generatedAssets: styleMeta.generatedAssets ?? null,
          generationSource: styleMeta.generationSource ?? null
        });
      }

      const spritesheetPath = assetPath(pet.assets?.spritesheet);
      const previewPath = assetPath(pet.assets?.preview);
      const thumbnailPath = assetPath(pet.assets?.thumbnail);
      const sourceJsonPath = assetPath(pet.assets?.sourceJson);
      const petJsonPath = assetPath(pet.assets?.petJson);
      const zipPath = assetPath(pet.assets?.zip);

      const requiredFiles = [
        ["spritesheet", spritesheetPath],
        ["preview", previewPath],
        ["thumbnail", thumbnailPath],
        ["sourceJson", sourceJsonPath],
        ["petJson", petJsonPath],
        ["zip", zipPath]
      ];
      const missingFiles = [];
      for (const [label, filePath] of requiredFiles) {
        if (!filePath || !(await fileExists(filePath))) {
          missingFiles.push(label);
        }
      }
      if (missingFiles.length > 0) {
        missing.push({
          sourcePetId: group.sourcePetId,
          petId: pet.id,
          styleId,
          missingFiles
        });
        continue;
      }

      const [spritesheetHash, previewHash] = await Promise.all([
        renderedImageHash(spritesheetPath),
        renderedImageHash(previewPath)
      ]);
      checkedAssets += 2;
      rendered.push({
        petId: pet.id,
        styleId,
        spritesheetHash,
        previewHash
      });
    }

    duplicateSpritesheets.push(...findDuplicateHashes(group.sourcePetId, rendered, "spritesheetHash"));
    duplicatePreviews.push(...findDuplicateHashes(group.sourcePetId, rendered, "previewHash"));
  }

  const report = {
    manifest: path.relative(rootDir, manifestPath).replace(/\\/g, "/"),
    expectedStyleIds,
    sourcePokemonChecked: groups.length,
    pixelPetsChecked: pixelPets.length,
    renderedAssetsDecoded: checkedAssets,
    missing,
    metadataMismatches,
    duplicateSpritesheets,
    duplicatePreviews
  };

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Pixel style rendering audit checked ${groups.length} Pokemon groups and ${pixelPets.length} pixel-style pets.`);
  console.log(`Decoded ${checkedAssets} rendered image assets.`);
  console.log(`Report: ${path.relative(rootDir, reportPath)}`);

  const failures =
    missing.length +
    metadataMismatches.length +
    duplicateSpritesheets.length +
    duplicatePreviews.length;
  if (failures > 0) {
    console.error(JSON.stringify({
      missing: missing.length,
      metadataMismatches: metadataMismatches.length,
      duplicateSpritesheets: duplicateSpritesheets.length,
      duplicatePreviews: duplicatePreviews.length
    }, null, 2));
    process.exitCode = 1;
  }
}

function groupPixelPets(pixelPets) {
  const groups = new Map();
  for (const pet of pixelPets) {
    const sourcePetId = pet.pixelStyle?.sourcePetId;
    const styleId = pixelStyleId(pet);
    if (!sourcePetId) {
      continue;
    }
    if (!groups.has(sourcePetId)) {
      groups.set(sourcePetId, { sourcePetId, byStyle: new Map() });
    }
    groups.get(sourcePetId).byStyle.set(styleId, pet);
  }
  return [...groups.values()].sort((a, b) => a.sourcePetId.localeCompare(b.sourcePetId));
}

async function renderedImageHash(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return createHash("sha256")
    .update(`${info.width}x${info.height}x${info.channels}:`)
    .update(data)
    .digest("hex");
}

function findDuplicateHashes(sourcePetId, rendered, hashKey) {
  const byHash = new Map();
  for (const item of rendered) {
    const hash = item[hashKey];
    if (!byHash.has(hash)) {
      byHash.set(hash, []);
    }
    byHash.get(hash).push({
      petId: item.petId,
      styleId: item.styleId
    });
  }
  return [...byHash.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({ sourcePetId, styles: items }));
}

function assetPath(urlPath) {
  if (!urlPath) {
    return null;
  }
  const clean = String(urlPath).replace(/^\/+/, "");
  return path.join(rootDir, "public", clean);
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function pixelStyleFingerprint(style) {
  return createHash("sha256").update(stableStringify(style)).digest("hex").slice(0, 16);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
