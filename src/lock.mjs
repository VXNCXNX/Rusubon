import { constants, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function acquireRepoLock(repo, name = "run.lock") {
  if (!["run.lock", "ui.lock"].includes(name)) throw new Error("Invalid lock name");
  const container = join(repo, ".rusubon"); mkdirSync(container, { recursive: true });
  if (lstatSync(container).isSymbolicLink()) throw new Error(".rusubon must not be a symbolic link");
  // runs/ was ignored by earlier releases, so locking cannot dirty a clean PR checkout.
  const directory = join(container, "runs"); mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw new Error(".rusubon/runs must not be a symbolic link");
  const path = join(directory, name), id = randomUUID();
  const read = () => {
    if (lstatSync(path).isSymbolicLink()) throw new Error("Run lock must not be a symbolic link");
    return JSON.parse(readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
  };
  function write() { writeFileSync(path, JSON.stringify({ pid: process.pid, id }), { flag: "wx", mode: 0o600 }); }
  try { write(); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let old; try { old = read(); } catch { throw new Error(`The lock is unreadable. Inspect .rusubon/runs/${name} before launching.`); }
    if (!Number.isInteger(old.pid) || old.pid <= 0) throw new Error(`Invalid run lock. Inspect .rusubon/runs/${name} before launching.`);
    let alive = true;
    try { process.kill(old.pid, 0); } catch (failure) { if (failure.code === "ESRCH") alive = false; }
    if (alive) throw new Error(name === "ui.lock" ? "A dashboard is already running for this repository. Use its existing URL." : "A run is already active in this repository. Stop it or wait for it to finish.");
    // Serialize stale-lock recovery so one contender cannot unlink another's new lock.
    const recovery = `${path}.recovery`;
    try { writeFileSync(recovery, String(process.pid), { flag: "wx", mode: 0o600 }); } catch { throw new Error(`Lock recovery is in progress. If interrupted, inspect ${recovery}.`); }
    try { if (read().id !== old.id) throw new Error("Another process acquired the lock. Try again."); unlinkSync(path); write(); }
    finally { unlinkSync(recovery); }
  }
  return () => { if (existsSync(path) && read().id === id) unlinkSync(path); };
}

export async function withRepoLock(repo, action) {
  const release = acquireRepoLock(repo); try { return await action(); } finally { release(); }
}
