import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import sharp from "sharp";
import { resizeSpriteBuffer, writeCompositeSpriteWebp } from "./lib/sprite-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
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
const rawAssetBase = "https://raw.githubusercontent.com/PMDCollab/RawAsset/master";
const rawAssetRepo = "https://github.com/PMDCollab/RawAsset";
const parser = new XMLParser({ ignoreAttributes: false });

const ignoredFormNames = new Set([""]);

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
  const transfer = await fetchJson(`${rawAssetBase}/transfer.json`);
  await mkdir(petsDir, { recursive: true });

  const baseFallbackIds = await loadPmdBaseFallbackIds();
  const allEntries = collectRawAssetFormEntries(transfer, baseFallbackIds);
  const limit = Number(process.env.POCODEX_RAWASSET_LIMIT ?? "0");
  const resume = process.env.POCODEX_RAWASSET_RESUME === "1";
  const entries = limit > 0 ? allEntries.slice(0, limit) : allEntries;
  const generated = [];
  const skipped = [];

  console.log(`Found ${allEntries.length} PMD RawAsset form candidates.`);
  if (limit > 0) {
    console.log(`POCODEX_RAWASSET_LIMIT=${limit}; generating the first ${entries.length}.`);
  }
  if (resume) {
    console.log("POCODEX_RAWASSET_RESUME=1; keeping completed pet folders and rendering only missing packs.");
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    try {
      if (resume && (await hasGeneratedPet(entry.slug))) {
        console.log(`Keeping PMD RawAsset ${entry.displayName} (${index + 1}/${entries.length})...`);
      } else {
        console.log(`Generating PMD RawAsset ${entry.displayName} (${index + 1}/${entries.length})...`);
        await renderPet(entry);
      }
      generated.push({
        id: entry.baseId,
        slug: entry.slug,
        name: entry.displayName,
        path: entry.spritePath
      });
    } catch (error) {
      skipped.push({
        id: entry.baseId,
        name: entry.displayName,
        path: entry.spritePath,
        reason: error.message
      });
      await removeDir(path.join(petsDir, entry.slug));
      console.warn(`Skipped ${entry.displayName}: ${error.message}`);
    }
  }

  await writeFile(
    path.join(petsDir, "pocodex-pmd-rawasset-selection.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: rawAssetRepo,
        candidates: allEntries.length,
        generated: generated.length,
        skipped: skipped.length,
        skippedPets: skipped,
        pets: generated
      },
      null,
      2
    )}\n`
  );
  await writePreviewGallery(generated.map((pet) => pet.slug), "pocodex-pmd-rawasset-preview-gallery.png");

  console.log(`Generated ${generated.length} PMD RawAsset pet packs in ${petsDir}`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} RawAsset entries without enough usable animation data.`);
  }
}

async function hasGeneratedPet(slug) {
  const targetDir = path.join(petsDir, slug);
  for (const fileName of ["pet.json", "source.json", "spritesheet.webp", "preview.png"]) {
    try {
      await access(path.join(targetDir, fileName));
    } catch {
      return false;
    }
  }
  return true;
}

