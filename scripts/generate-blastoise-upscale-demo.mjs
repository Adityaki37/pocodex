import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "public", "pocodex", "quality", "blastoise");

const sourceBase = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master";
const pokemonId = "0009";
const frameWidth = 192;
const frameHeight = 208;
const columns = 8;
const rows = 9;
const spriteMaxWidth = 168;
const spriteMaxHeight = 184;
const spriteBottomPadding = 12;
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const parser = new XMLParser({ ignoreAttributes: false });

const states = [
  { key: "idle", usedFrames: 6, action: "Idle", direction: 1, sample: "cycle" },
  { key: "running-right", usedFrames: 8, action: "Walk", direction: 2, sample: "cycle" },
  { key: "running-left", usedFrames: 8, action: "Walk", direction: 6, sample: "cycle" },
  { key: "waving", usedFrames: 4, action: "Swing", direction: 1, sample: "spread", cropMode: "per-frame" },
  { key: "jumping", usedFrames: 5, action: "Hop", direction: 1, sample: "spread", cropMode: "per-frame", motion: "jump" },
  { key: "failed", usedFrames: 8, action: "Hurt", direction: 1, sample: "spread" },
  { key: "waiting", usedFrames: 6, action: "Sleep", direction: 0, sample: "cycle" },
  { key: "running", usedFrames: 6, action: "Walk", direction: 0, sample: "cycle" },
  { key: "review", usedFrames: 6, action: "Charge", direction: 1, sample: "cycle" }
];

const methods = [
  {
    id: "nearest",
    label: "Nearest-Neighbor Pixelate",
    kernel: sharp.kernel.nearest
  },
  {
    id: "lanczos-sharp",
    label: "Lanczos3 + Unsharp Mask",
    kernel: sharp.kernel.lanczos3,
    sharpen: { sigma: 0.45, m1: 1, m2: 1.55 }
  },
  {
    id: "mks2021-soft",
    label: "MKS2021 Resample",
    kernel: sharp.kernel.mks2021
  },
  {
    id: "inked-crisp",
    label: "Unsharp Mask + Contrast",
    kernel: sharp.kernel.lanczos3,
    scale2xPasses: 1,
    sharpen: { sigma: 0.72, m1: 0.45, m2: 2.35, x1: 2.2, y2: 8, y3: 24 },
    pixelAdjust: {
      contrast: 1.16,
      saturation: 1.1,
      outlineDarken: 0.58,
      outlineThreshold: 112,
      alphaSnapLow: 5,
      alphaSnapHigh: 245
    }
  },
  {
    id: "depixel-polish",
    label: "Scale2x + MKS2021 Polish",
    kernel: sharp.kernel.mks2021,
    scale2xPasses: 2,
    sharpen: { sigma: 0.5, m1: 0.35, m2: 1.45, x1: 2.8, y2: 8, y3: 14 },
    pixelAdjust: {
      contrast: 1.05,
      saturation: 1.06,
      outlineDarken: 0.78,
      outlineThreshold: 92
    }
  },
  {
    id: "hq4x",
    label: "HQ4x-Style Smooth",
    kernel: sharp.kernel.mks2021,
    scale2xPasses: 2,
    sharpen: { sigma: 0.42, m1: 0.25, m2: 1.2, x1: 2.2, y2: 6, y3: 10 },
    pixelAdjust: {
      contrast: 1.04,
      saturation: 1.04,
      outlineDarken: 0.82,
      outlineThreshold: 86
    }
  }
];

await main();

