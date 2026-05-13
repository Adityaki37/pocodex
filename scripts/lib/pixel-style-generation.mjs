import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import sharp from "sharp";

export const frameWidth = 192;
export const frameHeight = 208;
export const atlasColumns = 8;
export const atlasRows = 9;
export const spriteMaxWidth = 168;
export const spriteMaxHeight = 184;
export const spriteBottomPadding = 12;
export const sourceFrameMaxHeight = frameHeight - spriteBottomPadding - 4;
export const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
export const pixelStyleGenerationSource = "source-frame-canonical-v6";

const parser = new XMLParser({ ignoreAttributes: false });

const defaultWebpOptions = { quality: 96, alphaQuality: 100, effort: 6, smartSubsample: false };

export const pixelQualityStyles = [
  {
    id: "original-unchanged",
    label: "Original",
    description: "PMDCollab source pixels preserved with clean integer nearest-neighbor scaling.",
    rendering: "pixelated",
    kernel: "nearest",
    integerScale: true,
    webp: { lossless: true, effort: 6 }
  },
  {
    id: "scale2x",
    label: "Scale2x",
    description: "Classic Scale2x-style hard edge expansion.",
    rendering: "pixelated",
    kernel: "nearest",
    scale2xPasses: 1,
    pixelAdjust: {
      contrast: 1.015,
      saturation: 1.01,
      outlineDarken: 0.94,
      outlineThreshold: 90
    },
    webp: { lossless: true, effort: 6 }
  },
  {
    id: "epx",
    label: "EPX",
    description: "EPX-style edge-preserving pixel expansion.",
    rendering: "pixelated",
    kernel: "nearest",
    scale2xPasses: 1,
    pixelAdjust: {
      contrast: 1.05,
      saturation: 1.04,
      outlineDarken: 0.82,
      outlineThreshold: 92
    },
    webp: { lossless: true, effort: 6 }
  },
  {
    id: "plain-xbrz",
    label: "xBRZ",
    description: "xBRZ-style edge expansion without extra sharpening or contrast restoration.",
    rendering: "auto",
    kernel: "lanczos3",
    scale2xPasses: 2,
    webp: { quality: 96, alphaQuality: 100, effort: 6, smartSubsample: false }
  },
  {
    id: "hq4x",
    label: "HQ4-Smooth",
    description: "HQ4x-inspired smooth edge treatment with restored line contrast.",
    rendering: "auto",
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
    },
    webp: { quality: 96, alphaQuality: 100, effort: 6, smartSubsample: false }
  }
];

export const pixelQualityStylesById = new Map(pixelQualityStyles.map((style) => [style.id, style]));

export function pixelStyleFingerprint(style) {
  return createHash("sha256").update(stableStringify(style)).digest("hex").slice(0, 16);
}

export const defaultManifestStates = [
  { key: "idle", row: 0, frames: 6 },
  { key: "run-right", row: 1, frames: 8 },
  { key: "run-left", row: 2, frames: 8 },
  { key: "waving", row: 3, frames: 4 },
  { key: "jumping", row: 4, frames: 5 },
  { key: "failed", row: 5, frames: 8 },
  { key: "waiting", row: 6, frames: 6 },
  { key: "running", row: 7, frames: 6 },
  { key: "review", row: 8, frames: 6 }
];

export async function createPixelStyleSourceContext(sourcePet) {
  const motionSource = sourcePet?.motionSource;
  if (!motionSource?.baseUrl || !motionSource?.animDataUrl || !Array.isArray(motionSource.rowSources)) {
    throw new Error(`${sourcePet?.id ?? "source pet"} is missing original motion source metadata`);
  }

  return {
    sourcePet,
    motionSource,
    animMap: parseAnimData(await fetchText(motionSource.animDataUrl)),
    assetCache: new Map()
  };
}

