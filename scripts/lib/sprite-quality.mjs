import { writeFileSync } from "fs";
import sharp from "sharp";

const smoothKernel = sharp.kernel.lanczos3;
const sharpenSettings = { sigma: 0.45, m1: 1, m2: 1.55 };
export const spriteWebpOptions = {
  quality: 35,
  alphaQuality: 70,
  effort: 6,
  smartSubsample: true
};

export function spriteQualityMode() {
  return process.env.POCODEX_SPRITE_QUALITY === "nearest" ? "nearest" : "smooth";
}

export function applySpriteResize(image, options) {
  const mode = spriteQualityMode();
  const resized = image.resize({
    ...options,
    fit: options.fit ?? "inside",
    kernel: mode === "nearest" ? sharp.kernel.nearest : smoothKernel,
    withoutEnlargement: options.withoutEnlargement ?? false
  });

  return mode === "nearest" ? resized : resized.sharpen(sharpenSettings);
}

export async function resizeSpriteBuffer(input, options) {
  return applySpriteResize(sharp(input), options).png().toBuffer({ resolveWithObject: true });
}

export async function writeCompositeSpriteWebp({ width, height, background, composites, outputPath }) {
  traceQuality(`compose start ${outputPath}`);
  const pngBuffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background
    }
  })
    .composite(composites)
    .png()
    .toBuffer();
  traceQuality(`compose png ${pngBuffer.length} bytes`);

  const webpBuffer = await sharp(pngBuffer).webp(spriteWebpOptions).toBuffer();
  traceQuality(`encode webp ${webpBuffer.length} bytes`);
  writeFileSync(outputPath, webpBuffer);
  traceQuality("write webp complete");
}

export async function writeSpriteWebp(image, outputPath) {
  traceQuality(`sprite webp start ${outputPath}`);
  const pngBuffer = await image.png().toBuffer();
  traceQuality(`sprite png ${pngBuffer.length} bytes`);
  const webpBuffer = await sharp(pngBuffer).webp(spriteWebpOptions).toBuffer();
  traceQuality(`sprite webp ${webpBuffer.length} bytes`);
  writeFileSync(outputPath, webpBuffer);
  traceQuality("sprite write complete");
}

function traceQuality(message) {
  if (process.env.POCODEX_TRACE_QUALITY === "1") {
    console.error(`[sprite-quality] ${message}`);
  }
}
