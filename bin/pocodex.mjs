#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";
import sharp from "sharp";

const VERSION = "0.1.0";
const DEFAULT_BASE_URL = process.env.POCODEX_URL ?? "https://pocodex.dev";
const frameWidth = 192;
const frameHeight = 208;
const atlasRows = 9;
const previewScale = 0.5;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const spriteWebpOptions = {
  quality: 35,
  alphaQuality: 70,
  effort: 6,
  smartSubsample: true
};
const codexPetStates = [
  { id: "idle", label: "Idle", row: 0, frames: 6, durationMs: 1100 },
  { id: "running-right", label: "Run Right", row: 1, frames: 8, durationMs: 1060 },
  { id: "running-left", label: "Run Left", row: 2, frames: 8, durationMs: 1060 },
  { id: "waving", label: "Waving", row: 3, frames: 4, durationMs: 700 },
  { id: "jumping", label: "Jumping", row: 4, frames: 5, durationMs: 840 },
  { id: "failed", label: "Failed", row: 5, frames: 8, durationMs: 1220 },
  { id: "waiting", label: "Waiting", row: 6, frames: 6, durationMs: 1010 },
  { id: "running", label: "Running", row: 7, frames: 6, durationMs: 820 },
  { id: "review", label: "Review", row: 8, frames: 6, durationMs: 1030 }
];
const pixelInstallStyles = new Map([
  ["original-unchanged", { id: "original-unchanged" }],
  ["pixel-nearest", { id: "pixel-nearest", pixelate: 0.5 }],
  [
    "inked-crisp",
    {
      id: "inked-crisp",
      sharpen: { sigma: 0.72, m1: 0.45, m2: 2.35, x1: 2.2, y2: 8, y3: 24 },
      modulate: { saturation: 1.1 },
      linear: { a: 1.1, b: -8 }
    }
  ],
  [
    "polished-pixel",
    {
      id: "polished-pixel",
      blur: 0.3,
      sharpen: { sigma: 0.5, m1: 0.35, m2: 1.45, x1: 2.8, y2: 8, y3: 14 },
      modulate: { saturation: 1.06 },
      linear: { a: 1.04, b: -3 }
    }
  ],
  [
    "hq4x",
    {
      id: "hq4x",
      resample: { factor: 4, upKernel: "cubic", downKernel: "mitchell" },
      blur: 0.3,
      sharpen: { sigma: 0.42, m1: 0.25, m2: 1.2, x1: 2.2, y2: 6, y3: 10 },
      modulate: { saturation: 1.04 },
      linear: { a: 1.03, b: -2 }
    }
  ],
  [
    "xbrz",
    {
      id: "xbrz",
      resample: { factor: 4, upKernel: "lanczos3", downKernel: "mks2021" },
      blur: 0.3,
      sharpen: { sigma: 0.55, m1: 0.36, m2: 1.65, x1: 2.4, y2: 7, y3: 15 },
      modulate: { saturation: 1.08 },
      linear: { a: 1.07, b: -5 }
    }
  ]
]);

main().catch((error) => {
  console.error(`pocodex: ${error.message}`);
  process.exit(1);
});

async function main() {
  const { args, options } = parseArgs(process.argv.slice(2));
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  if (command === "list") {
    await listPets(options);
    return;
  }

  if (command === "install") {
    await installCommand(args.slice(1), options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`
  pocodex ${VERSION} - Codex Pokemon pet gallery CLI

  Usage
    pocodex <command> [args]

  Commands
    install <slug>     Install one pet into ~/.codex/pets/<slug>
    install all        Install every pet variation in the catalog
    list               Print available pet slugs
    --version          Print the CLI version

  Options
    --url <origin>       Pocodex site URL (default: ${DEFAULT_BASE_URL})
    --codex-home <path>  Codex home folder (default: CODEX_HOME or ~/.codex)
    --speed <0.5-2.0>    Animation speed metadata written into installed pets

  Examples
    pocodex install pocodex-pmd-pikachu
    pocodex install all --url http://127.0.0.1:5173
`.trim());
}

function parseArgs(argv) {
  const args = [];
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    codexHome: process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
    animationSpeed: normalizeAnimationSpeed(process.env.POCODEX_ANIMATION_SPEED)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url" && argv[index + 1]) {
      options.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      options.baseUrl = arg.slice("--url=".length);
      continue;
    }
    if (arg === "--codex-home" && argv[index + 1]) {
      options.codexHome = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--codex-home=")) {
      options.codexHome = arg.slice("--codex-home=".length);
      continue;
    }
    if (arg === "--speed" && argv[index + 1]) {
      options.animationSpeed = parseAnimationSpeed(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--speed=")) {
      options.animationSpeed = parseAnimationSpeed(arg.slice("--speed=".length));
      continue;
    }
    args.push(arg);
  }

  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  options.codexHome = path.resolve(options.codexHome);
  return { args, options };
}

