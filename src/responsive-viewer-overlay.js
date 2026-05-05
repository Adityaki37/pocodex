const VIEWER_SELECTOR = ".state-viewer .viewer-stage";
const FRAME_SELECTOR = ".sprite-frame, .motion-frame-canvas";
const BASE_FRAME_WIDTH = 384;
const BASE_FRAME_HEIGHT = 416;
const MIN_SCALE = 0.42;
const MAX_SCALE = 1;
const STAGE_PADDING = 20;

const imageCache = new Map();
const boundsCache = new Map();
let scheduled = false;

const observer = new MutationObserver(scheduleViewerFit);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["style", "class"]
});

window.addEventListener("resize", scheduleViewerFit, { passive: true });
window.addEventListener("orientationchange", scheduleViewerFit);
window.addEventListener("hashchange", scheduleViewerFit);
document.addEventListener("DOMContentLoaded", scheduleViewerFit);
window.setInterval(scheduleViewerFit, 600);
scheduleViewerFit();

function scheduleViewerFit() {
  if (scheduled) {
    return;
  }

  scheduled = true;
  window.requestAnimationFrame(() => {
    scheduled = false;
    fitViewerSprites();
  });
}

function fitViewerSprites() {
  for (const stage of document.querySelectorAll(VIEWER_SELECTOR)) {
    const frame = stage.querySelector(FRAME_SELECTOR);
    if (!frame) {
      continue;
    }

    if (frame.classList.contains("sprite-frame")) {
      fitAtlasSprite(stage, frame);
      continue;
    }

    fitCanvasSprite(stage, frame);
  }
}

async function fitAtlasSprite(stage, frame) {
  const stageBox = stage.getBoundingClientRect();
  const availableWidth = Math.max(1, stageBox.width - STAGE_PADDING * 2);
  const availableHeight = Math.max(1, stageBox.height - STAGE_PADDING * 2);
  const naturalWidth = parseFloat(frame.style.width) || BASE_FRAME_WIDTH;
  const naturalHeight = parseFloat(frame.style.height) || BASE_FRAME_HEIGHT;
  const fallbackBounds = {
    left: 0,
    top: 0,
    width: naturalWidth,
    height: naturalHeight
  };
  const bounds = await measureVisibleBounds(frame, naturalWidth, naturalHeight) || fallbackBounds;
  const fitScale = clamp(Math.min(availableWidth / bounds.width, availableHeight / bounds.height), MIN_SCALE, MAX_SCALE);
  const frameCenterX = naturalWidth / 2;
  const frameCenterY = naturalHeight / 2;
  const spriteCenterX = bounds.left + bounds.width / 2;
  const spriteCenterY = bounds.top + bounds.height / 2;
  const offsetX = (frameCenterX - spriteCenterX) * fitScale;
  const offsetY = (frameCenterY - spriteCenterY) * fitScale;

  applyFit(stage, frame, naturalWidth, naturalHeight, fitScale, offsetX, offsetY);
}

function fitCanvasSprite(stage, frame) {
  const stageBox = stage.getBoundingClientRect();
  const availableWidth = Math.max(1, stageBox.width - STAGE_PADDING * 2);
  const availableHeight = Math.max(1, stageBox.height - STAGE_PADDING * 2);
  const naturalWidth = parseFloat(frame.style.width) || frame.width || BASE_FRAME_WIDTH;
  const naturalHeight = parseFloat(frame.style.height) || frame.height || BASE_FRAME_HEIGHT;
  const fitScale = clamp(Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight), MIN_SCALE, MAX_SCALE);

  applyFit(stage, frame, naturalWidth, naturalHeight, fitScale, 0, 0);
}

function applyFit(stage, frame, naturalWidth, naturalHeight, fitScale, offsetX, offsetY) {
  const nextPosition = "absolute";
  const nextLeft = `calc(50% - ${round(naturalWidth / 2)}px)`;
  const nextTop = `calc(50% - ${round(naturalHeight / 2)}px)`;
  const nextTransform = `matrix(${round(fitScale)}, 0, 0, ${round(fitScale)}, ${round(offsetX)}, ${round(offsetY)})`;

  if (frame.style.position !== nextPosition) {
    frame.style.position = nextPosition;
  }
  if (frame.style.left !== nextLeft) {
    frame.style.left = nextLeft;
  }
  if (frame.style.top !== nextTop) {
    frame.style.top = nextTop;
  }

  if (frame.style.transform !== nextTransform) {
    frame.style.transform = nextTransform;
    frame.style.transformOrigin = "center center";
  }

  if (stage.style.setProperty) {
    stage.style.setProperty("--viewer-frame-width", `${Math.ceil(naturalWidth * fitScale)}px`);
    stage.style.setProperty("--viewer-frame-height", `${Math.ceil(naturalHeight * fitScale)}px`);
  }
}

async function measureVisibleBounds(frame, frameWidth, frameHeight) {
  const styles = window.getComputedStyle(frame);
  const imageUrl = parseBackgroundUrl(styles.backgroundImage);
  if (!imageUrl || styles.backgroundImage === "none") {
    return null;
  }

  const backgroundSize = parseSizePair(styles.backgroundSize);
  const backgroundPosition = parsePositionPair(styles.backgroundPosition);
  if (!backgroundSize || !backgroundPosition) {
    return null;
  }

  const cacheKey = [
    imageUrl,
    backgroundSize.width,
    backgroundSize.height,
    backgroundPosition.x,
    backgroundPosition.y,
    frameWidth,
    frameHeight
  ].join("|");

  if (boundsCache.has(cacheKey)) {
    return boundsCache.get(cacheKey);
  }

  const image = await loadImage(imageUrl);
  if (!image) {
    return null;
  }

  const atlasScaleX = image.naturalWidth / backgroundSize.width;
  const atlasScaleY = image.naturalHeight / backgroundSize.height;
  const sourceX = Math.max(0, -backgroundPosition.x * atlasScaleX);
  const sourceY = Math.max(0, -backgroundPosition.y * atlasScaleY);
  const sourceWidth = Math.min(image.naturalWidth - sourceX, frameWidth * atlasScaleX);
  const sourceHeight = Math.min(image.naturalHeight - sourceY, frameHeight * atlasScaleY);

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(frameWidth));
  canvas.height = Math.max(1, Math.round(frameHeight));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = pixels[(y * canvas.width + x) * 4 + 3];
      if (alpha < 8) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const bounds = maxX >= 0
    ? {
        left: minX,
        top: minY,
        width: Math.max(1, maxX - minX + 1),
        height: Math.max(1, maxY - minY + 1)
      }
    : null;

  boundsCache.set(cacheKey, bounds);
  return bounds;
}

async function loadImage(url) {
  if (imageCache.has(url)) {
    return imageCache.get(url);
  }

  const promise = new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

function parseBackgroundUrl(value) {
  const match = value.match(/^url\(["']?(.+?)["']?\)$/);
  if (!match) {
    return null;
  }

  return new URL(match[1], window.location.href).href;
}

function parseSizePair(value) {
  const parts = value.split(/\s+/).map((part) => parseFloat(part));
  if (parts.length < 2 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  return {
    width: parts[0],
    height: parts[1]
  };
}

function parsePositionPair(value) {
  const parts = value.split(/\s+/).map((part) => parseFloat(part));
  if (parts.length < 2 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  return {
    x: parts[0],
    y: parts[1]
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Number(value.toFixed(4));
}
