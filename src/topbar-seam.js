const HIT_SEGMENTS = [
  { className: "lower", label: "Pokedex hinge lower line", style: { left: "0", top: "55px", width: "46%" } },
  { className: "rise", label: "Pokedex hinge angled line", style: { left: "45.5%", top: "26px", width: "10.5%" } },
  { className: "upper", label: "Pokedex hinge upper line", style: { left: "54.8%", top: "8px", width: "51.2%" } },
];

function createVisualSeam() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "topbar-seam-visual");
  svg.setAttribute("viewBox", "0 0 1000 120");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const shadow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shadow.setAttribute("class", "topbar-seam-shadow");
  shadow.setAttribute("d", "M-120 92 H452 C468 92 478 88 490 76 L528 24 C540 12 550 10 565 10 H1120");

  svg.append(shadow);
  return svg;
}

function createHitSegment({ className, label, style }) {
  const segment = document.createElement("span");
  segment.className = `topbar-seam-hit ${className}`;
  segment.setAttribute("role", "img");
  segment.setAttribute("aria-label", label);
  segment.tabIndex = -1;
  Object.assign(segment.style, style);
  return segment;
}

function createSeam() {
  const seam = document.createElement("div");
  seam.className = "topbar-seam";
  seam.append(createVisualSeam(), ...HIT_SEGMENTS.map(createHitSegment));
  return seam;
}

function mountTopbarSeam() {
  const topbar = document.querySelector(".topbar");
  if (!topbar || topbar.querySelector(".topbar-seam")) {
    return;
  }

  topbar.prepend(createSeam());
}

function bootTopbarSeam() {
  mountTopbarSeam();
  new MutationObserver(mountTopbarSeam).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootTopbarSeam, { once: true });
} else {
  bootTopbarSeam();
}
