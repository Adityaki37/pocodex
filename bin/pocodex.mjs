#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const VERSION = "0.1.0";
const DEFAULT_BASE_URL = process.env.POCODEX_URL ?? "https://pocodex.dev";
const frameWidth = 192;
const frameHeight = 208;
const atlasColumns = 8;
const atlasRows = 9;
const sheetWidth = frameWidth * atlasColumns;
const sheetHeight = frameHeight * atlasRows;
const spriteBottomPadding = 12;
const sourceFrameMaxHeight = frameHeight - spriteBottomPadding - 4;
const previewScale = 0.5;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const spriteWebpOptions = {
  quality: 35,
  alphaQuality: 70,
  effort: 6,
  smartSubsample: true
};
const customSpriteWebpOptions = { lossless: true, effort: 6 };
const parser = new XMLParser({ ignoreAttributes: false });
let sharpModulePromise = null;
const sourceFrameGenerationSource = "source-frame-canonical-v3";
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
  ["scale2x", { id: "scale2x", kernel: "nearest", scale2xPasses: 1 }],
  [
    "epx",
    {
      id: "epx",
      kernel: "nearest",
      scale2xPasses: 1,
      pixelAdjust: {
        contrast: 1.05,
        saturation: 1.04,
        outlineDarken: 0.82,
        outlineThreshold: 92
      }
    }
  ],
  [
    "plain-xbrz",
    {
      id: "plain-xbrz",
      kernel: "lanczos3",
      scale2xPasses: 2
    }
  ],
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
      kernel: "mks2021",
      scale2xPasses: 2,
      sharpen: { sigma: 0.42, m1: 0.25, m2: 1.2, x1: 2.2, y2: 6, y3: 10 },
      pixelAdjust: {
        contrast: 1.04,
        saturation: 1.04,
        outlineDarken: 0.82,
        outlineThreshold: 86,
        alphaSnapLow: 3,
        alphaSnapHigh: 252
      }
    }
  ],
  [
    "xbrz",
    {
      id: "xbrz",
      kernel: "lanczos3",
      scale2xPasses: 2
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
    --motion-map <data>  Base64url JSON state-to-source-action map for custom rows

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
    animationSpeed: normalizeAnimationSpeed(process.env.POCODEX_ANIMATION_SPEED),
    customMotionMap: parseMotionMap(process.env.POCODEX_MOTION_MAP)
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
    if (arg === "--motion-map" && argv[index + 1]) {
      options.customMotionMap = parseMotionMap(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--motion-map=")) {
      options.customMotionMap = parseMotionMap(arg.slice("--motion-map=".length));
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

  if (target === "all") {
    const catalog = await fetchCatalog(options.baseUrl);
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

  await installPet({ id: target }, options);
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

  const manifestPet = await fetchInstallPetDescriptor(options.baseUrl, pet);
  const dest = path.join(options.codexHome, "pets", pet.id);
  await mkdir(dest, { recursive: true });
  await downloadPetFiles(manifestPet, options, dest);
  const sourceJson = await overlayPetMetadata(manifestPet, options, dest);
  const customMotionApplied = await applyCustomMotionMapToInstalledPet(manifestPet, options, dest, sourceJson);
  if (!customMotionApplied) {
    const sourceFrameApplied = applySourceFrameSpritesheetToInstalledPet(sourceJson);
    if (!sourceFrameApplied) {
      await applyPixelStyleToInstalledPet(sourceJson, dest);
    }
  }
  await applyAnimationSpeedToInstalledPet(dest, options.animationSpeed);
  console.log(`Installed ${manifestPet.displayName ?? pet.displayName ?? pet.id} to ${dest}`);
}

async function fetchInstallPetDescriptor(baseUrl, pet) {
  const sourceJson = await fetchOptionalJson(joinUrl(baseUrl, `/pocodex/pets/${pet.id}/source.json`));
  const petJson = await fetchOptionalJson(joinUrl(baseUrl, `/pocodex/pets/${pet.id}/pet.json`));
  if (!sourceJson && !petJson && !pet.assets) {
    throw new Error(`No pet with slug "${pet.id}". Run "pocodex list" to browse available slugs.`);
  }

  const derivedMotionSource = deriveMotionSource(sourceJson);
  return {
    ...pet,
    id: pet.id,
    displayName: pet.displayName ?? petJson?.displayName ?? sourceJson?.displayName ?? pet.id,
    packageDisplayName: pet.packageDisplayName ?? petJson?.displayName ?? sourceJson?.displayName ?? pet.id,
    formGroup: pet.formGroup ?? (sourceJson?.pixelStyle ? "pixel" : undefined),
    motionModel: pet.motionModel ?? sourceJson?.motionModel,
    motionSource: pet.motionSource ?? derivedMotionSource,
    pixelStyle: pet.pixelStyle ?? sourceJson?.pixelStyle,
    sourceUrl: pet.sourceUrl ?? sourceJson?.sourceUrl,
    sourceBrowserUrl: pet.sourceBrowserUrl ?? sourceJson?.sourceBrowserUrl ?? sourceJson?.spriteBrowserUrl,
    assets: {
      petJson: `/pocodex/pets/${pet.id}/pet.json`,
      spritesheet: `/pocodex/pets/${pet.id}/spritesheet.webp`,
      sourceJson: `/pocodex/pets/${pet.id}/source.json`,
      preview: `/pocodex/pets/${pet.id}/preview.png`,
      thumbnail: `/pocodex/pets/${pet.id}/thumbnail.webp`,
      ...(pet.assets ?? {})
    }
  };
}

async function downloadPetFiles(pet, options, dest) {
  const requiredFiles = [
    ["pet.json", pet.assets?.petJson ?? `/pocodex/pets/${pet.id}/pet.json`],
    ["spritesheet.webp", pet.assets?.spritesheet ?? `/pocodex/pets/${pet.id}/spritesheet.webp`]
  ];
  const optionalFiles = [
    ["source.json", pet.assets?.sourceJson ?? `/pocodex/pets/${pet.id}/source.json`],
    ["preview.png", pet.assets?.preview ?? `/pocodex/pets/${pet.id}/preview.png`],
    ["thumbnail.webp", pet.assets?.thumbnail ?? `/pocodex/pets/${pet.id}/thumbnail.webp`]
  ];

  for (const [fileName, assetPath] of requiredFiles) {
    await downloadRequiredFile(joinUrl(options.baseUrl, assetPath), path.join(dest, fileName));
  }
  for (const [fileName, assetPath] of optionalFiles) {
    await downloadOptionalFile(joinUrl(options.baseUrl, assetPath), path.join(dest, fileName));
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

function parseMotionMap(value) {
  if (!value) {
    return null;
  }

  try {
    const raw = String(value).trim();
    const json = raw.startsWith("{")
      ? raw
      : Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    const normalized = {};
    for (const [state, action] of Object.entries(parsed ?? {})) {
      const stateKey = normalizeMotionStateKey(state);
      const actionName = String(action ?? "").trim();
      if (stateKey && actionName) {
        normalized[stateKey] = actionName;
      }
    }
    return Object.keys(normalized).length ? normalized : null;
  } catch (error) {
    throw new Error(`--motion-map must be base64url encoded JSON: ${error.message}`);
  }
}

function normalizeMotionStateKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "running-right") {
    return "run-right";
  }
  if (key === "running-left") {
    return "run-left";
  }
  return key;
}

async function applyCustomMotionMapToInstalledPet(catalogPet, options, dest, sourceJson) {
  if (!options.customMotionMap) {
    return false;
  }

  const manifestPet = catalogPet;
  if (!manifestPet?.motionSource?.baseUrl || !manifestPet?.motionSource?.animDataUrl) {
    throw new Error(`${catalogPet.id} does not include motion source metadata for custom sprite assignments`);
  }

  const assignments = normalizeCustomMotionAssignments(options.customMotionMap, manifestPet);
  if (Object.keys(assignments).length === 0) {
    return false;
  }

  const spritesheetPath = path.join(dest, "spritesheet.webp");
  await writeCustomSpritesheetFromMotionSource({
    pet: manifestPet,
    assignments,
    outputPath: spritesheetPath,
    existingSpritesheetPath: spritesheetPath,
    copyUnassignedRows: true
  });
  await writeInstalledPreview(spritesheetPath, path.join(dest, "preview.png"));
  await writeInstalledThumbnail(spritesheetPath, path.join(dest, "thumbnail.webp"));
  await annotateCustomMotionMetadata(dest, assignments);
  return true;
}

function applySourceFrameSpritesheetToInstalledPet(sourceJson) {
  if (hasCanonicalSourceFrameSheet(sourceJson)) {
    return true;
  }
  return false;
}

function hasCanonicalSourceFrameSheet(sourceJson) {
  return sourceJson?.pixelStyle?.generatedAssets === true &&
    sourceJson?.pixelStyle?.generationSource === sourceFrameGenerationSource;
}

function normalizeCustomMotionAssignments(assignments, pet) {
  const defaultByState = new Map(
    (pet.motionSource?.rowSources ?? []).map((rowSource) => [
      normalizeMotionStateKey(rowSource.state ?? codexPetStates[rowSource.row]?.id),
      String(rowSource.action ?? rowSource.assetAction ?? "")
    ])
  );
  const normalized = {};

  for (const [state, action] of Object.entries(assignments ?? {})) {
    const stateKey = normalizeMotionStateKey(state);
    if (!codexPetStates.some((petState) => normalizeMotionStateKey(petState.id) === stateKey)) {
      continue;
    }
    const actionName = String(action ?? "").trim();
    if (!actionName || actionName === defaultByState.get(stateKey)) {
      continue;
    }
    normalized[stateKey] = actionName;
  }

  return normalized;
}

async function annotateCustomMotionMetadata(dest, assignments) {
  const petJsonPath = path.join(dest, "pet.json");
  const petJson = JSON.parse(await readFile(petJsonPath, "utf8"));
  await writeFile(
    petJsonPath,
    `${JSON.stringify(
      {
        ...petJson,
        customMotionAssignments: assignments
      },
      null,
      2
    )}\n`
  );

  try {
    const sourceJsonPath = path.join(dest, "source.json");
    const sourceJson = JSON.parse(await readFile(sourceJsonPath, "utf8"));
    await writeFile(
      sourceJsonPath,
      `${JSON.stringify(
        {
          ...sourceJson,
          customMotionAssignments: assignments
        },
        null,
        2
      )}\n`
    );
  } catch {
    // source.json is optional for Codex, so a missing file should not block a valid custom install.
  }
}

async function writeCustomSpritesheetFromMotionSource({
  pet,
  assignments,
  outputPath,
  existingSpritesheetPath,
  copyUnassignedRows = false
}) {
  const sharp = await loadSharp();
  const motionSource = pet.motionSource;
  const style = customMotionPixelStyle(pet);
  const animMap = parseAnimData(await fetchText(motionSource.animDataUrl));
  const assetCache = new Map();
  const composites = [];
  const rowSources = motionSource.rowSources ?? [];

  for (const state of codexPetStates) {
    const stateKey = normalizeMotionStateKey(state.id);
    const rowSource = findMotionRowSource(rowSources, state);
    const assignedAction = assignments[stateKey];
    const renderSource = assignedAction
      ? {
          ...rowSource,
          row: state.row,
          state: state.id,
          action: assignedAction,
          assetAction: assignedAction,
          direction: defaultDirectionForState(stateKey)
        }
      : rowSource;

    if (isStationaryAction(assignedAction)) {
      const cell = await firstCellFromSpritesheet(existingSpritesheetPath, state.row, sharp);
      for (let column = 0; column < state.frames; column += 1) {
        composites.push({ input: cell, left: column * frameWidth, top: state.row * frameHeight });
      }
      continue;
    }

    if (copyUnassignedRows && !assignedAction) {
      const cells = await cellsFromSpritesheetRow(existingSpritesheetPath, state.row, state.frames, sharp);
      for (let column = 0; column < cells.length; column += 1) {
        composites.push({ input: cells[column], left: column * frameWidth, top: state.row * frameHeight });
      }
      continue;
    }

    if (!renderSource) {
      throw new Error(`${pet.id} is missing row source metadata for ${state.id}`);
    }

    const cells = await renderCustomSourceRow({
      sharp,
      motionSource,
      animMap,
      assetCache,
      rowSource: renderSource,
      state,
      style
    });
    for (let column = 0; column < cells.length; column += 1) {
      composites.push({ input: cells[column], left: column * frameWidth, top: state.row * frameHeight });
    }
  }

  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: transparent
    }
  })
    .composite(composites)
    .webp(customSpriteWebpOptions)
    .toFile(outputPath);
}

function findMotionRowSource(rowSources, state) {
  return rowSources.find((rowSource) => Number(rowSource.row) === state.row) ??
    rowSources.find((rowSource) => normalizeMotionStateKey(rowSource.state) === normalizeMotionStateKey(state.id));
}

async function renderCustomSourceRow({ sharp, motionSource, animMap, assetCache, rowSource, state, style }) {
  const choice = resolveRowAnimation(animMap, rowSource);
  if (!choice) {
    throw new Error(`No usable animation for ${rowSource.action ?? state.id}`);
  }

  if (!assetCache.has(choice.assetAction)) {
    assetCache.set(choice.assetAction, await fetchBuffer(`${trimTrailingSlash(motionSource.baseUrl)}/${choice.assetAction}-Anim.png`));
  }

  const frames = await extractCustomAnimationFrames({
    sharp,
    pngBuffer: assetCache.get(choice.assetAction),
    anim: choice.anim,
    choiceDirection: Number(rowSource.direction ?? defaultDirectionForState(normalizeMotionStateKey(state.id))),
    state
  });
  return customFramesToCells(sharp, frames, style);
}

function resolveRowAnimation(animMap, rowSource) {
  const action = String(rowSource.action ?? "");
  const assetAction = String(rowSource.assetAction ?? "");
  const resolved = resolveAnimation(animMap, action) ?? resolveAnimation(animMap, assetAction);
  if (!resolved) {
    return null;
  }
  return {
    anim: resolved,
    assetAction: assetAction && animMap.has(assetAction) ? assetAction : resolved.assetAction
  };
}

async function extractCustomAnimationFrames({ sharp, pngBuffer, anim, choiceDirection, state }) {
  const metadata = await sharp(pngBuffer).metadata();
  const sourceFrameCount = Math.floor(metadata.width / anim.frameWidth);
  const directionCount = Math.max(1, Math.floor(metadata.height / anim.frameHeight));
  const neededFrames = Math.max(1, Number(state.frames) || 1);
  const spec = resolveStateRenderSpec(state.id);
  const usedDirection = choiceDirection < directionCount ? choiceDirection : 0;
  const selectedIndices = sampleFrameIndices(sourceFrameCount, neededFrames, spec.sample);
  const fullFrames = [];

  for (const frameIndex of selectedIndices) {
    fullFrames.push(
      await sharp(pngBuffer)
        .extract({
          left: frameIndex * anim.frameWidth,
          top: usedDirection * anim.frameHeight,
          width: anim.frameWidth,
          height: anim.frameHeight
        })
        .ensureAlpha()
        .raw()
        .toBuffer()
    );
  }

  if (!fullFrames.some((frame) => alphaBox(frame, anim.frameWidth, anim.frameHeight))) {
    throw new Error(`${anim.name} direction ${usedDirection} contains no visible pixels`);
  }

  return Array.from({ length: neededFrames }, (_, index) => ({
    raw: fullFrames[index],
    width: anim.frameWidth,
    height: anim.frameHeight,
    motion: spec.motion ?? null,
    cellIndex: index,
    totalCells: neededFrames
  }));
}

function customMotionPixelStyle(pet) {
  const styleId = pet?.pixelStyle?.id;
  const style = pixelInstallStyles.get(styleId);
  return style && style.id !== "original-unchanged" ? style : null;
}

async function customFramesToCells(sharp, frames, style = null) {
  const renderedFrames = await Promise.all(frames.map((frame) => renderCustomSourceFrame(sharp, frame, style)));
  if (renderedFrames.length === 0) {
    return [];
  }
  const { info } = renderedFrames[0];
  const rowBounds = unionRenderedAlphaBox(renderedFrames, info.width, info.height);
  const left = Math.round((frameWidth - info.width) / 2);
  const top = rowBounds
    ? Math.max(4, Math.round(frameHeight - spriteBottomPadding - (rowBounds.top + rowBounds.height - 1)))
    : Math.round(frameHeight - spriteBottomPadding - info.height);
  return Promise.all(renderedFrames.map((renderedFrame) => renderedCustomFrameToCell(sharp, renderedFrame, { left, top })));
}

async function renderedCustomFrameToCell(sharp, { input }, { left, top }) {
  return sharp({
    create: {
      width: frameWidth,
      height: frameHeight,
      channels: 4,
      background: transparent
    }
  })
    .composite([{ input, left, top }])
    .png()
    .toBuffer();
}

async function renderCustomSourceFrame(sharp, frame, style = null) {
  let imageBuffer = await sharp(frame.raw, {
    raw: { width: frame.width, height: frame.height, channels: 4 }
  })
    .png()
    .toBuffer();

  for (let pass = 0; pass < (style?.scale2xPasses ?? 0); pass += 1) {
    imageBuffer = await scale2xBuffer(sharp, imageBuffer);
  }

  const kernel = style ? sharp.kernel[style.kernel] ?? sharp.kernel.lanczos3 : sharp.kernel.nearest;
  let image = sharp(imageBuffer);
  const integerScaled = !style && kernel === sharp.kernel.nearest
    ? await resizeCustomFrameIntegerScale(sharp, image, frameWidth, sourceFrameMaxHeight)
    : null;
  image = integerScaled ?? image.resize({
    width: frameWidth,
    height: sourceFrameMaxHeight,
    fit: "inside",
    kernel,
    withoutEnlargement: false
  });

  if (style?.blur) {
    image = image.blur(style.blur);
  }
  if (style?.sharpen) {
    image = image.sharpen(style.sharpen);
  }
  if (style?.modulate) {
    image = image.modulate(style.modulate);
  }
  if (style?.linear) {
    image = image.linear(style.linear.a, style.linear.b);
  }

  imageBuffer = await image.png().toBuffer();
  if (style?.pixelAdjust) {
    imageBuffer = await adjustPixels(sharp, imageBuffer, style.pixelAdjust);
  }

  const input = await sharp(imageBuffer)
    .png()
    .toBuffer();
  const { data: raw, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { input, raw, info };
}

function unionRenderedAlphaBox(renderedFrames, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (const { raw } of renderedFrames) {
    const box = tightAlphaBox(raw, width, height);
    if (!box) {
      continue;
    }
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.left + box.width - 1);
    bottom = Math.max(bottom, box.top + box.height - 1);
  }
  if (right < left || bottom < top) {
    return null;
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function resizeCustomFrameIntegerScale(sharp, image, targetWidth, targetHeight) {
  const meta = await image.metadata();
  const scale = Math.min(
    Math.floor(targetWidth / Math.max(1, meta.width)),
    Math.floor(targetHeight / Math.max(1, meta.height))
  );
  if (scale < 1) {
    return null;
  }
  return image.resize({
    width: meta.width * scale,
    height: meta.height * scale,
    fit: "fill",
    kernel: sharp.kernel.nearest,
    withoutEnlargement: false
  });
}

function tightAlphaBox(frame, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (frame[(y * width + x) * 4 + 3] <= 8) {
        continue;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) {
    return null;
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function scale2xBuffer(sharp, inputBuffer) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const output = Buffer.alloc(width * height * 16);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const center = pixelAt(data, width, height, x, y);
      const up = pixelAt(data, width, height, x, y - 1);
      const left = pixelAt(data, width, height, x - 1, y);
      const right = pixelAt(data, width, height, x + 1, y);
      const down = pixelAt(data, width, height, x, y + 1);
      const useEdges = !samePixel(up, down) && !samePixel(left, right);
      const outX = x * 2;
      const outY = y * 2;

      writePixel(output, width * 2, outX, outY, useEdges && samePixel(left, up) ? left : center);
      writePixel(output, width * 2, outX + 1, outY, useEdges && samePixel(up, right) ? right : center);
      writePixel(output, width * 2, outX, outY + 1, useEdges && samePixel(left, down) ? left : center);
      writePixel(output, width * 2, outX + 1, outY + 1, useEdges && samePixel(down, right) ? right : center);
    }
  }

  return sharp(output, {
    raw: { width: width * 2, height: height * 2, channels: 4 }
  })
    .png()
    .toBuffer();
}

async function adjustPixels(sharp, inputBuffer, options) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  const contrast = options.contrast ?? 1;
  const saturation = options.saturation ?? 1;
  const outlineThreshold = options.outlineThreshold ?? 96;
  const outlineDarken = options.outlineDarken ?? 1;

  for (let index = 0; index < output.length; index += 4) {
    let alpha = output[index + 3];
    if (alpha <= 0) {
      continue;
    }
    if (options.alphaSnapLow !== undefined && alpha <= options.alphaSnapLow) {
      output[index + 3] = 0;
      continue;
    }
    if (options.alphaSnapHigh !== undefined && alpha >= options.alphaSnapHigh) {
      output[index + 3] = 255;
      alpha = 255;
    }

    const r0 = output[index];
    const g0 = output[index + 1];
    const b0 = output[index + 2];
    const luma = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
    const satBlend = (value) => luma + (value - luma) * saturation;
    let r = (satBlend(r0) - 128) * contrast + 128;
    let g = (satBlend(g0) - 128) * contrast + 128;
    let b = (satBlend(b0) - 128) * contrast + 128;

    if (luma < outlineThreshold && alpha > 80) {
      r *= outlineDarken;
      g *= outlineDarken;
      b *= outlineDarken;
    }

    output[index] = clamp(Math.round(r), 0, 255);
    output[index + 1] = clamp(Math.round(g), 0, 255);
    output[index + 2] = clamp(Math.round(b), 0, 255);
  }

  return sharp(output, {
    raw: { width: info.width, height: info.height, channels: 4 }
  })
    .png()
    .toBuffer();
}

function pixelAt(data, width, height, x, y) {
  const clampedX = clamp(x, 0, width - 1);
  const clampedY = clamp(y, 0, height - 1);
  const index = (clampedY * width + clampedX) * 4;
  return [data[index], data[index + 1], data[index + 2], data[index + 3]];
}

function samePixel(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function writePixel(output, width, x, y, pixel) {
  const index = (y * width + x) * 4;
  output[index] = pixel[0];
  output[index + 1] = pixel[1];
  output[index + 2] = pixel[2];
  output[index + 3] = pixel[3];
}

async function firstCellFromSpritesheet(spritesheetPath, row, sharp) {
  return sharp(spritesheetPath)
    .extract({ left: 0, top: row * frameHeight, width: frameWidth, height: frameHeight })
    .png()
    .toBuffer();
}

async function cellsFromSpritesheetRow(spritesheetPath, row, frameCount, sharp) {
  return Promise.all(
    Array.from({ length: frameCount }, (_, column) =>
      sharp(spritesheetPath)
        .extract({ left: column * frameWidth, top: row * frameHeight, width: frameWidth, height: frameHeight })
        .png()
        .toBuffer()
    )
  );
}

function parseAnimData(xml) {
  const parsed = parser.parse(xml);
  const anims = normalizeArray(parsed?.AnimData?.Anims?.Anim);
  const map = new Map();
  for (const anim of anims) {
    if (!anim?.Name) {
      continue;
    }
    map.set(anim.Name, {
      name: anim.Name,
      copyOf: anim.CopyOf ?? null,
      frameWidth: Number(anim.FrameWidth ?? 1),
      frameHeight: Number(anim.FrameHeight ?? 1)
    });
  }
  return map.size > 0 ? map : parseLegacyAnimData(xml);
}

function parseLegacyAnimData(text) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const map = new Map();
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (isNumericToken(tokens[index]) || !isNumericToken(tokens[index + 1])) {
      continue;
    }
    const frameWidth = Number(tokens[index + 2]);
    const frameHeight = Number(tokens[index + 3]);
    if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) || frameWidth <= 0 || frameHeight <= 0) {
      continue;
    }
    map.set(tokens[index], {
      name: tokens[index],
      copyOf: null,
      frameWidth,
      frameHeight
    });
    index += 3;
  }
  return map;
}