export async function writePixelStyleSpritesheetFromMotionSource({
  context,
  sourcePet,
  style,
  outputPath,
  states = defaultManifestStates
}) {
  const renderContext = context ?? await createPixelStyleSourceContext(sourcePet);
  const composites = [];

  for (let row = 0; row < atlasRows; row += 1) {
    const manifestState = states.find((state) => Number(state.row) === row) ?? defaultManifestStates[row];
    const rowSource = findRowSource(renderContext.motionSource.rowSources, row, manifestState);
    if (!rowSource) {
      throw new Error(`${renderContext.sourcePet.id} is missing row source metadata for row ${row}`);
    }

    const cells = await renderSourceRow(renderContext, rowSource, manifestState, style);
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
      width: frameWidth * atlasColumns,
      height: frameHeight * atlasRows,
      channels: 4,
      background: transparent
    }
  })
    .composite(composites)
    .png()
    .toBuffer();

  await sharp(pngBuffer)
    .webp(resolveWebpOptions(style))
    .toFile(outputPath);
}

export async function writePixelStyleMotionSheetFromMotionSource({
  context,
  sourcePet,
  action,
  style,
  outputPath
}) {
  const renderContext = context ?? await createPixelStyleSourceContext(sourcePet);
  const resolved = resolveAnimation(renderContext.animMap, action);
  if (!resolved) {
    throw new Error(`${renderContext.sourcePet.id} has no usable animation for ${action}`);
  }

  const pngBuffer = await fetchBuffer(`${trimTrailingSlash(renderContext.motionSource.baseUrl)}/${resolved.assetAction}-Anim.png`);
  const metadata = await sharp(pngBuffer).metadata();
  const sourceFrameCount = Math.max(1, Math.floor(metadata.width / resolved.frameWidth));
  const directionCount = Math.max(1, Math.floor(metadata.height / resolved.frameHeight));
  const composites = [];

  for (let direction = 0; direction < directionCount; direction += 1) {
    const frames = [];
    for (let frameIndex = 0; frameIndex < sourceFrameCount; frameIndex += 1) {
      frames.push(
        {
          raw: await sharp(pngBuffer)
          .extract({
            left: frameIndex * resolved.frameWidth,
            top: direction * resolved.frameHeight,
            width: resolved.frameWidth,
            height: resolved.frameHeight
          })
          .ensureAlpha()
          .raw()
          .toBuffer(),
          width: resolved.frameWidth,
          height: resolved.frameHeight,
          motion: null,
          cellIndex: frameIndex,
          totalCells: sourceFrameCount
        }
      );
    }

    for (const frame of frames) {
      frame.crop = alphaBox(frame.raw, frame.width, frame.height);
    }

    const cells = await framesToCells(frames, style);
    for (let frameIndex = 0; frameIndex < sourceFrameCount; frameIndex += 1) {
      composites.push({
        input: cells[frameIndex],
        left: frameIndex * frameWidth,
        top: direction * frameHeight
      });
    }
  }

  const pngSheet = await sharp({
    create: {
      width: frameWidth * sourceFrameCount,
      height: frameHeight * directionCount,
      channels: 4,
      background: transparent
    }
  })
    .composite(composites)
    .png()
    .toBuffer();

  await sharp(pngSheet)
    .webp(resolveWebpOptions(style))
    .toFile(outputPath);
}

export function pixelStyleId(pet) {
  return String(pet?.pixelStyle?.id ?? pet?.variant ?? "");
}

async function renderSourceRow(context, rowSource, manifestState, style) {
  const choice = resolveRowAnimation(context.animMap, rowSource);
  if (!choice) {
    throw new Error(`${context.sourcePet.id} has no usable animation for ${rowSource.state ?? manifestState.key}`);
  }

  if (!context.assetCache.has(choice.assetAction)) {
    context.assetCache.set(choice.assetAction, await fetchBuffer(`${trimTrailingSlash(context.motionSource.baseUrl)}/${choice.assetAction}-Anim.png`));
  }

  const stateSpec = resolveStateRenderSpec(rowSource.state ?? manifestState.key);
  const frames = await extractAnimationFrames(
    context.assetCache.get(choice.assetAction),
    choice.anim,
    Number(rowSource.direction ?? 0),
    {
      ...stateSpec,
      usedFrames: Number(manifestState.frames ?? stateSpec.usedFrames ?? 1)
    }
  );

  return framesToCells(frames, style);
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
    assetAction: assetAction || resolved.assetAction
  };
}

