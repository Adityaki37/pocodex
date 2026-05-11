import { copyFile, mkdir, rm, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const tempDir = path.join(rootDir, "tmp-pocodex-cli-package");
const publicDir = path.join(rootDir, "public");
const packageName = "pocodex-cli";
const packageVersion = "0.1.0";
const packedName = `${packageName}-${packageVersion}.tgz`;
const outputName = "pocodex-cli.tgz";

await main();

async function main() {
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(path.join(tempDir, "bin"), { recursive: true });
  await mkdir(publicDir, { recursive: true });

  await copyFile(path.join(rootDir, "bin", "pocodex.mjs"), path.join(tempDir, "bin", "pocodex.mjs"));
  await writeFile(path.join(tempDir, "README.md"), "Tiny Pocodex CLI package for installing one Codex pet from pocodex.dev.\n");
  await writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: packageVersion,
        private: false,
        type: "module",
        description: "Tiny Pocodex CLI package for installing Codex pets from pocodex.dev.",
        bin: {
          pocodex: "./bin/pocodex.mjs"
        },
        engines: {
          node: ">=18"
        },
        dependencies: {
          "fast-xml-parser": "^5.7.2",
          jszip: "^3.10.1",
          sharp: "^0.34.5"
        }
      },
      null,
      2
    )}\n`
  );

  await run("npm", ["pack", "--pack-destination", path.relative(tempDir, publicDir)], tempDir);
  await rename(path.join(publicDir, packedName), path.join(publicDir, outputName));
  const size = await stat(path.join(publicDir, outputName));
  await rm(tempDir, { recursive: true, force: true });
  console.log(`Built public/${outputName} (${formatBytes(size.size)})`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : command;
    const commandArgs =
      process.platform === "win32"
        ? ["/d", "/s", "/c", [command, ...args].join(" ")]
        : args;
    const child = spawn(executable, commandArgs, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
