import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "public", "pocodex", "manifest.json");
const reportPath = path.join(rootDir, "output", "website-pixel-style-selection-audit.json");
const baseUrl = process.env.POCODEX_AUDIT_URL ?? "http://127.0.0.1:5173/";
const auditScope = process.env.POCODEX_AUDIT_SCOPE ?? "all";
const styleOptions = [
  { id: "original-unchanged", label: "Original" },
  { id: "scale2x", label: "Scale2x" },
  { id: "epx", label: "EPX" },
  { id: "plain-xbrz", label: "xBRZ" },
  { id: "hq4x", label: "HQ4-Smooth" }
];

await main();

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const byId = new Map(manifest.pets.map((pet) => [pet.id, pet]));
  const sourcePets = manifest.pets
    .filter((pet) => pet.formGroup !== "pixel" && styleOptions.every((style) => {
      const styledId = `${pet.id}-${style.id}`;
      return byId.get(styledId)?.pixelStyle?.sourcePetId === pet.id;
    }))
    .sort(comparePets);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleIssues = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleIssues.push({ type: message.type(), text: message.text() });
    }
  });
  await page.route("https://pokeapi.co/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ flavor_text_entries: [] })
  }));

  const grid = auditScope === "entry" ? skippedGrid() : await auditGrid(page);
  const entry = auditScope === "grid" ? skippedEntry() : await auditEntryStyleClicks(page, sourcePets);
  await browser.close();

  const report = {
    url: baseUrl,
    styleOptions,
    sourcePetsChecked: sourcePets.length,
    grid,
    entry,
    consoleIssues: consoleIssues.filter((issue) => !/Pokedex failed|Missing English Pokedex entry/i.test(issue.text))
  };

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const failureCount =
    grid.failures.length +
    entry.failures.length +
    report.consoleIssues.length;

  console.log(`Website pixel-style audit checked ${grid.combinationsChecked} grid filter combinations.`);
  console.log(`Website pixel-style audit checked ${entry.sourcePetsChecked} entry pages and ${entry.clicksChecked} style-card clicks.`);
  console.log(`Report: ${path.relative(rootDir, reportPath)}`);
  if (failureCount > 0) {
    console.error(JSON.stringify({
      gridFailures: grid.failures.length,
      entryFailures: entry.failures.length,
      consoleIssues: report.consoleIssues.length
    }, null, 2));
    process.exitCode = 1;
  }
}

