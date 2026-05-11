const CLI_PACKAGE_FILE = "pocodex-cli.tgz";
const NPM_PACKAGE_SOURCE = "https://codeload.github.com/Adityaki37/pocodex/tar.gz/refs/heads/main";
const EXTRA_HOME_ROWS = [];

function siteOrigin() {
  return window.location.origin || "https://pocodex.dev";
}

function commandSet(slug) {
  const origin = siteOrigin();
  return {
    npx: `npx --yes --package ${origin}/${CLI_PACKAGE_FILE} pocodex install ${slug} --url ${origin}`,
    npm: `npm install -g ${NPM_PACKAGE_SOURCE} && pocodex install ${slug} --url ${origin}`,
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

function enhanceInstallMethods() {
  enhanceHomeInstallStrip();
}

function bootInstallMethods() {
  enhanceInstallMethods();
  new MutationObserver(enhanceInstallMethods).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => window.setTimeout(enhanceInstallMethods, 0));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootInstallMethods, { once: true });
} else {
  bootInstallMethods();
}