function isNumericToken(token) {
  return /^-?\d+(?:\.\d+)?$/.test(String(token));
}

function resolveAnimation(animMap, action, seen = new Set()) {
  const anim = animMap.get(action);
  if (!anim || seen.has(action)) {
    return null;
  }
  if (!anim.copyOf) {
    return { ...anim, assetAction: action };
  }
  seen.add(action);
  const resolved = resolveAnimation(animMap, anim.copyOf, seen);
  return resolved ? { ...resolved, assetAction: resolved.assetAction } : null;
}

function sampleFrameIndices(sourceFrameCount, neededFrames, mode) {
  if (sourceFrameCount <= 0) {
    throw new Error("Animation has no source frames");
  }
  const indices = [];
  for (let index = 0; index < neededFrames; index += 1) {
    indices.push(mode === "spread" && neededFrames > 1 && sourceFrameCount > 1
      ? Math.round((index / (neededFrames - 1)) * (sourceFrameCount - 1))
      : index % sourceFrameCount);
  }
  return indices;
}

function resolveStateRenderSpec(stateId) {
  const stateKey = normalizeMotionStateKey(stateId);
  if (stateKey === "waving" || stateKey === "failed") {
    return { sample: "spread" };
  }
  if (stateKey === "jumping") {
    return { sample: "spread" };
  }
  return { sample: "cycle" };
}

