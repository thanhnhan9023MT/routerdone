import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildHome = path.join(projectRoot, ".next-build-home");
const roamingAppData = path.join(buildHome, "AppData", "Roaming");
const localAppData = path.join(buildHome, "AppData", "Local");
const dataDir = path.join(roamingAppData, "routerdone");
// Build-home is disposable. Reusing it keeps stale DB backup paths in Next
// file tracing after migrations prune those backups during a later build.
fs.rmSync(buildHome, { recursive: true, force: true });

for (const dir of [roamingAppData, localAppData, dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const env = {
  ...process.env,
  APPDATA: roamingAppData,
  LOCALAPPDATA: localAppData,
  USERPROFILE: buildHome,
  HOME: buildHome,
  DATA_DIR: dataDir,
  NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED || "1",
};

const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "build", "--webpack", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

