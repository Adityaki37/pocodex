import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decompressFrames, parseGIF } from "gifuct-js";
import sharp from "sharp";
import { applySpriteResize, writeCompositeSpriteWebp } from "./sprite-quality.mjs";

export const frameWidth = 192;
export const frameHeight = 208;
export const columns = 8;
export const rows = 9;
export const sheetWidth = frameWidth * columns;
export const sheetHeight = frameHeight * rows;
export const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

export const gifStates = [
  { key: "idle", label: "Idle", usedFrames: 6, frameOffset: 0, bounce: 2, scale: 1.55 },
  { key: "run-right", label: "Run Right", usedFrames: 8, frameOffset: 1, bounce: 6, scale: 1.55, xWave: 8 },
  { key: "run-left", label: "Run Left", usedFrames: 8, frameOffset: 1, bounce: 6, scale: 1.55, xWave: -8, flip: true },
  { key: "waving", label: "Waving", usedFrames: 4, frameOffset: 2, bounce: 3, scale: 1.55, rotateWave: 5 },
  { key: "jumping", label: "Jumping", usedFrames: 5, frameOffset: 3, jump: 26, scale: 1.55 },
  { key: "failed", label: "Failed", usedFrames: 8, frameOffset: 4, bounce: 1, scale: 1.48, shake: 5, muted: true },
  { key: "waiting", label: "Waiting", usedFrames: 6, frameOffset: 0, bounce: 1, scale: 1.5 },
  { key: "running", label: "Running", usedFrames: 6, frameOffset: 2, bounce: 9, scale: 1.6, xWave: 10 },
  { key: "review", label: "Review", usedFrames: 6, frameOffset: 3, bounce: 2, scale: 1.52 }
];

export async function generateGifPetBatch({
  petsDir,
  entries,
  selectionFileName,
  galleryFileName,
  collection,
  concurrency = 4
}) {
  await mkdir(petsDir, { recursive: true });

  const generated = [];
  const skipped = [];
  let completed = 0;

  await mapLimit(entries, concurrency, async (entry) => {
    try {
      const pet = await generateGifPet({ petsDir, entry, collection });
      generated.push(pet);
    } catch (error) {
      skipped.push({
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        displayName: entry.displayName,
        gifUrl: entry.gifUrl,
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      completed += 1;
      if (completed === entries.length || completed % 25 === 0) {
        console.log(`${collection.label}: ${completed}/${entries.length} processed`);
      }
    }
  });

  generated.sort((a, b) => a.slug.localeCompare(b.slug));
  skipped.sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));

  await writeFile(
    path.join(petsDir, selectionFileName),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        collection,
        pets: generated,
        skipped
      },
      null,
      2
    )}\n`
  );

  await writePreviewGallery({
    petsDir,
    slugs: generated.map((pet) => pet.slug),
    fileName: galleryFileName
  });

  console.log(`Generated ${generated.length} ${collection.label} pet packs in ${petsDir}`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} ${collection.label} entries. See ${selectionFileName}.`);
  }

  return { generated, skipped };
}

