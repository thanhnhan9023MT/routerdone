import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { pruneUsageHistory } from "@/lib/db";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const USAGE_RETENTION_MS = HOUR_MS;
const ARTIFACT_MAX_AGE_MS = 3 * DAY_MS;
const STAGING_MAX_AGE_MS = 12 * HOUR_MS;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const BACKUPS_DIR = path.join(DATA_DIR, "db", "backups");

function safeStat(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function removeFileIfOld(file, cutoff, root) {
  const stat = safeStat(file);
  if (!stat || !stat.isFile() || stat.mtimeMs >= cutoff) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (path.dirname(resolvedFile) !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) return false;
  try { fs.unlinkSync(resolvedFile); return true; } catch { return false; }
}

function pruneDirectoryFiles(dir, maxAgeMs, { maxBytes = 0 } = {}) {
  const stat = safeStat(dir);
  if (!stat?.isDirectory()) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (removeFileIfOld(file, cutoff, dir)) removed++;
    else if (maxBytes && entry.name.endsWith(".log")) {
      const current = safeStat(file);
      if (current?.size > maxBytes) {
        try {
          const data = fs.readFileSync(file);
          fs.writeFileSync(file, data.subarray(Math.max(0, data.length - maxBytes)));
        } catch {}
      }
    }
  }
  return removed;
}

function removeBackups() {
  const stat = safeStat(BACKUPS_DIR);
  if (!stat?.isDirectory()) return 0;
  let entries;
  try { entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(BACKUPS_DIR, entry.name);
    try { fs.rmSync(full, { recursive: true, force: true }); removed++; } catch {}
  }
  return removed;
}

export async function runMaintenance() {
  const usageDeleted = await pruneUsageHistory({ olderThanMs: USAGE_RETENTION_MS, batchSize: 500 });
  const backupsDeleted = removeBackups();
  const updateDir = path.join(DATA_DIR, "update");
  const stagingDeleted = pruneDirectoryFiles(path.join(updateDir, "staging"), STAGING_MAX_AGE_MS);
  pruneDirectoryFiles(updateDir, ARTIFACT_MAX_AGE_MS, { maxBytes: MAX_LOG_BYTES });
  const mitmDir = path.join(DATA_DIR, "logs", "mitm");
  const mitmDeleted = pruneDirectoryFiles(mitmDir, ARTIFACT_MAX_AGE_MS, { maxBytes: MAX_LOG_BYTES });
  return { usageDeleted, backupsDeleted, stagingDeleted, mitmDeleted };
}

export function startMaintenanceScheduler() {
  const state = global.__routerdoneMaintenance ??= { running: false, interval: null, timeout: null };
  if (state.interval || state.timeout) return;
  const tick = () => {
    state.timeout = null;
    if (state.running) return;
    state.running = true;
    runMaintenance().catch(() => {}).finally(() => { state.running = false; });
    state.interval = setInterval(tick, HOUR_MS);
    state.interval.unref?.();
  };
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  state.timeout = setTimeout(tick, Math.max(1000, nextHour.getTime() - now.getTime()));
  state.timeout.unref?.();
}
