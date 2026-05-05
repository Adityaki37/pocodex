import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const manifestPath = path.join(rootDir, "public", "pocodex", "manifest.json");
const pmdSelectionPath = path.join(rootDir, "pets", "pocodex-pmd-selection.json");
const rawSelectionPath = path.join(rootDir, "pets", "pocodex-pmd-rawasset-selection.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const pmdSelection = JSON.parse(await readFile(pmdSelectionPath, "utf8"));
const rawSelection = JSON.parse(await readFile(rawSelectionPath, "utf8"));

const nonPixelPets = (manifest.pets ?? []).filter((pet) => pet.formGroup !== "pixel");
const pokemonGroups = new Map();
for (const pet of nonPixelPets) {
  const key = String(pet.number).padStart(4, "0");
  if (!pokemonGroups.has(key)) {
    pokemonGroups.set(key, []);
  }
  pokemonGroups.get(key).push(pet);
}

const noBaseGroups = [];
for (const [id, pets] of pokemonGroups) {
  const hasBase = pets.some((pet) => pet.formGroup === "base" || (pet.formLabel ?? "Base") === "Base");
  if (!hasBase) {
    noBaseGroups.push({
      id,
      name: pets[0]?.displayName ?? id,
      forms: pets.map((pet) => ({
        id: pet.id,
        formLabel: pet.formLabel,
        formGroup: pet.formGroup
      }))
    });
  }
}

const skippedBaseIds = new Set((pmdSelection.skippedBasePokemon ?? []).map((pet) => pet.id));
const restoredFallbacks = (rawSelection.pets ?? []).filter((pet) => skippedBaseIds.has(pet.id) && pet.path === `Sprite/${pet.id}`);
const skippedFallbacks = (rawSelection.skippedPets ?? []).filter((pet) => skippedBaseIds.has(pet.id) && pet.path === `Sprite/${pet.id}`);

const expectedStyleIds = ["original-unchanged", "scale2x", "epx", "plain-xbrz", "hq4x"];
const pixelPets = (manifest.pets ?? []).filter((pet) => pet.formGroup === "pixel");
const missingStyleSets = [];
for (const pet of nonPixelPets) {
  const missing = expectedStyleIds.filter(
    (styleId) =>
      !pixelPets.some((pixelPet) => pixelPet.pixelStyle?.sourcePetId === pet.id && pixelPet.pixelStyle?.id === styleId)
  );
  if (missing.length) {
    missingStyleSets.push({ id: pet.id, name: pet.displayName, missing });
  }
}

console.log(
  JSON.stringify(
    {
      pokemonGroups: pokemonGroups.size,
      nonPixelPets: nonPixelPets.length,
      pixelPets: pixelPets.length,
      restoredPmdSkippedBases: restoredFallbacks.length,
      stillMissingPmdSkippedBases: skippedFallbacks.length,
      noBaseGroups,
      missingStyleSets
    },
    null,
    2
  )
);

if (missingStyleSets.length > 0) {
  process.exitCode = 1;
}
