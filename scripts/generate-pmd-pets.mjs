import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import sharp from "sharp";
import { resizeSpriteBuffer, writeCompositeSpriteWebp } from "./lib/sprite-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "config", "pmd-pokemon.json");
const petsDir = path.join(rootDir, "pets");
const frameWidth = 192;
const frameHeight = 208;
const columns = 8;
const rows = 9;
const sheetWidth = frameWidth * columns;
const sheetHeight = frameHeight * rows;
const spriteMaxWidth = 168;
const spriteMaxHeight = 184;
const spriteBottomPadding = 12;
const previewScale = 0.5;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const sourceBase = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master";
const parser = new XMLParser({ ignoreAttributes: false });

const states = [
  {
    key: "idle",
    label: "Idle",
    usedFrames: 6,
    candidates: [{ action: "Idle", direction: 1 }, { action: "Idle", direction: 0 }],
    sample: "cycle"
  },
  {
    key: "running-right",
    label: "Run Right",
    usedFrames: 8,
    candidates: [{ action: "Walk", direction: 2 }],
    sample: "cycle"
  },
  {
    key: "running-left",
    label: "Run Left",
    usedFrames: 8,
    candidates: [{ action: "Walk", direction: 6 }],
    sample: "cycle"
  },
  {
    key: "waving",
    label: "Waving",
    usedFrames: 4,
    candidates: [
      { action: "Wave", direction: 1 },
      { action: "Pose", direction: 1 },
      { action: "Nod", direction: 1 },
      { action: "Swing", direction: 1 },
      { action: "Attack", direction: 1 },
      { action: "Charge", direction: 1 },
      { action: "Rotate", direction: 1 },
      { action: "Double", direction: 1 }
    ],
    sample: "spread",
    cropMode: "per-frame"
  },
  {
    key: "jumping",
    label: "Jumping",
    usedFrames: 5,
    candidates: [
      { action: "Jump", direction: 1 },
      { action: "Hop", direction: 1 },
      { action: "LeapForth", direction: 1 },
      { action: "Tumble", direction: 1 },
      { action: "Double", direction: 1 },
      { action: "QuickStrike", direction: 1 },
      { action: "Attack", direction: 1 },
      { action: "Walk", direction: 1 }
    ],
    sample: "spread",
    cropMode: "per-frame",
    motion: "jump"
  },
  {
    key: "failed",
    label: "Failed",
    usedFrames: 8,
    candidates: [
      { action: "Faint", direction: 1 },
      { action: "HitGround", direction: 1 },
      { action: "Hurt", direction: 1 },
      { action: "Pain", direction: 1 },
      { action: "Cringe", direction: 1 },
      { action: "LostBalance", direction: 1 },
      { action: "Trip", direction: 1 },
      { action: "Sleep", direction: 1 }
    ],
    sample: "spread"
  },
  {
    key: "waiting",
    label: "Waiting",
    usedFrames: 6,
    candidates: [
      { action: "Eat", direction: 1 },
      { action: "Sit", direction: 1 },
      { action: "DeepBreath", direction: 1 },
      { action: "Sleep", direction: 1 },
      { action: "EventSleep", direction: 1 },
      { action: "Laying", direction: 1 },
      { action: "Charge", direction: 1 },
      { action: "Idle", direction: 1 }
    ],
    sample: "cycle"
  },
  {
    key: "running",
    label: "Running",
    usedFrames: 6,
    candidates: [
      { action: "Walk", direction: 0 },
      { action: "Walk", direction: 1 }
    ],
    sample: "cycle"
  },
  {
    key: "review",
    label: "Review",
    usedFrames: 6,
    candidates: [
      { action: "LookUp", direction: 1 },
      { action: "Nod", direction: 1 },
      { action: "Head", direction: 1 },
      { action: "Pose", direction: 1 },
      { action: "DeepBreath", direction: 1 },
      { action: "Charge", direction: 1 },
      { action: "Rotate", direction: 1 },
      { action: "Idle", direction: 1 }
    ],
    sample: "cycle"
  }
];

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const tracker = await fetchJson(`${sourceBase}/tracker.json`);
  await mkdir(petsDir, { recursive: true });

  const pokemonIds = resolvePokemonIds(config, tracker, parseCliPokemonIds(process.argv.slice(2)));
  const skipped = findSkippedBasePokemon(tracker, pokemonIds, config);
  const failed = [];
  const generated = [];
  for (const id of pokemonIds) {
    const trackerEntry = tracker[id] ?? {};
    const displayName = cleanDisplayName(trackerEntry.name ?? `Pokemon ${id}`);
    const slug = `pocodex-pmd-${slugify(displayName)}`;
    const targetDir = path.join(petsDir, slug);
    const workDir = path.join(petsDir, `.tmp-${slug}`);

    console.log(`Generating PMD ${displayName} (${id})...`);
    await removeDir(workDir);
    await mkdir(workDir, { recursive: true });

    try {
      const animData = await fetchText(`${sourceBase}/sprite/${id}/AnimData.xml`);
      const animMap = parseAnimData(animData);
      const assetCache = new Map();
      const rowSources = [];
      const composites = [];

      for (let row = 0; row < rows; row += 1) {
        const state = states[row];
        const rowResult = await renderStateRow(id, animMap, state, assetCache);
        rowSources.push({
          row,
          state: state.key,
          action: rowResult.action,
          assetAction: rowResult.assetAction,
          direction: rowResult.direction,
          sourceFrames: rowResult.sourceFrames
        });

        for (let column = 0; column < rowResult.cells.length; column += 1) {
          composites.push({
            input: rowResult.cells[column],
            left: column * frameWidth,
            top: row * frameHeight
          });
        }
      }

      await writeCompositeSpriteWebp({
        width: sheetWidth,
        height: sheetHeight,
        background: transparent,
        composites,
        outputPath: path.join(workDir, "spritesheet.webp")
      });
      traceQuality("spritesheet complete");

      await writeFile(
        path.join(workDir, "pet.json"),
        `${JSON.stringify(
          {
            id: slug,
            displayName: `PMD ${displayName}`,
            description: `A Codex pet assembled from PMD Collab ${displayName} animation rows.`,
            spritesheetPath: "spritesheet.webp"
          },
          null,
          2
        )}\n`
      );
      traceQuality("pet.json complete");

      traceQuality("credits fetch start");
      const credits = await fetchOptionalText(`${sourceBase}/sprite/${id}/credits.txt`);
      traceQuality("credits fetch complete");
      await writeFile(
        path.join(workDir, "source.json"),
        `${JSON.stringify(
          {
            pokemonId: id,
            displayName,
            spriteSource: "PMDCollab/SpriteCollab",
            spriteSourceUrl: "https://github.com/PMDCollab/SpriteCollab",
            spriteBrowserUrl: `https://sprites.pmdcollab.org/#/${id}`,
            license: "CC BY-NC 4.0, with Pokemon ownership retained by respective rights holders",
            credits: credits?.trim() ?? null,
            rowSources
          },
          null,
          2
        )}\n`
      );
      traceQuality("source.json complete");

      await writePreview(workDir, composites);
      traceQuality("preview complete");
      await replaceDir(workDir, targetDir);
      traceQuality("rename complete");
      generated.push({ id, slug, name: displayName });
    } catch (error) {
      traceQuality(`catch ${error.stack ?? error.message}`);
      await removeDir(workDir);
      failed.push({ id, name: displayName, reason: error.message });
      console.warn(`Skipped PMD ${displayName} (${id}): ${error.message}`);
    }
  }

  await writeFile(
    path.join(petsDir, "pocodex-pmd-selection.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: process.argv.some((arg) => arg.startsWith("--ids=")) ? "cli-id-list" : config.includeAllBasePokemon ? "all-base-pokemon" : "configured-list",
        skippedBasePokemon: skipped,
        failedPokemon: failed,
        pets: generated
      },
      null,
      2
    )}\n`
  );
  await writePreviewGallery(generated.map((pet) => pet.slug), "pocodex-pmd-preview-gallery.png");

  console.log(`Generated ${generated.length} PMD pet packs in ${petsDir}`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} base tracker entries without enough usable sprite data.`);
  }
  if (failed.length > 0) {
    console.log(`Skipped ${failed.length} requested entries after render checks failed.`);
  }
}

function resolvePokemonIds(config, tracker, cliPokemonIds) {
  if (cliPokemonIds.length > 0) {
    return cliPokemonIds;
  }
  if (config.includeAllBasePokemon) {
    return Object.entries(tracker)
      .filter(([id, entry]) => isEligibleBasePokemon(id, entry, config))
      .map(([id]) => id)
      .sort((a, b) => Number(a) - Number(b));
  }
  return config.pokemonIds ?? config.starterPokemonIds ?? [];
}

function parseCliPokemonIds(args) {
  const idsArg = args.find((arg) => arg.startsWith("--ids="));
  if (!idsArg) {
    return [];
  }
  return idsArg
    .slice("--ids=".length)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => id.padStart(4, "0"));
}

function findSkippedBasePokemon(tracker, includedIds, config) {
  const included = new Set(includedIds);
  return Object.entries(tracker)
    .filter(([id]) => /^\d{4}$/.test(id) && !included.has(id))
    .map(([id, entry]) => ({
      id,
      name: cleanDisplayName(entry.name ?? `Pokemon ${id}`),
      reason: skipReason(id, entry)
    }))
    .filter((entry) => entry.reason);
}

function isEligibleBasePokemon(id, entry, config) {
  if (!/^\d{4}$/.test(id)) {
    return false;
  }
  if (entry.canon === false) {
    return false;
  }
  if (config.includeCompleteSpritePokemon && Number(entry.sprite_complete ?? 0) >= 2) {
    return true;
  }
  const files = entry.sprite_files ?? {};
  return states.every((state) => state.candidates.some((candidate) => files[candidate.action]));
}

function skipReason(id, entry) {
  if (!/^\d{4}$/.test(id)) {
    return null;
  }
  if (entry.canon === false) {
    return "non-canon tracker entry";
  }
  const files = entry.sprite_files ?? {};
  const visibleActions = Object.entries(files)
    .filter(([, present]) => present)
    .map(([action]) => action);
  if (visibleActions.length === 0) {
    return "no completed overworld sprite actions";
  }
  const missingRows = states
    .filter((state) => !state.candidates.some((candidate) => files[candidate.action]))
    .map((state) => state.key);
  return missingRows.length ? `missing actions for ${missingRows.join(", ")}` : null;
}

async function renderStateRow(pokemonId, animMap, state, assetCache) {
  const choice = chooseAnimation(animMap, state.candidates);
  if (!choice) {
    throw new Error(`${pokemonId} has no usable animation for ${state.key}`);
  }

  const cacheKey = choice.assetAction;
  if (!assetCache.has(cacheKey)) {
    assetCache.set(cacheKey, await fetchBuffer(`${sourceBase}/sprite/${pokemonId}/${choice.assetAction}-Anim.png`));
  }
  const pngBuffer = assetCache.get(cacheKey);
  const frames = await extractAnimationFrames(pngBuffer, choice.anim, choice.direction, state);
  const cells = await Promise.all(frames.map((frame) => frameToCell(frame)));
  return {
    cells,
    action: choice.action,
    assetAction: choice.assetAction,
    direction: frames[0]?.direction ?? choice.direction,
    sourceFrames: frames[0]?.sourceFrameCount ?? 0
  };
}

function chooseAnimation(animMap, candidates) {
  for (const candidate of candidates) {
    const anim = resolveAnimation(animMap, candidate.action);
    if (anim) {
      return {
        action: candidate.action,
        assetAction: anim.assetAction,
        direction: candidate.direction,
        anim
      };
    }
  }
  return null;
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

async function extractAnimationFrames(pngBuffer, anim, choiceDirection, state) {
  const metadata = await sharp(pngBuffer).metadata();
  const sourceFrameCount = Math.floor(metadata.width / anim.frameWidth);
  const directionCount = Math.max(1, Math.floor(metadata.height / anim.frameHeight));
  const { usedFrames: neededFrames, sample: sampleMode } = state;
  const usedDirection = choiceDirection < directionCount ? choiceDirection : 0;
  const selectedIndices = sampleFrameIndices(sourceFrameCount, neededFrames, sampleMode);
  const fullFrames = [];

  for (const frameIndex of selectedIndices) {
    const raw = await sharp(pngBuffer)
      .extract({
        left: frameIndex * anim.frameWidth,
        top: usedDirection * anim.frameHeight,
        width: anim.frameWidth,
        height: anim.frameHeight
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
    fullFrames.push(raw);
  }

  const unionBox = state.cropMode === "per-frame" ? null : unionAlphaBox(fullFrames, anim.frameWidth, anim.frameHeight);
  if (state.cropMode !== "per-frame" && !unionBox) {
    throw new Error(`${anim.name} direction ${usedDirection} contains no visible pixels`);
  }

  return fullFrames.map((frame, index) => ({
    raw: frame,
    width: anim.frameWidth,
    height: anim.frameHeight,
    crop: state.cropMode === "per-frame" ? alphaBox(frame, anim.frameWidth, anim.frameHeight) : unionBox,
    cellIndex: index,
    totalCells: fullFrames.length,
    motion: state.motion ?? null,
    direction: usedDirection,
    sourceFrameCount
  })).filter((frame) => frame.crop);
}

async function frameToCell(frame) {
  const cropBuffer = await sharp(frame.raw, {
    raw: { width: frame.width, height: frame.height, channels: 4 }
  })
    .extract(frame.crop)
    .png()
    .toBuffer();

  const { data, info } = await resizeSpriteBuffer(cropBuffer, {
    width: spriteMaxWidth,
    height: spriteMaxHeight
  });
  const left = Math.round((frameWidth - info.width) / 2);
  const jumpOffset =
    frame.motion === "jump" && frame.totalCells > 1
      ? Math.round(Math.sin((frame.cellIndex / (frame.totalCells - 1)) * Math.PI) * 42)
      : 0;
  const top = clamp(
    Math.round(frameHeight - spriteBottomPadding - info.height - jumpOffset),
    4,
    frameHeight - info.height - 4
  );

  return sharp({
    create: {
      width: frameWidth,
      height: frameHeight,
      channels: 4,
      background: transparent
    }
  })
    .composite([{ input: data, left, top }])
    .png()
    .toBuffer();
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
  return map;
}

function sampleFrameIndices(sourceFrameCount, neededFrames, mode) {
  if (sourceFrameCount <= 0) {
    throw new Error("Animation has no source frames");
  }
  const indices = [];
  for (let index = 0; index < neededFrames; index += 1) {
    if (mode === "spread" && neededFrames > 1 && sourceFrameCount > 1) {
      indices.push(Math.round((index / (neededFrames - 1)) * (sourceFrameCount - 1)));
    } else {
      indices.push(index % sourceFrameCount);
    }
  }
  return indices;
}

function unionAlphaBox(frames, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (const frame of frames) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = frame[(y * width + x) * 4 + 3];
        if (alpha <= 8) {
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

function alphaBox(frame, width, height) {
  return unionAlphaBox([frame], width, height);
}

async function writePreview(targetDir, sheetComposites = null) {
  const sheet = path.join(targetDir, "spritesheet.webp");
  const composites = [];
  for (let row = 0; row < rows; row += 1) {
    const frame =
      sheetComposites?.find((composite) => composite.left === 0 && composite.top === row * frameHeight)?.input ??
      (await sharp(sheet)
        .extract({ left: 0, top: row * frameHeight, width: frameWidth, height: frameHeight })
        .png()
        .toBuffer());
    composites.push({ input: frame, left: row * frameWidth, top: 0 });
  }

  const previewBuffer = await sharp({
    create: {
      width: frameWidth * rows,
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
      width: Math.round(frameWidth * rows * previewScale),
      height: Math.round(frameHeight * previewScale),
      kernel: sharp.kernel.lanczos3
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 80 })
    .toFile(path.join(targetDir, "preview.png"));
}

async function writePreviewGallery(slugs, fileName) {
  const sortedSlugs = [...slugs].sort();
  const previewWidth = Math.round(frameWidth * rows * previewScale);
  const previewHeight = Math.round(frameHeight * previewScale);
  const labelHeight = 38;
  const rowHeight = previewHeight + labelHeight;
  const pageSize = 40;
  const parsed = path.parse(fileName);
  const pages = [];

  for (let pageIndex = 0; pageIndex * pageSize < sortedSlugs.length; pageIndex += 1) {
    const pageSlugs = sortedSlugs.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const pageFileName = pageIndex === 0 ? fileName : `${parsed.name}-${String(pageIndex + 1).padStart(3, "0")}${parsed.ext}`;
    const composites = [];

    for (let index = 0; index < pageSlugs.length; index += 1) {
      const slug = pageSlugs[index];
      const top = index * rowHeight;
      const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${previewWidth}" height="${labelHeight}">
        <rect width="100%" height="100%" fill="#f8fafc"/>
        <text x="12" y="25" font-family="Arial, sans-serif" font-size="20" fill="#18202f">${slug}</text>
      </svg>`);
      const preview = await sharp(path.join(petsDir, slug, "preview.png")).png().toBuffer();
      composites.push({ input: label, left: 0, top });
      composites.push({ input: preview, left: 0, top: top + labelHeight });
    }

    await sharp({
      create: {
        width: previewWidth,
        height: pageSlugs.length * rowHeight,
        channels: 4,
        background: "#ffffff"
      }
    })
      .composite(composites)
      .png()
      .toFile(path.join(petsDir, pageFileName));
    pages.push({ file: pageFileName, count: pageSlugs.length, first: pageSlugs[0], last: pageSlugs.at(-1) });
  }

  await writeFile(
    path.join(petsDir, `${parsed.name}-index.json`),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), total: sortedSlugs.length, pageSize, pages }, null, 2)}\n`
  );
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchOptionalText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function cleanDisplayName(name) {
  return name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

async function removeDir(targetDir) {
  traceQuality(`remove start ${targetDir}`);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(targetDir, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 125
      });
      traceQuality(`remove complete ${targetDir}`);
      return;
    } catch (error) {
      traceQuality(`remove attempt ${attempt + 1} failed ${targetDir}: ${error.code ?? error.message}`);
      const retryable = ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code);
      if (!retryable || attempt === 5) {
        throw error;
      }
      await sleep(150 * (attempt + 1));
    }
  }
}

async function replaceDir(workDir, targetDir) {
  await removeDir(targetDir);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(workDir, targetDir);
      return;
    } catch (error) {
      const retryable = ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code);
      if (!retryable || attempt === 5) {
        throw error;
      }
      await sleep(150 * (attempt + 1));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function traceQuality(message) {
  if (process.env.POCODEX_TRACE_QUALITY === "1") {
    console.error(`[generate-pmd] ${message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