async function installCommand(args, options) {
  const target = args[0];
  if (!target) {
    throw new Error("Usage: pocodex install <slug|all>");
  }

  const catalog = await fetchCatalog(options.baseUrl);
  if (target === "all") {
    console.log(`Installing ${catalog.length} Pocodex pet variations into ${path.join(options.codexHome, "pets")}`);
    let installed = 0;
    for (const pet of catalog) {
      await installPet(pet, options);
      installed += 1;
      if (installed % 50 === 0 || installed === catalog.length) {
        console.log(`Installed ${installed}/${catalog.length}`);
      }
    }
    return;
  }

  const pet = catalog.find((entry) => entry.id === target);
  if (!pet) {
    throw new Error(`No pet with slug "${target}". Run "pocodex list" to browse available slugs.`);
  }

  await installPet(pet, options);
}

async function listPets(options) {
  const catalog = await fetchCatalog(options.baseUrl);
  for (const pet of catalog) {
    const form = pet.form && pet.form !== "Base" ? ` (${pet.form})` : "";
    console.log(`${pet.id.padEnd(48)} ${pet.displayName}${form}`);
  }
  console.log(`\n${catalog.length} pet variations. Install with: pocodex install <slug>`);
}

async function fetchCatalog(baseUrl) {
  const res = await fetch(joinUrl(baseUrl, "/pocodex/catalog.json"));
  if (!res.ok) {
    throw new Error(`catalog fetch failed: ${res.status}`);
  }
  const catalog = await res.json();
  if (!Array.isArray(catalog)) {
    throw new Error("catalog response was not an array");
  }
  return catalog;
}

async function installPet(pet, options) {
  if (!pet?.id) {
    throw new Error("catalog entry is missing id");
  }

  const dest = path.join(options.codexHome, "pets", pet.id);
  await mkdir(dest, { recursive: true });
  await downloadPetFiles(pet, options, dest);
  const sourceJson = await overlayPetMetadata(pet, options, dest);
  await applyPixelStyleToInstalledPet(sourceJson, dest);
  await applyAnimationSpeedToInstalledPet(dest, options.animationSpeed);
  console.log(`Installed ${pet.displayName ?? pet.id} to ${dest}`);
}

async function downloadPetFiles(pet, options, dest) {
  for (const fileName of ["pet.json", "spritesheet.webp"]) {
    await downloadRequiredFile(joinUrl(options.baseUrl, `/pocodex/pets/${pet.id}/${fileName}`), path.join(dest, fileName));
  }
  for (const fileName of ["source.json", "preview.png", "thumbnail.webp"]) {
    await downloadOptionalFile(joinUrl(options.baseUrl, `/pocodex/pets/${pet.id}/${fileName}`), path.join(dest, fileName));
  }
}