async function generateGifPet({ petsDir, entry, collection }) {
  const slug = entry.slug;
  const targetDir = path.join(petsDir, slug);

  console.log(`Generating ${entry.displayName} from ${collection.label}...`);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  const gifBuffer = await fetchBuffer(entry.gifUrl);
  const frames = extractGifFrames(gifBuffer);
  const composites = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (column >= gifStates[row].usedFrames) {
        continue;
      }
      const cell = await renderCell(frames, gifStates[row], column);
      composites.push({
        input: cell,
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
    outputPath: path.join(targetDir, "spritesheet.webp")
  });

  await writeFile(
    path.join(targetDir, "pet.json"),
    `${JSON.stringify(
      {
        id: slug,
        displayName: entry.petDisplayName,
        description: entry.description,
        spritesheetPath: "spritesheet.webp"
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    path.join(targetDir, "source.json"),
    `${JSON.stringify(
      {
        sourceFamily: collection.id,
        sourceLabel: collection.label,
        sourceUrl: collection.url,
        sourceNotes: collection.notes,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        displayName: entry.displayName,
        variant: entry.variant,
        gifUrl: entry.gifUrl,
        motionModel: "Codex task rows synthesized from a single transparent animated GIF loop.",
        petFormatReference: "https://petdex.crafter.run/docs",
        states: gifStates.map((state, index) => ({ row: index, key: state.key, label: state.label }))
      },
      null,
      2
    )}\n`
  );

  await writePreview(targetDir, composites);

  return {
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    slug,
    name: entry.displayName,
    displayName: entry.petDisplayName,
    sourceFamily: collection.id,
    sourceLabel: collection.label,
    variant: entry.variant
  };
}

export async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "pocodex-builder" } });
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "pocodex-builder" } });
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { "User-Agent": "pocodex-builder" } });
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function extractGifFrames(buffer) {
  const gif = parseGIF(buffer);
  const frames = decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;
  let canvas = new Uint8ClampedArray(width * height * 4);
  let restoreCanvas = null;
  const snapshots = [];

  for (const frame of frames) {
    if (frame.disposalType === 3) {
      restoreCanvas = canvas.slice();
    }

    drawPatch(canvas, width, height, frame);
    snapshots.push({
      buffer: Buffer.from(canvas),
      width,
      height
    });

    if (frame.disposalType === 2) {
      clearPatch(canvas, width, height, frame);
    } else if (frame.disposalType === 3 && restoreCanvas) {
      canvas = restoreCanvas;
      restoreCanvas = null;
    }
  }

  const populated = snapshots.filter((frame) => alphaCoverage(frame.buffer) > 0.005);
  if (populated.length === 0) {
    throw new Error("Animated GIF did not contain any visible frames");
  }
  return populated;
}

function drawPatch(canvas, canvasWidth, canvasHeight, frame) {
  const { left, top, width, height } = frame.dims;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (y * width + x) * 4;
      const alpha = frame.patch[sourceIndex + 3] / 255;
      if (alpha === 0) {
        continue;
      }
      const targetX = left + x;
      const targetY = top + y;
      if (targetX < 0 || targetX >= canvasWidth || targetY < 0 || targetY >= canvasHeight) {
        continue;
      }
      const targetIndex = (targetY * canvasWidth + targetX) * 4;
      const targetAlpha = canvas[targetIndex + 3] / 255;
      const outAlpha = alpha + targetAlpha * (1 - alpha);
      for (let channel = 0; channel < 3; channel += 1) {
        const sourceColor = frame.patch[sourceIndex + channel];
        const targetColor = canvas[targetIndex + channel];
        canvas[targetIndex + channel] =
          outAlpha === 0
            ? 0
            : Math.round((sourceColor * alpha + targetColor * targetAlpha * (1 - alpha)) / outAlpha);
      }
      canvas[targetIndex + 3] = Math.round(outAlpha * 255);
    }
  }
}

function clearPatch(canvas, canvasWidth, canvasHeight, frame) {
  const { left, top, width, height } = frame.dims;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetX = left + x;
      const targetY = top + y;
      if (targetX < 0 || targetX >= canvasWidth || targetY < 0 || targetY >= canvasHeight) {
        continue;
      }
      const targetIndex = (targetY * canvasWidth + targetX) * 4;
      canvas[targetIndex] = 0;
      canvas[targetIndex + 1] = 0;
      canvas[targetIndex + 2] = 0;
      canvas[targetIndex + 3] = 0;
    }
  }
}

function alphaCoverage(buffer) {
  let visible = 0;
  for (let index = 3; index < buffer.length; index += 4) {
    if (buffer[index] > 8) {
      visible += 1;
    }
  }
  return visible / (buffer.length / 4);
}

async function renderCell(frames, state, column) {
  const source = frames[(column + state.frameOffset) % frames.length];
  const phase = (column / columns) * Math.PI * 2;
  const jump = state.jump ? Math.max(0, Math.sin((column / (columns - 1)) * Math.PI)) * state.jump : 0;
  const yOffset = Math.round(-Math.sin(phase) * (state.bounce ?? 0) - jump);
  const xOffset =
    Math.round(Math.sin(phase) * (state.xWave ?? 0)) +
    (state.shake ? (column % 2 === 0 ? -state.shake : state.shake) : 0);
  const rotate = state.rotateWave ? Math.round(Math.sin(phase) * state.rotateWave) : 0;

  let sprite = sharp(source.buffer, {
    raw: {
      width: source.width,
      height: source.height,
      channels: 4
    }
  }).trim({ background: transparent, threshold: 0 });

  if (state.flip) {
    sprite = sprite.flop();
  }
  if (state.muted) {
    sprite = sprite.grayscale().modulate({ brightness: 0.8 });
  }

  const limit = Math.round(92 * (state.scale ?? 1.5));
  sprite = applySpriteResize(sprite, {
    width: limit,
    height: limit
  }).rotate(rotate, { background: transparent });

  const { data, info } = await sprite.png().toBuffer({ resolveWithObject: true });
  const left = clamp(Math.round((frameWidth - info.width) / 2 + xOffset), 2, frameWidth - info.width - 2);
  const top = clamp(Math.round(frameHeight - 32 - info.height + yOffset), 4, frameHeight - info.height - 8);

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

  await sharp({
    create: {
      width: frameWidth * rows,
      height: frameHeight,
      channels: 4,
      background: transparent
    }
  })
    .composite(composites)
    .png()
    .toFile(path.join(targetDir, "preview.png"));
}

async function writePreviewGallery({ petsDir, slugs, fileName }) {
  const sortedSlugs = [...slugs].sort();
  const previewWidth = frameWidth * rows;
  const labelHeight = 38;
  const rowHeight = frameHeight + labelHeight;
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
        <text x="12" y="25" font-family="Arial, sans-serif" font-size="20" fill="#18202f">${escapeXml(slug)}</text>
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

async function mapLimit(items, limit, mapper) {
  const executing = new Set();
  for (const item of items) {
    const promise = Promise.resolve().then(() => mapper(item));
    executing.add(promise);
    promise.finally(() => executing.delete(promise));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

export function titleCasePokemon(name) {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => {
      if (part === "f") return "Female";
      if (part === "m") return "Male";
      if (part === "gmax") return "Gmax";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
