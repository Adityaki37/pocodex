import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const petsDir = path.join(rootDir, "pets");
const codexPetsDir = path.join(os.homedir(), ".codex", "pets");

async function main() {
  await mkdir(codexPetsDir, { recursive: true });
  const entries = await readdir(petsDir, { withFileTypes: true });
  const petDirs = await resolvePetDirs(entries);

  if (petDirs.length === 0) {
    throw new Error(`No pet directories found in ${petsDir}`);
  }

  await removePreviouslyInstalledPocodexPets();

  const installed = [];
  for (const petDir of petDirs) {
    const petJsonPath = path.join(petDir, "pet.json");
    const petJson = JSON.parse(await readFile(petJsonPath, "utf8"));
    const targetDir = path.join(codexPetsDir, petJson.id);
    await mkdir(targetDir, { recursive: true });

    for (const fileName of ["pet.json", "spritesheet.webp", "source.json", "preview.png"]) {
      await copyFile(path.join(petDir, fileName), path.join(targetDir, fileName));
    }
    installed.push({ id: petJson.id, displayName: petJson.displayName });
  }

  await writeFile(
    path.join(codexPetsDir, "pocodex-installed.json"),
    `${JSON.stringify(
      {
        installedAt: new Date().toISOString(),
        sourceProject: rootDir,
        pets: installed
      },
      null,
      2
    )}\n`
  );

  for (const pet of installed) {
    console.log(`Installed ${pet.displayName} -> ${path.join(codexPetsDir, pet.id)}`);
  }
  console.log(`Installed ${installed.length} Pocodex pets into ${codexPetsDir}`);
}

async function resolvePetDirs(entries) {
  const petDirs = [];
  const skippedIncomplete = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const petDir = path.join(petsDir, entry.name);
    if (await fileExists(path.join(petDir, "pet.json"))) {
      petDirs.push(petDir);
    } else {
      skippedIncomplete.push(entry.name);
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

async function removePreviouslyInstalledPocodexPets() {
  let entries = [];
  try {
    entries = await readdir(codexPetsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("pocodex-")) {
      await rm(path.join(codexPetsDir, entry.name), { recursive: true, force: true });
    }
  }

  const manifestPath = path.join(codexPetsDir, "pocodex-installed.json");
  let previous;
  try {
    previous = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return;
  }

  for (const pet of previous.pets ?? []) {
    if (typeof pet.id === "string" && pet.id.startsWith("pocodex-")) {
      await rm(path.join(codexPetsDir, pet.id), { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