async function loadPmdBaseFallbackIds() {
  try {
    const selection = JSON.parse(await readFile(path.join(petsDir, "pocodex-pmd-selection.json"), "utf8"));
    return new Set((selection.skippedBasePokemon ?? []).map((pet) => pet.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

function collectRawAssetFormEntries(transfer, baseFallbackIds = new Set()) {
  const entries = [];
  const seenSlugs = new Map();

  for (const [baseId, node] of Object.entries(transfer)) {
    if (!/^\d{4}$/.test(baseId) || baseId === "0000") {
      continue;
    }
    const baseName = cleanTransferName(node.name ?? `Pokemon ${baseId}`);
    if (baseFallbackIds.has(baseId) && node.sprite_dest !== -2) {
      entries.push({
        baseId,
        baseName,
        formLabel: "Base",
        displayName: baseName,
        formPath: "",
        spritePath: `Sprite/${baseId}`,
        spriteDest: node.sprite_dest
      });
    }
    walkRawAssetForms(entries, baseId, baseName, node, baseFallbackIds);
  }

  return entries
    .sort((a, b) => {
      const idCompare = Number(a.baseId) - Number(b.baseId);
      return idCompare || a.formPath.localeCompare(b.formPath);
    })
    .map((entry) => {
      const baseSlug = slugify(entry.baseName);
      const formSlug = slugify(entry.formLabel);
      const sourceName = entry.formLabel === "Base" ? baseSlug : `${baseSlug}-${formSlug}`;
      const baseSlugValue = `pocodex-pmd-rawasset-${sourceName}`;
      const collisionCount = seenSlugs.get(baseSlugValue) ?? 0;
      seenSlugs.set(baseSlugValue, collisionCount + 1);
      const slug = collisionCount === 0 ? baseSlugValue : `${baseSlugValue}-${entry.formPath.replace(/\//g, "-")}`;
      return {
        ...entry,
        sourceName,
        slug
      };
    });
}

function walkRawAssetForms(entries, baseId, baseName, node, baseFallbackIds, pathSegments = [], formNames = []) {
  for (const [subId, subgroup] of Object.entries(node.subgroups ?? {})) {
    const nextPathSegments = [...pathSegments, subId];
    const cleanName = cleanTransferName(subgroup.name ?? "");
    const nextFormNames = cleanName ? [...formNames, cleanName] : formNames;
    const meaningfulNames = nextFormNames.filter((name) => !ignoredFormNames.has(name));

    if (shouldIncludeRawAssetForm(subgroup, meaningfulNames, baseId, baseFallbackIds)) {
      const formLabel = meaningfulNames.length > 0 ? meaningfulNames.join(" ") : "Base";
      entries.push({
        baseId,
        baseName,
        formLabel,
        displayName: formLabel === "Base" ? baseName : `${baseName} ${formLabel}`,
        formPath: nextPathSegments.join("/"),
        spritePath: `Sprite/${baseId}/${nextPathSegments.join("/")}`,
        spriteDest: subgroup.sprite_dest
      });
    }

    walkRawAssetForms(entries, baseId, baseName, subgroup, baseFallbackIds, nextPathSegments, nextFormNames);
  }
}

function shouldIncludeRawAssetForm(subgroup, meaningfulNames, baseId, baseFallbackIds) {
  if (subgroup.sprite_dest === -2) {
    return false;
  }
  return meaningfulNames.length > 0 || baseFallbackIds.has(baseId);
}

async function renderPet(entry) {
  const targetDir = path.join(petsDir, entry.slug);
  const workDir = path.join(petsDir, `.tmp-${entry.slug}`);
  await removeDir(workDir);
  await mkdir(workDir, { recursive: true });

  try {
    const assetBaseUrl = `${rawAssetBase}/${entry.spritePath}`;
    const animData = await fetchText(`${assetBaseUrl}/AnimData.xml`);
    const animMap = parseAnimData(animData);
    const assetCache = new Map();
    const rowSources = [];
    const composites = [];

  for (let row = 0; row < rows; row += 1) {
    const state = states[row];
    const rowResult = await renderStateRow(entry.displayName, assetBaseUrl, animMap, state, assetCache);
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

  await writeFile(
    path.join(workDir, "pet.json"),
    `${JSON.stringify(
      {
        id: entry.slug,
        displayName: `PMD RawAsset ${entry.displayName}`,
        description: `A Codex pet assembled from PMD RawAsset ${entry.displayName} animation rows.`,
        spritesheetPath: "spritesheet.webp"
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    path.join(workDir, "source.json"),
    `${JSON.stringify(
      {
        pokemonId: entry.baseId,
        baseName: entry.baseName,
        formLabel: entry.formLabel,
        displayName: entry.displayName,
        sourceName: entry.sourceName,
        sourceFamily: "pmd-rawasset",
        spriteSource: "PMDCollab/RawAsset",
        spriteSourceUrl: rawAssetRepo,
        spriteBrowserUrl: `${rawAssetRepo}/tree/master/${entry.spritePath}`,
        sourceUrl: rawAssetRepo,
        sourceBrowserUrl: `${rawAssetRepo}/tree/master/${entry.spritePath}`,
        formPath: entry.formPath,
        spriteDest: entry.spriteDest,
        license: "See PMDCollab/RawAsset source repository for per-asset credits and licensing; Pokemon ownership retained by respective rights holders",
        motionModel: "Distinct PMD RawAsset animation files mapped into Codex task states.",
        atlas: {
          frameWidth,
          frameHeight,
          rows,
          columns,
          usedFrames: states.map((state) => state.usedFrames)
        },
        rowSources
      },
      null,
      2
    )}\n`
  );

    await writePreview(workDir, composites);
    await replaceDir(workDir, targetDir);
  } catch (error) {
    await removeDir(workDir);
    throw error;
  }
}

async function renderStateRow(displayName, assetBaseUrl, animMap, state, assetCache) {
  const choice = chooseAnimation(animMap, state.candidates);
  if (!choice) {
    throw new Error(`${displayName} has no usable animation for ${state.key}`);
  }

  const cacheKey = choice.assetAction;
  if (!assetCache.has(cacheKey)) {
    assetCache.set(cacheKey, await fetchBuffer(`${assetBaseUrl}/${choice.assetAction}-Anim.png`));
  }
  const pngBuffer = assetCache.get(cacheKey);
  const frames = await extractAnimationFrames(pngBuffer, choice.anim, choice.direction, state);
  const cells = await Promise.all(frames.map((frame) => frameToCell(frame)));
  if (cells.length === 0) {
    throw new Error(`${displayName} produced no visible frames for ${state.key}`);
  }
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

  const visibleFrames = fullFrames
    .map((frame) => ({
      raw: frame,
      width: anim.frameWidth,
      height: anim.frameHeight,
      crop: alphaBox(frame, anim.frameWidth, anim.frameHeight),
      motion: state.motion ?? null,
      direction: usedDirection,
      sourceFrameCount
    }))
    .filter((frame) => frame.crop);

  if (visibleFrames.length === 0) {
    throw new Error(`${anim.name} direction ${usedDirection} contains no visible pixels`);
  }

  const filledFrames = Array.from({ length: neededFrames }, (_, index) => ({
    ...visibleFrames[index % visibleFrames.length],
    cellIndex: index,
    totalCells: neededFrames
  }));

  if (state.cropMode === "per-frame") {
    return filledFrames;
  }

  const unionBox = unionAlphaBox(
    filledFrames.map((frame) => frame.raw),
    anim.frameWidth,
    anim.frameHeight
  );
  if (!unionBox) {
    throw new Error(`${anim.name} direction ${usedDirection} contains no visible pixels`);
  }

  return filledFrames.map((frame) => ({
    ...frame,
    crop: unionBox
  }));
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

function cleanTransferName(name) {
  return String(name)
    .replace(/_d\b/g, "'d")
    .replace(/_jr\b/gi, " Jr")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(name) {
  return String(name)
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
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(targetDir, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 125
      });
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
