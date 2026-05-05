import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchText,
  generateGifPetBatch,
  slugify,
  titleCasePokemon
} from "./lib/gif-pet-generator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const petsDir = path.join(rootDir, "pets");

const indexUrl = "https://play.pokemonshowdown.com/sprites/ani/";

async function main() {
  const entries = await resolveShowdownEntries();
  await generateGifPetBatch({
    petsDir,
    entries,
    selectionFileName: "pocodex-showdown-selection.json",
    galleryFileName: "pocodex-showdown-preview-gallery.png",
    collection: {
      id: "showdown-ani",
      label: "Showdown Animated",
      url: "https://play.pokemonshowdown.com/sprites/ani/",
      notes:
        "Front-facing animated battle GIFs from Pokemon Showdown's public sprite directory, maintained by the Smogon/Pokemon Showdown sprite community."
    },
    concurrency: 4
  });
}

async function resolveShowdownEntries() {
  const html = await fetchText(indexUrl);
  const fileNames = [...html.matchAll(/href="\.\/([^"]+\.gif)"/g)]
    .map((match) => decodeURIComponent(match[1]))
    .filter((fileName) => !fileName.startsWith("."))
    .sort((a, b) => a.localeCompare(b));

  return fileNames.map((fileName) => {
    const sourceName = path.basename(fileName, ".gif");
    const displayName = titleCasePokemon(sourceName);
    const slug = `pocodex-showdown-${slugify(sourceName)}`;
    return {
      sourceId: sourceName,
      sourceName,
      displayName,
      petDisplayName: `Showdown ${displayName}`,
      description: `A Codex pet generated from Pokemon Showdown's animated ${displayName} battle sprite.`,
      variant: "front-default",
      slug,
      gifUrl: new URL(fileName, indexUrl).toString()
    };
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