async function auditGrid(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".pet-card .sprite-frame", { timeout: 30000 });
  const formOptions = await page.locator('select[aria-label="Form filter"] option').evaluateAll((options) =>
    options.map((option) => ({ value: option.value, label: option.textContent?.trim() ?? option.value }))
  );
  const failures = [];
  const samples = [];
  const cardCounts = [];
  let combinationsChecked = 0;
  let renderedCardsChecked = 0;

  for (const form of formOptions) {
    await page.getByLabel("Form filter").selectOption(form.value);
    for (const style of styleOptions) {
      await page.getByLabel("Pixel style filter").selectOption(style.id);
      await page.waitForSelector(".pet-card .sprite-frame", { timeout: 30000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(80);
      await loadAllCards(page);
      const cards = await page.locator(".pet-card").evaluateAll((nodes) => nodes.map((node) => {
        const title = node.querySelector("h2")?.textContent?.trim() ?? "";
        const sprite = node.querySelector(".sprite-frame, .motion-sprite-frame, .motion-frame-canvas .sprite-frame");
        const image = node.querySelector("img.card-sprite");
        return {
          title,
          className: sprite?.className ?? "",
          style: sprite?.getAttribute("style") ?? "",
          src: image?.getAttribute("src") ?? "",
          imageStyle: image?.getAttribute("style") ?? ""
        };
      }));
      combinationsChecked += 1;
      renderedCardsChecked += cards.length;
      cardCounts.push({ form: form.label, style: style.label, cards: cards.length });
      if (samples.length < 12 && cards[0]) {
        samples.push({ form: form.label, style: style.label, ...cards[0] });
      }
      for (const card of cards) {
        const assetText = [card.style, card.src, card.imageStyle].join(" ");
        if (!assetText.includes(`-${style.id}/`)) {
          failures.push({
            surface: "grid-card",
            form: form.label,
            expectedStyle: style.id,
            title: card.title,
            className: card.className,
            style: card.style,
            src: card.src
          });
        }
      }
    }
  }

  return {
    formOptions,
    combinationsChecked,
    renderedCardsChecked,
    cardCounts,
    samples,
    failures
  };
}

function skippedGrid() {
  return {
    formOptions: [],
    combinationsChecked: 0,
    renderedCardsChecked: 0,
    samples: [],
    failures: [],
    skipped: true
  };
}

function skippedEntry() {
  return {
    sourcePetsChecked: 0,
    clicksChecked: 0,
    samples: [],
    failures: [],
    skipped: true
  };
}

async function auditEntryStyleClicks(page, sourcePets) {
  const failures = [];
  const samples = [];
  let clicksChecked = 0;
  let sourcePetsChecked = 0;

  for (const pet of sourcePets) {
    await page.goto(`${baseUrl}#${encodeURIComponent(`${pet.id}-original-unchanged`)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".style-panel .style-card", { timeout: 30000 });
    sourcePetsChecked += 1;

    for (const style of styleOptions) {
      const card = page.locator(".style-panel .style-card").filter({ hasText: style.label });
      await card.click();
      await page.waitForFunction(
        (id) => window.location.hash.includes(id),
        `${pet.id}-${style.id}`,
        { timeout: 30000 }
      );
      await page.waitForSelector(`.hero-pet-sprite .sprite-frame.pixel-style-${style.id}`, { timeout: 30000 });
      const observed = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          return {
            className: node?.className ?? "",
            style: node?.getAttribute("style") ?? ""
          };
        };
        return {
          hash: window.location.hash,
          hero: read(".hero-pet-sprite .sprite-frame"),
          viewer: read(".viewer-stage > .sprite-frame, .viewer-stage .motion-frame-canvas .sprite-frame"),
          activeStyleCard: document.querySelector(".style-panel .style-card.active")?.textContent?.trim() ?? "",
          activeStylePreview: read(".style-panel .style-card.active .sprite-frame")
        };
      });
      clicksChecked += 1;
      if (samples.length < 12) {
        samples.push({
          sourcePetId: pet.id,
          expectedStyle: style.id,
          hash: observed.hash,
          heroStyle: observed.hero.style,
          activeStyleCard: observed.activeStyleCard
        });
      }
      const expectedAsset = `/${pet.id}-${style.id}/spritesheet.webp`;
      for (const [surface, result] of Object.entries({
        hero: observed.hero,
        viewer: observed.viewer,
        activeStylePreview: observed.activeStylePreview
      })) {
        if (!result.style.includes(expectedAsset)) {
          failures.push({
            surface,
            sourcePetId: pet.id,
            expectedStyle: style.id,
            expectedAsset,
            hash: observed.hash,
            activeStyleCard: observed.activeStyleCard,
            className: result.className,
            style: result.style
          });
        }
      }
    }

    if (sourcePetsChecked % 100 === 0) {
      console.log(`Checked entry style clicks for ${sourcePetsChecked}/${sourcePets.length} source pets`);
    }
  }

  return {
    sourcePetsChecked,
    clicksChecked,
    samples,
    failures
  };
}

async function loadAllCards(page) {
  let previous = 0;
  let stable = 0;
  for (let index = 0; index < 140; index += 1) {
    const current = await page.locator(".pet-card").count();
    const hasLoader = await page.locator(".load-row.auto").count();
    if (current === previous) {
      stable += 1;
    } else {
      stable = 0;
    }
    if (stable >= 2 && hasLoader === 0) {
      return;
    }
    previous = current;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(180);
  }
}

function comparePets(a, b) {
  return Number(a.number) - Number(b.number) ||
    String(a.displayName).localeCompare(String(b.displayName)) ||
    String(a.formLabel ?? "").localeCompare(String(b.formLabel ?? "")) ||
    String(a.id).localeCompare(String(b.id));
}
