import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const petsDir = path.join(rootDir, "pets");
const expectedWidth = 1536;
const expectedHeight = 1872;
const columns = 8;
const rows = 9;
const minVisiblePixels = 600;
const usedColumnsByRow = [6, 8, 8, 4, 5, 8, 6, 6, 6];

async function main() {
  const requestedIds = parseRequestedIds(process.argv.slice(2));
  const entries = await readdir(petsDir, { withFileTypes: true });
  const petDirs = await resolvePetDirs(entries, requestedIds);
  if (petDirs.length === 0) {
    const target = requestedIds.size > 0 ? ` matching ${[...requestedIds].join(", ")}` : "";
    throw new Error(`No pet directories${target} found in ${petsDir}`);
  }

  const results = [];
  for (const petDir of petDirs) {
    results.push(await validatePet(petDir));
  }

  for (const result of results) {
    console.log(
      `PASS ${result.id}: ${result.usedCells} used cells populated, ${result.unusedCells} unused cells transparent, ${result.width}x${result.height}`
    );
  }
  console.log(`Validated ${results.length} pet packs.`);
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
    if (arg.startsWith("--pet=")) {
      addIds(ids, arg.slice("--pet=".length));
      continue;
    }
    if ((arg === "--id" || arg === "--pet") && args[index + 1] && !args[index + 1].startsWith("-")) {
      addIds(ids, args[index + 1]);
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      addIds(ids, arg);
    }
  }
  return ids;
}

function addIds(ids, rawValue) {
  for (const id of rawValue.split(",").map((value) => value.trim()).filter(Boolean)) {
    ids.add(id);
  }
}

async function resolvePetDirs(entries, requestedIds) {
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
      continue;
    }

    if (requestedIds.size > 0) {
      throw new Error(`Requested pet "${entry.name}" is missing pet.json in ${petDir}`);
    }
    skippedIncomplete.push(entry.name);
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

async function validatePet(petDir) {
  const petJsonPath = path.join(petDir, "pet.json");
  const petJson = JSON.parse(await readFile(petJsonPath, "utf8"));
  for (const field of ["id", "displayName", "description", "spritesheetPath"]) {
    if (!petJson[field] || typeof petJson[field] !== "string") {
      throw new Error(`${petJsonPath} is missing string field "${field}"`);
    }
  }

  const spritesheetPath = path.join(petDir, petJson.spritesheetPath);
  await access(spritesheetPath);
  const fileInfo = await stat(spritesheetPath);
  if (fileInfo.size < 1024) {
    throw new Error(`${spritesheetPath} is unexpectedly small`);
  }

  const metadata = await sharp(spritesheetPath).metadata();
  if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
    throw new Error(
      `${spritesheetPath} must be ${expectedWidth}x${expectedHeight}; got ${metadata.width}x${metadata.height}`
    );
  }

  const frameWidth = metadata.width / columns;
  const frameHeight = metadata.height / rows;
  let usedCells = 0;
  let unusedCells = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const raw = await sharp(spritesheetPath)
        .extract({
          left: column * frameWidth,
          top: row * frameHeight,
          width: frameWidth,
          height: frameHeight
        })
        .ensureAlpha()
        .raw()
        .toBuffer();
      const stats = inspectCell(raw, frameWidth, frameHeight);
      const isUsedCell = column < usedColumnsByRow[row];
      if (isUsedCell && stats.visible < minVisiblePixels) {
        throw new Error(`${spritesheetPath} cell row ${row}, column ${column} has only ${stats.visible} visible pixels`);
      }
      if (!isUsedCell && stats.visible > 0) {
        throw new Error(`${spritesheetPath} unused cell row ${row}, column ${column} is not transparent`);
      }
      if (isUsedCell && stats.edgeVisible > 0) {
        throw new Error(`${spritesheetPath} cell row ${row}, column ${column} has visible pixels touching the edge`);
      }
      if (isUsedCell) {
        usedCells += 1;
      } else {
        unusedCells += 1;
      }
    }
  }

  return {
    id: petJson.id,
    width: metadata.width,
    height: metadata.height,
    usedCells,
    unusedCells
  };
}

function inspectCell(raw, width, height) {
  let visible = 0;
  let edgeVisible = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = raw[(y * width + x) * 4 + 3];
      if (alpha <= 8) {
        continue;
      }
      visible += 1;
      if (x < 2 || x >= width - 2 || y < 2 || y >= height - 2) {
        edgeVisible += 1;
      }
    }
  }
  return { visible, edgeVisible };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