async function main() {
  await mkdir(outputDir, { recursive: true });
  const animData = await fetchText(`${sourceBase}/sprite/${pokemonId}/AnimData.xml`);
  const animMap = parseAnimData(animData);
  const assetCache = new Map();
  const manifest = [];

  for (const method of methods) {
    const composites = [];
    for (let row = 0; row < rows; row += 1) {
      const state = states[row];
      const cells = await renderStateRow(animMap, state, assetCache, method);
      for (let column = 0; column < cells.length; column += 1) {
        composites.push({
          input: cells[column],
          left: column * frameWidth,
          top: row * frameHeight
        });
      }
    }

    const pngBuffer = await sharp({
      create: {
        width: frameWidth * columns,
        height: frameHeight * rows,
        channels: 4,
        background: transparent
      }
    })
      .composite(composites)
      .png()
      .toBuffer();

    const outputPath = path.join(outputDir, `${method.id}.webp`);
    await sharp(pngBuffer)
      .webp({ quality: 88, alphaQuality: 95, effort: 6, smartSubsample: true })
      .toFile(outputPath);

    manifest.push({
      id: method.id,
      label: method.label,
      spritesheet: `/pocodex/quality/blastoise/${method.id}.webp`,
      rendering: method.id === "nearest" ? "pixelated" : "auto"
    });
    console.log(`Wrote ${outputPath}`);
  }

  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify({ methods: manifest }, null, 2)}\n`);
}

async function renderStateRow(animMap, state, assetCache, method) {
  const anim = resolveAnimation(animMap, state.action);
  if (!anim) {
    throw new Error(`Blastoise has no ${state.action} animation`);
  }

  if (!assetCache.has(anim.assetAction)) {
    assetCache.set(anim.assetAction, await fetchBuffer(`${sourceBase}/sprite/${pokemonId}/${anim.assetAction}-Anim.png`));
  }

  const frames = await extractAnimationFrames(assetCache.get(anim.assetAction), anim, state);
  return Promise.all(frames.map((frame) => frameToCell(frame, method)));
}

async function extractAnimationFrames(pngBuffer, anim, state) {
  const metadata = await sharp(pngBuffer).metadata();
  const sourceFrameCount = Math.floor(metadata.width / anim.frameWidth);
  const directionCount = Math.max(1, Math.floor(metadata.height / anim.frameHeight));
  const usedDirection = state.direction < directionCount ? state.direction : 0;
  const selectedIndices = sampleFrameIndices(sourceFrameCount, state.usedFrames, state.sample);
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

  const unionBox = state.cropMode === "per-frame" ? null : unionAlphaBox(fullFrames, anim.frameWidth, anim.frameHeight);
  return fullFrames
    .map((frame, index) => ({
      raw: frame,
      width: anim.frameWidth,
      height: anim.frameHeight,
      crop: state.cropMode === "per-frame" ? alphaBox(frame, anim.frameWidth, anim.frameHeight) : unionBox,
      cellIndex: index,
      totalCells: fullFrames.length,
      motion: state.motion ?? null
    }))
    .filter((frame) => frame.crop);
}

async function frameToCell(frame, method) {
  const cropBuffer = await sharp(frame.raw, {
    raw: { width: frame.width, height: frame.height, channels: 4 }
  })
    .extract(frame.crop)
    .png()
    .toBuffer();

  const { data, info } = await resizeCrop(cropBuffer, method);
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

async function resizeCrop(cropBuffer, method) {
  let imageBuffer = cropBuffer;

  for (let pass = 0; pass < (method.scale2xPasses ?? 0); pass += 1) {
    imageBuffer = await scale2xBuffer(imageBuffer);
  }

  let image = sharp(imageBuffer);
  if (method.preScaleNearest) {
    const meta = await image.metadata();
    imageBuffer = await image.resize({
      width: Math.max(1, Math.round(meta.width * method.preScaleNearest)),
      height: Math.max(1, Math.round(meta.height * method.preScaleNearest)),
      kernel: sharp.kernel.nearest,
      fit: "fill",
      withoutEnlargement: false
    })
      .png()
      .toBuffer();
    image = sharp(imageBuffer);
  }

  image = image.resize({
    width: spriteMaxWidth,
    height: spriteMaxHeight,
    fit: "inside",
    kernel: method.kernel,
    withoutEnlargement: false
  });

  if (method.sharpen) {
    image = image.sharpen(method.sharpen);
  }

  imageBuffer = await image.png().toBuffer();

  if (method.pixelAdjust) {
    imageBuffer = await adjustPixels(imageBuffer, method.pixelAdjust);
  }

  return sharp(imageBuffer).png().toBuffer({ resolveWithObject: true });
}

async function scale2xBuffer(inputBuffer) {
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

async function adjustPixels(inputBuffer, options) {
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
      alpha = 255;
      output[index + 3] = 255;
    }

    let r = output[index];
    let g = output[index + 1];
    let b = output[index + 2];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    r = luminance + (r - luminance) * saturation;
    g = luminance + (g - luminance) * saturation;
    b = luminance + (b - luminance) * saturation;

    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    if (luminance < outlineThreshold && alpha > 80) {
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
  const offset = (clampedY * width + clampedX) * 4;
  return [
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3]
  ];
}

function samePixel(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function writePixel(output, width, x, y, pixel) {
  const offset = (y * width + x) * 4;
  output[offset] = pixel[0];
  output[offset + 1] = pixel[1];
  output[offset + 2] = pixel[2];
  output[offset + 3] = pixel[3];
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
  const indices = [];
  for (let index = 0; index < neededFrames; index += 1) {
    indices.push(mode === "spread" && neededFrames > 1 && sourceFrameCount > 1
      ? Math.round((index / (neededFrames - 1)) * (sourceFrameCount - 1))
      : index % sourceFrameCount);
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

function alphaBox(frame, width, height) {
  return unionAlphaBox([frame], width, height);
}

function normalizeArray(value) {
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
