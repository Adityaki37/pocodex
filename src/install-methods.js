const PACKAGE_SOURCE = "github:Adityaki37/pocodex";
const NPM_PACKAGE_SOURCE = "https://codeload.github.com/Adityaki37/pocodex/tar.gz/refs/heads/main";
const EXTRA_HOME_ROWS = ["npm", "curl"];
const ENTRY_ROWS = ["npx", "npm", "curl", "powershell"];

function siteOrigin() {
  return window.location.origin || "https://pocodex.dev";
}

function currentSlug() {
  return decodeURIComponent(window.location.hash.replace(/^#\/?/, "")).trim();
}

function currentSpeed() {
  const input = document.querySelector(".speed-control input");
  const value = Number(input?.value);
  return Math.min(2, Math.max(0.5, Number.isFinite(value) ? value : 1)).toFixed(1);
}

function commandSet(slug) {
  const origin = siteOrigin();
  const speed = slug === "all" ? "" : ` --speed ${currentSpeed()}`;
  return {
    npx: `npx --yes --package ${PACKAGE_SOURCE} pocodex install ${slug} --url ${origin}${speed}`,
    npm: `npm install -g ${NPM_PACKAGE_SOURCE} && pocodex install ${slug} --url ${origin}${speed}`,
    curl: `curl -fsSL ${origin}/install/${slug} | sh`,
    powershell: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${origin}/install/${slug}.ps1 | iex"`,
    zip: `${origin}/pocodex/downloads/${slug}.zip`
  };
}

function createCopyButton(command, label) {
  const button = document.createElement("button");
  button.className = "copy-mini";
  button.type = "button";
  button.title = `Copy ${label} command`;
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
      button.classList.add("copied");
      button.title = "Copied";
    } catch {
      button.classList.add("failed");
      button.title = "Copy failed";
    }
    window.setTimeout(() => {
      button.classList.remove("copied", "failed");
      button.title = `Copy ${label} command`;
    }, 1500);
  });
  return button;
}

function createCommandRow(label, command) {
  const row = document.createElement("div");
  row.className = "command-row install-extra-row";
  row.dataset.pocodexExtraInstall = "true";

  const name = document.createElement("span");
  name.textContent = label;

  const code = document.createElement("code");
  code.textContent = command;

  row.append(name, code, createCopyButton(command, label));
  return row;
}

function enhanceHomeInstallStrip() {
  const commands = document.querySelector(".install-strip .install-commands");
  if (!commands) return;

  const commandById = commandSet("all");
  for (const id of EXTRA_HOME_ROWS) {
    const marker = `home-${id}`;
    if (commands.querySelector(`[data-pocodex-extra-key="${marker}"]`)) continue;
    const row = createCommandRow(id, commandById[id]);
    row.dataset.pocodexExtraKey = marker;
    commands.append(row);
  }
}

function enhanceEntryInstallCard() {
  const card = document.querySelector(".entry-install-card");
  const slug = currentSlug();
  if (!card || !slug || slug === "about") return;

  const existing = card.querySelector(".install-method-augment");
  const commands = commandSet(slug);
  const signature = `${slug}:${currentSpeed()}:${siteOrigin()}`;
  if (existing?.dataset.signature === signature) return;
  existing?.remove();

  const panel = document.createElement("div");
  panel.className = "install-method-augment";
  panel.dataset.signature = signature;

  const heading = document.createElement("h3");
  heading.textContent = "More install methods";
  panel.append(heading);

  for (const id of ENTRY_ROWS) {
    panel.append(createCommandRow(id === "powershell" ? "ps1" : id, commands[id]));
  }

  const zipLink = document.createElement("a");
  zipLink.className = "install-zip-link";
  zipLink.href = commands.zip;
  zipLink.download = "";
  zipLink.textContent = "Download ZIP";
  panel.append(zipLink);

  const activateNote = card.querySelector(".activate-note");
  if (activateNote) {
    card.insertBefore(panel, activateNote);
  } else {
    card.append(panel);
  }
}

function enhanceInstallMethods() {
  enhanceHomeInstallStrip();
  enhanceEntryInstallCard();
}

function bootInstallMethods() {
  enhanceInstallMethods();
  new MutationObserver(enhanceInstallMethods).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => window.setTimeout(enhanceInstallMethods, 0));
  window.addEventListener("input", (event) => {
    if (event.target?.matches?.(".speed-control input")) {
      window.setTimeout(enhanceEntryInstallCard, 0);
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootInstallMethods, { once: true });
} else {
  bootInstallMethods();
}
