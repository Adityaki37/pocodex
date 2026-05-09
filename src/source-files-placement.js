const SOURCE_LAYOUT_SELECTOR = ".source-files-layout";
const LEFT_COLUMN_SELECTOR = ".state-left-column";
const RIGHT_COLUMN_SELECTOR = ".animation-panel";
const GAP = 14;

function baseColumnHeight(column, sourceLayout) {
  const children = [...column.children].filter((child) => child !== sourceLayout);
  const childHeight = children.reduce(
    (height, child) => height + child.getBoundingClientRect().height,
    0,
  );
  return childHeight + Math.max(0, children.length - 1) * GAP;
}

function placeSourceFiles() {
  const sourceLayout = document.querySelector(SOURCE_LAYOUT_SELECTOR);
  const leftColumn = document.querySelector(LEFT_COLUMN_SELECTOR);
  const rightColumn = document.querySelector(RIGHT_COLUMN_SELECTOR);
  if (!sourceLayout || !leftColumn || !rightColumn) return;

  sourceLayout.style.minHeight = "";
  sourceLayout.dataset.placed = "true";

  if (window.matchMedia("(max-width: 1120px)").matches) {
    if (sourceLayout.parentElement !== rightColumn) {
      rightColumn.append(sourceLayout);
    }
    sourceLayout.dataset.placedIn = "right";
    sourceLayout.dataset.fillHeight = "0";
    return;
  }

  const leftHeight = baseColumnHeight(leftColumn, sourceLayout);
  const rightHeight = baseColumnHeight(rightColumn, sourceLayout);
  const targetColumn = leftHeight <= rightHeight ? leftColumn : rightColumn;
  const targetHeight = Math.min(leftHeight, rightHeight);
  const longestHeight = Math.max(leftHeight, rightHeight);

  if (sourceLayout.parentElement !== targetColumn) {
    targetColumn.append(sourceLayout);
  }

  const naturalHeight = sourceLayout.getBoundingClientRect().height;
  const fillHeight = Math.max(0, longestHeight - targetHeight - GAP);
  if (fillHeight > naturalHeight) {
    sourceLayout.style.minHeight = `${Math.ceil(fillHeight)}px`;
  }

  sourceLayout.dataset.placedIn = targetColumn === leftColumn ? "left" : "right";
  sourceLayout.dataset.leftHeight = String(Math.round(leftHeight));
  sourceLayout.dataset.rightHeight = String(Math.round(rightHeight));
  sourceLayout.dataset.fillHeight = String(Math.round(fillHeight));
}

let queued = false;
function queuePlacement() {
  if (queued) return;
  queued = true;
  window.requestAnimationFrame(() => {
    queued = false;
    placeSourceFiles();
  });
}

function startSourceFilesPlacement() {
  placeSourceFiles();
  new MutationObserver(queuePlacement).observe(document.body, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("resize", queuePlacement, { passive: true });
  window.addEventListener("hashchange", queuePlacement);
  window.setInterval(placeSourceFiles, 400);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startSourceFilesPlacement, {
    once: true,
  });
} else {
  startSourceFilesPlacement();
}