async function extractAnimationFrames(pngBuffer, anim, choiceDirection, state) {
  const metadata = await sharp(pngBuffer).metadata();
  const sourceFrameCount = Math.floor(metadata.width / anim.frameWidth);
  const directionCount = Math.max(1, Math.floor(metadata.height / anim.frameHeight));
  const neededFrames = Math.max(1, Number(state.usedFrames) || 1);
  const usedDirection = choiceDirection < directionCount ? choiceDirection : 0;
  const selectedIndices = sampleFrameIndices(sourceFrameCount, neededFrames, state.sample);
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
  if (state.cropMode !== "per-frame" && !unionBox) {
    throw new Error(`${anim.name} direction ${usedDirection} contains no visible pixels`);
  }

  return Array.from({ length: neededFrames }, (_, index) => ({
    raw: fullFrames[index],
    width: anim.frameWidth,
    height: anim.frameHeight,
    crop: state.cropMode === "per-frame" ? alphaBox(fullFrames[index], anim.frameWidth, anim.frameHeight) : unionBox,
    motion: state.motion ?? null,
    direction: usedDirection,
    sourceFrameCount,
    cellIndex: index,
    totalCells: neededFrames
  })).filter((frame) => frame.crop);
}

async function framesToCells(frames, style) {
  const renderedFrames = await Promise.all(frames.map((frame) => renderSourceFrameWithPixelStyle(frame, style)));
  if (renderedFrames.length === 0) {
    return [];
  }
  const { info } = renderedFrames[0];
  const rowBounds = unionRenderedAlphaBox(renderedFrames, info.width, info.height);
  const left = Math.round((frameWidth - info.width) / 2);
  const top = rowBounds
    ? Math.max(4, Math.round(frameHeight - spriteBottomPadding - (rowBounds.top + rowBounds.height - 1)))
    : Math.round(frameHeight - spriteBottomPadding - info.height);
  return Promise.all(renderedFrames.map((renderedFrame) => renderedFrameToCell(renderedFrame, { left, top })));
}

