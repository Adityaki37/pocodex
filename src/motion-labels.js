const MOTION_LABEL_SCOPE =
  ".motion-library, .state-viewer, .state-grid, .viewer-heading";

function formatMotionLabel(value) {
  return String(value ?? "")
    .replace(/MultiStrike/g, "Multi Strike")
    .replace(/\b([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function normalizeTextNode(node) {
  const next = formatMotionLabel(node.nodeValue);
  if (next !== node.nodeValue) {
    node.nodeValue = next;
  }
}

function normalizeElement(element) {
  for (const target of [element, ...element.querySelectorAll("[aria-label], [title]")]) {
    for (const attr of ["aria-label", "title"]) {
      const value = target.getAttribute(attr);
      if (value) {
        const next = formatMotionLabel(value);
        if (next !== value) target.setAttribute(attr, next);
      }
    }
  }

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, code, pre")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach(normalizeTextNode);
}

function normalizeMotionLabels() {
  document.querySelectorAll(MOTION_LABEL_SCOPE).forEach(normalizeElement);
}

let queued = false;
function queueNormalize() {
  if (queued) return;
  queued = true;
  window.requestAnimationFrame(() => {
    queued = false;
    normalizeMotionLabels();
  });
}

function startMotionLabelNormalizer() {
  normalizeMotionLabels();
  new MutationObserver(queueNormalize).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "title"],
  });
  window.setInterval(normalizeMotionLabels, 50);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startMotionLabelNormalizer, {
    once: true,
  });
} else {
  startMotionLabelNormalizer();
}
