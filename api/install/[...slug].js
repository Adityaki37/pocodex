const BASE_URL = "https://pocodex.dev";

function shellInstaller(slug) {
  return `#!/bin/sh
set -eu
BASE_URL="\${POCODEX_URL:-${BASE_URL}}"
SLUG="${escapeShell(slug)}"
CODEX_HOME_DIR="\${CODEX_HOME:-$HOME/.codex}"
DEST="$CODEX_HOME_DIR/pets/$SLUG"

mkdir -p "$DEST"

download_file() {
  name="$1"
  required="$2"
  url="$BASE_URL/pocodex/pets/$SLUG/$name"
  target="$DEST/$name"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target" || { [ "$required" = "0" ] && return 0; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url" || { [ "$required" = "0" ] && return 0; return 1; }
  else
    echo "Pocodex install failed: curl or wget is required." >&2
    exit 1
  fi
}

download_file pet.json 1
download_file spritesheet.webp 1
download_file source.json 0
download_file preview.png 0
download_file thumbnail.webp 0

echo "Installed $SLUG to $DEST"
`;
}

function powershellInstaller(slug) {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = if ($env:POCODEX_URL) { $env:POCODEX_URL } else { "${BASE_URL}" }
$Slug = "${escapePowerShell(slug)}"
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$Dest = Join-Path (Join-Path $CodexHome "pets") $Slug

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Get-PocodexFile($Name, $Required) {
  $Uri = $BaseUrl.TrimEnd("/") + "/pocodex/pets/" + $Slug + "/" + $Name
  $OutFile = Join-Path $Dest $Name
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
  } catch {
    if ($Required) { throw }
  }
}

Get-PocodexFile "pet.json" $true
Get-PocodexFile "spritesheet.webp" $true
Get-PocodexFile "source.json" $false
Get-PocodexFile "preview.png" $false
Get-PocodexFile "thumbnail.webp" $false

Write-Host ("Installed " + $Slug + " to " + $Dest)
`;
}

function shellInstallAll() {
  return `#!/bin/sh
set -eu
BASE_URL="\${POCODEX_URL:-${BASE_URL}}"
if command -v curl >/dev/null 2>&1; then
  CATALOG="$(curl -fsSL "$BASE_URL/pocodex/catalog.json")"
elif command -v wget >/dev/null 2>&1; then
  CATALOG="$(wget -qO- "$BASE_URL/pocodex/catalog.json")"
else
  echo "Pocodex install failed: curl or wget is required." >&2
  exit 1
fi

printf '%s' "$CATALOG" | sed -n 's/.*"id": "\\([^"]*\\)".*/\\1/p' | while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  echo "Installing $slug"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$BASE_URL/install/$slug" | POCODEX_URL="$BASE_URL" sh
  else
    wget -qO- "$BASE_URL/install/$slug" | POCODEX_URL="$BASE_URL" sh
  fi
done
`;
}

function powershellInstallAll() {
  return `$ErrorActionPreference = "Stop"
$BaseUrl = if ($env:POCODEX_URL) { $env:POCODEX_URL } else { "${BASE_URL}" }
$Catalog = Invoke-RestMethod -Uri ($BaseUrl.TrimEnd("/") + "/pocodex/catalog.json")
$PreviousPocodexUrl = $env:POCODEX_URL
try {
  foreach ($Pet in $Catalog) {
    Write-Host ("Installing " + $Pet.id)
    $env:POCODEX_URL = $BaseUrl
    $Script = (Invoke-WebRequest -Uri ($BaseUrl.TrimEnd("/") + "/install/" + $Pet.id + ".ps1") -UseBasicParsing).Content
    Invoke-Expression $Script
  }
} finally {
  if ($null -eq $PreviousPocodexUrl) {
    Remove-Item Env:\\POCODEX_URL -ErrorAction SilentlyContinue
  } else {
    $env:POCODEX_URL = $PreviousPocodexUrl
  }
}
`;
}

function escapeShell(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "");
}

function escapePowerShell(value) {
  return String(value).replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$");
}

function resolveSlug(queryValue) {
  const value = Array.isArray(queryValue) ? queryValue.join("/") : queryValue;
  return decodeURIComponent(String(value ?? "")).replace(/^\/+/, "");
}

export default function handler(req, res) {
  const requestUrl = new URL(req.url ?? "/", BASE_URL);
  const pathSlug = requestUrl.pathname.replace(/^\/api\/install\/?/, "").replace(/^\/install\/?/, "");
  const rawSlug = resolveSlug(req.query.slug) || resolveSlug(pathSlug);
  const isPowerShell = rawSlug.endsWith(".ps1");
  const slug = isPowerShell ? rawSlug.slice(0, -4) : rawSlug;

  if (!slug || slug.includes("/") || slug.includes("..")) {
    res.status(400).send("Invalid Pocodex install target");
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");

  if (slug === "all") {
    res.status(200).send(isPowerShell ? powershellInstallAll() : shellInstallAll());
    return;
  }

  res.status(200).send(isPowerShell ? powershellInstaller(slug) : shellInstaller(slug));
}
