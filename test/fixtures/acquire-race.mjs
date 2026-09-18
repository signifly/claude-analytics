// Child process: waits for a shared start time, tries to take the lock, then
// reports whether it still owns it a moment later.
import { acquire } from "../../plugins/usage-analytics/scripts/flusher-lock.mjs";
const [dir, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const lock = acquire(dir);
await new Promise((resolve) => setTimeout(resolve, 300));
process.stdout.write(lock?.stillMine() ? "owner" : "none");