async function renderedFrameToCell({ input }, { left, top }) {

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

async function renderSourceFrameWithPixelStyle(frame, style) {
  const crop = frame.crop ?? { left: 0, top: 0, width: frame.width, height: frame.height };
  let imageBuffer = await sharp(frame.raw, {
    raw: { width: frame.width, height: frame.height, channels: 4 }
  })
    .extract(crop)
    .png()
    .toBuffer();

  for (let pass = 0; pass < (style.scale2xPasses ?? 0); pass += 1) {
    imageBuffer = await scale2xBuffer(imageBuffer);
  }

  let image = sharp(imageBuffer);
  if (style.preScaleNearest) {
    const meta = await image.metadata();
    imageBuffer = await image
      .resize({
        width: Math.max(1, Math.round(meta.width * style.preScaleNearest)),
        height: Math.max(1, Math.round(meta.height * style.preScaleNearest)),
        kernel: sharp.kernel.nearest,
        fit: "fill",
        withoutEnlargement: false
      })
      .png()
      .toBuffer();
    image = sharp(imageBuffer);
  }

  const kernel = resolveKernel(style.kernel);
  const resizedWithIntegerScale = style.integerScale && kernel === sharp.kernel.nearest
    ? await resizeWithIntegerScale(image, frameWidth, sourceFrameMaxHeight)
    : null;
  image = resizedWithIntegerScale ?? image.resize({
    width: frameWidth,
    height: sourceFrameMaxHeight,
    fit: "inside",
    kernel,
    withoutEnlargement: false
  });

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

  imageBuffer = await image.png().toBuffer();

  if (style.pixelAdjust) {
    imageBuffer = await adjustPixels(imageBuffer, style.pixelAdjust);
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

export async function resizeCropWithPixelStyle(cropBuffer, style, options = {}) {
  const targetWidth = options.width ?? spriteMaxWidth;
  const targetHeight = options.height ?? spriteMaxHeight;
  let imageBuffer = cropBuffer;

  for (let pass = 0; pass < (style.scale2xPasses ?? 0); pass += 1) {
    imageBuffer = await scale2xBuffer(imageBuffer);
  }

  let image = sharp(imageBuffer);
  if (style.preScaleNearest) {
    const meta = await image.metadata();
    imageBuffer = await image
      .resize({
        width: Math.max(1, Math.round(meta.width * style.preScaleNearest)),
        height: Math.max(1, Math.round(meta.height * style.preScaleNearest)),
        kernel: sharp.kernel.nearest,
        fit: "fill",
        withoutEnlargement: false
      })
      .png()
      .toBuffer();
    image = sharp(imageBuffer);
  }

  const kernel = resolveKernel(style.kernel);
  const resizedWithIntegerAlphaScale = style.integerAlphaScale && kernel === sharp.kernel.nearest
    ? await resizeWithIntegerAlphaScale(image, targetWidth, targetHeight, style)
    : null;
  const resizedWithIntegerScale = !resizedWithIntegerAlphaScale && style.integerScale && kernel === sharp.kernel.nearest
    ? await resizeWithIntegerScale(image, targetWidth, targetHeight)
    : null;
  image = resizedWithIntegerAlphaScale ?? resizedWithIntegerScale ?? image.resize({
    width: targetWidth,
    height: targetHeight,
    fit: "inside",
    kernel,
    withoutEnlargement: false
  });

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

  imageBuffer = await image.png().toBuffer();

  if (style.pixelAdjust) {
    imageBuffer = await adjustPixels(imageBuffer, style.pixelAdjust);
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

function findRowSource(rowSources, row, manifestState) {
  return rowSources.find((rowSource) => Number(rowSource.row) === row) ??
    rowSources.find((rowSource) => normalizeStateKey(rowSource.state) === normalizeStateKey(manifestState.key));
}

function resolveStateRenderSpec(key) {
  const normalized = normalizeStateKey(key);
  if (normalized === "waving") {
    return { sample: "spread", cropMode: "per-frame" };
  }
  if (normalized === "jumping") {
    return { sample: "spread", cropMode: "per-frame", motion: "jump" };
  }
  if (normalized === "failed") {
    return { sample: "spread" };
  }
  return { sample: "cycle" };
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

function normalizeStateKey(key) {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (normalized === "run-right") {
    return "running-right";
  }
  if (normalized === "run-left") {
    return "running-left";
  }
  return normalized;
}

function resolveKernel(kernel) {
  return sharp.kernel[kernel] ?? sharp.kernel.lanczos3;
}

function resolveWebpOptions(style) {
  return style?.webp ?? defaultWebpOptions;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function resizeWithIntegerScale(image, targetWidth = spriteMaxWidth, targetHeight = spriteMaxHeight) {
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

async function resizeWithIntegerAlphaScale(image, targetWidth = spriteMaxWidth, targetHeight = spriteMaxHeight, style = {}) {
  const { data, info } = await image
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = tightAlphaBox(data, info.width, info.height);
  if (!bounds) {
    return null;
  }

  const visibleTargetWidth = style.visibleTargetWidth ?? targetWidth;
  const visibleTargetHeight = style.visibleTargetHeight ?? targetHeight;
  const visibleScale = Math.min(
    Math.floor(visibleTargetWidth / Math.max(1, bounds.width)),
    Math.floor(visibleTargetHeight / Math.max(1, bounds.height))
  );
  const frameScale = Math.min(
    Math.floor((frameWidth - 8) / Math.max(1, info.width)),
    Math.floor((frameHeight - spriteBottomPadding - 4) / Math.max(1, info.height))
  );
  const scale = Math.max(1, Math.min(visibleScale, frameScale));

  return image.resize({
    width: info.width * scale,
    height: info.height * scale,
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

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function fetchText(url) {
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || !isRetryableStatus(response.status) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }
    }
    await sleep(300 * attempt * attempt);
  }
  throw lastError ?? new Error(`Unable to fetch ${url}`);
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