async function downloadRequiredFile(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed for ${url}: ${res.status}`);
  }
  await writeFile(outputPath, Buffer.from(await res.arrayBuffer()));
}

async function downloadOptionalFile(url, outputPath) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      await writeFile(outputPath, Buffer.from(await res.arrayBuffer()));
    }
  } catch {
    // Optional preview assets are nice to have, but Codex only needs pet.json and spritesheet.webp.
  }
}

async function applyAnimationSpeedToInstalledPet(dest, speed) {
  const petJsonPath = path.join(dest, "pet.json");
  const petJson = JSON.parse(await readFile(petJsonPath, "utf8"));
  await writeFile(petJsonPath, `${JSON.stringify(applyAnimationSpeedToPetJson(petJson, speed), null, 2)}\n`);
}

function applyAnimationSpeedToPetJson(petJson, speed) {
  const animationSpeed = normalizeAnimationSpeed(speed);
  const animationDurationsMs = {};
  const states = codexPetStates.map((state) => {
    const durationMs = Math.max(1, Math.round(state.durationMs / animationSpeed));
    animationDurationsMs[state.id] = durationMs;
    animationDurationsMs[normalizeStateAlias(state.id)] = durationMs;
    return { ...state, durationMs };
  });
  return {
    ...petJson,
    states,
    animationSpeed,
    animationFrameMs: Math.max(1, Math.round(120 / animationSpeed)),
    animationDurationsMs
  };
}

function normalizeStateAlias(stateId) {
  if (stateId === "running-right") {
    return "run-right";
  }
  if (stateId === "running-left") {
    return "run-left";
  }
  return stateId;
}

function parseAnimationSpeed(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error("--speed must be a positive number");
  }
  return normalizeAnimationSpeed(speed);
}

function normalizeAnimationSpeed(value) {
  const speed = Number(value);
  return Math.min(2, Math.max(0.5, Number.isFinite(speed) ? speed : 1));
}

async function overlayPetMetadata(pet, options, dest) {
  if (pet.formGroup !== "pixel") {
    return null;
  }

  let sourceJson = null;
  for (const fileName of ["pet.json", "source.json"]) {
    const text = await fetchOptionalText(joinUrl(options.baseUrl, `/pocodex/pets/${pet.id}/${fileName}`));
    if (!text) {
      continue;
    }
    await writeFile(path.join(dest, fileName), text);
    if (fileName === "source.json") {
      sourceJson = JSON.parse(text);
    }
  }
  return sourceJson;
}

async function fetchOptionalText(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function applyPixelStyleToInstalledPet(sourceJson, dest) {
  const styleId = sourceJson?.pixelStyle?.id;
  const style = pixelInstallStyles.get(styleId);
  if (!style || style.id === "original-unchanged" || sourceJson?.pixelStyle?.generatedAssets === true) {
    return;
  }

  const spritesheetPath = path.join(dest, "spritesheet.webp");
  await writePixelStyleImage(spritesheetPath, spritesheetPath, style);
  await writeInstalledPreview(spritesheetPath, path.join(dest, "preview.png"));
  await writeInstalledThumbnail(spritesheetPath, path.join(dest, "thumbnail.webp"));
}

async function writePixelStyleImage(inputPath, outputPath, style) {
  const metadata = await sharp(inputPath).metadata();
  const targetWidth = metadata.width;
  const targetHeight = metadata.height;
  let buffer = await sharp(inputPath).ensureAlpha().png().toBuffer();

  if (style.pixelate) {
    const width = Math.max(1, Math.round(targetWidth * style.pixelate));
    const height = Math.max(1, Math.round(targetHeight * style.pixelate));
    buffer = await sharp(buffer)
      .resize({ width, height, fit: "fill", kernel: sharp.kernel.nearest })
      .resize({ width: targetWidth, height: targetHeight, fit: "fill", kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();
  }

  if (style.resample) {
    const factor = Math.max(1, Number(style.resample.factor) || 1);
    const width = Math.max(1, Math.round(targetWidth * factor));
    const height = Math.max(1, Math.round(targetHeight * factor));
    const upKernel = sharp.kernel[style.resample.upKernel] ?? sharp.kernel.cubic;
    const downKernel = sharp.kernel[style.resample.downKernel] ?? sharp.kernel.lanczos3;
    buffer = await sharp(buffer)
      .resize({ width, height, fit: "fill", kernel: upKernel })
      .resize({ width: targetWidth, height: targetHeight, fit: "fill", kernel: downKernel })
      .png()
      .toBuffer();
  }

  let image = sharp(buffer).ensureAlpha();
  if (style.blur) {
    image = image.blur(style.blur);
  }
  if (style.sharpen) {
    image = image.sharpen(style.sharpen);
  }
  if (style.modulate) {
    image = image.modulate(style.modulate);
  }
  if (style.linear) {
    image = image.linear(style.linear.a, style.linear.b);
  }

  const outputBuffer = await image
    .webp({ quality: 88, alphaQuality: 95, effort: 5, smartSubsample: true })
    .toBuffer();
  await writeFile(outputPath, outputBuffer);
}

async function writeInstalledPreview(spritesheetPath, outputPath) {
  const composites = [];
  for (let row = 0; row < atlasRows; row += 1) {
    composites.push({
      input: await sharp(spritesheetPath)
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
    .toFile(outputPath);
}

async function writeInstalledThumbnail(spritesheetPath, outputPath) {
  const { data, info } = await sharp(spritesheetPath)
    .extract({ left: 0, top: 0, width: frameWidth, height: frameHeight })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(data, info);
  if (!bounds) {
    await sharp({
      create: { width: 132, height: 132, channels: 4, background: transparent }
    })
      .webp(spriteWebpOptions)
      .toFile(outputPath);
    return;
  }

  const spriteBuffer = await sharp(data, { raw: info })
    .extract(bounds)
    .resize({ width: 132, height: 132, fit: "inside", kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
    .png()
    .toBuffer();
  const spriteMeta = await sharp(spriteBuffer).metadata();

  await sharp({
    create: { width: 132, height: 132, channels: 4, background: transparent }
  })
    .composite([
      {
        input: spriteBuffer,
        left: Math.floor((132 - spriteMeta.width) / 2),
        top: Math.floor((132 - spriteMeta.height) / 2)
      }
    ])
    .webp(spriteWebpOptions)
    .toFile(outputPath);
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

  return right < left || bottom < top
    ? null
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function extractZip(buffer, dest) {
  const zip = await JSZip.loadAsync(buffer);
  const destRoot = path.resolve(dest);
  const destPrefix = `${destRoot}${path.sep}`;

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }
    const normalizedName = path.normalize(entry.name).replace(/^(\.\.(\/|\\|$))+/, "");
    const target = path.resolve(destRoot, normalizedName);
    if (target !== destRoot && !target.startsWith(destPrefix)) {
      throw new Error(`zip entry would escape install folder: ${entry.name}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await entry.async("uint8array")));
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function joinUrl(baseUrl, pathname) {
  return new URL(pathname, `${normalizeBaseUrl(baseUrl)}/`).toString();
}