function defaultDirectionForState(stateKey) {
  if (stateKey === "run-right") {
    return 2;
  }
  if (stateKey === "run-left") {
    return 6;
  }
  if (stateKey === "running") {
    return 0;
  }
  return 1;
}

function isStationaryAction(action) {
  return String(action ?? "").trim().toLowerCase() === "stationary";
}

function alphaBox(frame, width, height) {
  return unionAlphaBox([frame], width, height);
}

function unionAlphaBox(frames, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (const frame of frames) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (frame[(y * width + x) * 4 + 3] <= 8) {
          continue;
        }
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) {
    return null;
  }
  const padding = 2;
  left = clamp(left - padding, 0, width - 1);
  top = clamp(top - padding, 0, height - 1);
  right = clamp(right + padding, left, width - 1);
  bottom = clamp(bottom + padding, top, height - 1);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function normalizeArray(value) {
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function overlayPetMetadata(pet, options, dest) {
  if (pet.formGroup !== "pixel") {
    return null;
  }

  try {
    const sourceJsonPath = path.join(dest, "source.json");
    const sourceJson = JSON.parse(await readFile(sourceJsonPath, "utf8"));
    const mergedSourceJson = {
      ...sourceJson,
      pixelStyle: {
        ...sourceJson.pixelStyle,
        ...pet.pixelStyle
      }
    };
    await writeFile(sourceJsonPath, `${JSON.stringify(mergedSourceJson, null, 2)}\n`);
    return mergedSourceJson;
  } catch {
    return null;
  }
}

async function fetchOptionalText(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function fetchOptionalJson(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function deriveMotionSource(sourceJson) {
  if (!sourceJson) {
    return null;
  }
  if (sourceJson.motionSource?.baseUrl && sourceJson.motionSource?.animDataUrl) {
    return sourceJson.motionSource;
  }

  const browserUrl = sourceJson.sourceBrowserUrl ?? sourceJson.spriteBrowserUrl;
  const rawBaseUrl = rawAssetBaseUrlFromBrowserUrl(browserUrl) ?? spriteCollabBaseUrlFromSourceJson(sourceJson);
  const rowSources = sourceJson.rowSources ?? sourceJson.motionSource?.rowSources;
  if (!rawBaseUrl || !Array.isArray(rowSources) || rowSources.length === 0) {
    return null;
  }
  return {
    baseUrl: rawBaseUrl,
    animDataUrl: `${rawBaseUrl}/AnimData.xml`,
    rowSources
  };
}

function rawAssetBaseUrlFromBrowserUrl(browserUrl) {
  const match = String(browserUrl ?? "").match(
    /^https:\/\/github\.com\/PMDCollab\/RawAsset\/tree\/([^/]+)\/(.+)$/
  );
  if (!match) {
    return null;
  }
  return `https://raw.githubusercontent.com/PMDCollab/RawAsset/${match[1]}/${match[2]}`;
}

function spriteCollabBaseUrlFromSourceJson(sourceJson) {
  if (sourceJson?.spriteSource !== "PMDCollab/SpriteCollab" || !sourceJson?.spriteSourcePath) {
    return null;
  }
  return `https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/${sourceJson.spriteSourcePath}`;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`text fetch failed for ${url}: ${res.status}`);
  }
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`asset fetch failed for ${url}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
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
  const sharp = await loadSharp();
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
  const sharp = await loadSharp();
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
  const sharp = await loadSharp();
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

async function loadSharp() {
  sharpModulePromise ??= import("sharp")
    .then((module) => module.default ?? module)
    .catch((error) => {
      throw new Error(`Installing this legacy pixel-style pet requires the optional sharp dependency: ${error.message}`);
    });
  return sharpModulePromise;
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

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}
