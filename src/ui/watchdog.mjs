// Separate from the worker's event loop so synchronous verification cannot hide parent loss.
const [parent, group] = process.argv.slice(2).map(Number);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
if (![parent, group].every(pid => Number.isInteger(pid) && pid > 1)) process.exit(1);
setInterval(() => {
  if (!alive(parent) || !alive(group)) {
    try { process.kill(-group, "SIGKILL"); } catch {}
    process.exit(0);
  }
}, 150).unref();
// A small referenced timer owns the watchdog lifetime.
setInterval(() => {}, 60_000);
