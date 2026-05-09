const ATTRIBUTION_ID = "pocodex-home-attribution";

function createLink(href, label) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

function createAttribution(className = "home-attribution-strip") {
  const section = document.createElement("section");
  section.id = ATTRIBUTION_ID;
  section.className = className;
  section.setAttribute("aria-label", "Pocodex inspiration and sprite sources");

  const label = document.createElement("span");
  label.className = "home-attribution-label";
  label.textContent = "Inspired by";

  const copy = document.createElement("p");
  copy.append(
    createLink("https://petdex.crafter.run/docs", "Petdex"),
    document.createTextNode(" and "),
    createLink("https://github.com/PMDCollab/SpriteCollab", "PMDCollab"),
    document.createTextNode(", an open-source Pokemon sprite collection.")
  );

  section.append(label, copy);
  return section;
}

function mountHomeAttribution() {
  const shell = document.querySelector(".app-shell");
  const controls = shell?.querySelector(".controls");
  const installStrip = shell?.querySelector(".install-strip");
  if (!shell || !controls) {
    document.getElementById(ATTRIBUTION_ID)?.remove();
    return;
  }

  if (installStrip) {
    installStrip.classList.add("has-attribution");
    const existing = document.getElementById(ATTRIBUTION_ID);
    if (existing && existing.parentElement !== installStrip) {
      existing.remove();
    }
    if (!installStrip.querySelector(`#${ATTRIBUTION_ID}`)) {
      installStrip.prepend(createAttribution("home-attribution-strip install-attribution-inline"));
    }
    return;
  }

  if (shell.querySelector(`#${ATTRIBUTION_ID}`)) {
    return;
  }
  controls.insertAdjacentElement("afterend", createAttribution());
}

function bootHomeAttribution() {
  mountHomeAttribution();
  new MutationObserver(mountHomeAttribution).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootHomeAttribution, { once: true });
} else {
  bootHomeAttribution();
}
