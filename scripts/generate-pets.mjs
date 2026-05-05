import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchJson,
  generateGifPetBatch,
  slugify,
  titleCasePokemon
} from "./lib/gif-pet-generator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "config", "pokemon.json");
const petsDir = path.join(rootDir, "pets");

const treeUrl = "https://api.github.com/repos/PokeAPI/sprites/git/trees/master?recursive=1";
const animatedPath = "sprites/pokemon/versions/generation-v/black-white/animated/";
const rawAnimatedBase =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated";

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const entries = await resolvePokeApiEntries(config);

  if (config.removeLegacySeededPets !== false) {
    await removeExistingPokeApiPets();
  }

  await generateGifPetBatch({
    petsDir,
    entries,
    selectionFileName: "pocodex-pokeapi-selection.json",
    galleryFileName: "pocodex-pokeapi-preview-gallery.png",
    collection: {
      id: "pokeapi-gen5-animated",
      label: "PokeAPI B/W Animated",
      url: "https://github.com/PokeAPI/sprites",
      notes:
        "Front-facing animated Generation V Black/White GIFs from PokeAPI's sprite repository. This includes official B/W-era sprites and community-made B/W-style sprites credited by PokeAPI."
    },
    concurrency: config.concurrency ?? 4
  });
}

async function resolvePokeApiEntries(config) {
  const tree = await fetchJson(treeUrl);
  if (tree.truncated) {
    throw new Error("GitHub tree response was truncated; cannot safely enumerate PokeAPI sprites");
  }

  const files = tree.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((filePath) => filePath.startsWith(animatedPath) && filePath.endsWith(".gif"))
    .map((filePath) => filePath.slice(animatedPath.length))
    .filter((relativePath) => !relativePath.includes("/"))
    .filter((fileName) => fileName !== "substitute.gif")
    .sort(compareSpriteFiles);

  const idFilter = new Set((config.pokemonIds ?? []).map(String));
  const selectedFiles = config.includeAllAnimatedFront
    ? files
    : files.filter((fileName) => idFilter.has(String(spriteKeyFromFile(fileName))));

  const names = await getNameMaps();
  return selectedFiles.map((fileName) => {
    const sourceId = spriteKeyFromFile(fileName);
    const { sourceName, displayName } = resolveDisplayName(sourceId, names);
    const slug = `pocodex-pokeapi-${slugify(sourceId)}-${slugify(sourceName)}`;
    return {
      sourceId,
      sourceName,
      displayName,
      petDisplayName: `PokeAPI ${displayName}`,
      description: `A Codex pet generated from PokeAPI's animated B/W ${displayName} sprite.`,
      variant: "front-default",
      slug,
      gifUrl: `${rawAnimatedBase}/${fileName}`
    };
  });
}

function spriteKeyFromFile(fileName) {
  return path.basename(fileName, ".gif");
}

function resolveDisplayName(sourceId, names) {
  const [baseId, ...formParts] = String(sourceId).split("-");
  const numericBaseId = Number(baseId);
  const baseName = Number.isFinite(numericBaseId)
    ? names.species.get(numericBaseId) ?? names.pokemon.get(numericBaseId)
    : null;
  if (!baseName) {
    const sourceName = `pokemon-${sourceId}`;
    return { sourceName, displayName: titleCasePokemon(sourceName) };
  }

  if (formParts.length === 0) {
    return { sourceName: baseName, displayName: titleCasePokemon(baseName) };
  }

  const formName = formParts.join("-");
  const sourceName = `${baseName}-${formName}`;
  return { sourceName, displayName: `${titleCasePokemon(baseName)} ${titleCasePokemon(formName)}` };
}

function compareSpriteFiles(a, b) {
  const parsedA = parseSpriteKey(spriteKeyFromFile(a));
  const parsedB = parseSpriteKey(spriteKeyFromFile(b));
  if (parsedA.base !== parsedB.base) {
    return parsedA.base - parsedB.base;
  }
  return parsedA.form.localeCompare(parsedB.form);
}

function parseSpriteKey(key) {
  const [base, ...formParts] = String(key).split("-");
  const numericBase = Number(base);
  return {
    base: Number.isFinite(numericBase) ? numericBase : Number.MAX_SAFE_INTEGER,
    form: formParts.join("-")
  };
}

async function getNameMaps() {
  const [pokemon, species] = await Promise.all([
    fetchNameMap("https://pokeapi.co/api/v2/pokemon?limit=2000", "pokemon"),
    fetchNameMap("https://pokeapi.co/api/v2/pokemon-species?limit=2000", "pokemon-species")
  ]);
  return { pokemon, species };
}

async function fetchNameMap(url, label) {
  const response = await fetch(url, { headers: { "User-Agent": "pocodex-builder" } });
  if (!response.ok) {
    throw new Error(`PokeAPI ${label} name lookup failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const names = new Map();
  for (const result of payload.results) {
    const match = result.url.match(/\/pokemon\/(\d+)\/?$/);
    const speciesMatch = result.url.match(/\/pokemon-species\/(\d+)\/?$/);
    const id = Number(match?.[1] ?? speciesMatch?.[1]);
    if (Number.isFinite(id)) {
      names.set(id, result.name);
    }
  }
  return names;
}

async function removeExistingPokeApiPets() {
  let entries;
  try {
    entries = await readdir(petsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith("pocodex-pokeapi-")) {
      await rm(path.join(petsDir, entry.name), { recursive: true, force: true });
      continue;
    }
    if (entry.name.startsWith("pocodex-pmd-") || entry.name.startsWith("pocodex-showdown-")) {
      continue;
    }
    const petDir = path.join(petsDir, entry.name);
    try {
      const source = JSON.parse(await readFile(path.join(petDir, "source.json"), "utf8"));
      if (source.spriteSource === "PokeAPI/sprites" || source.sourceFamily === "pokeapi-gen5-animated") {
        await rm(petDir, { recursive: true, force: true });
      }
    } catch {
      // Keep unknown folders; only clean generated legacy PokeAPI pets with recognizable provenance.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
