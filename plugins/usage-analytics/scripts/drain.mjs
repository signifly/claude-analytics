// The flusher's loop: flush about once a second, back off while the sink is
// failing, stop when idle or when the flusher lock is lost.
import { flushOnce } from "./flush-once.mjs";

const MAX_BACKOFF_MS = 60 * 1000;

// Resolves true when idle, false when the lock was lost to another flusher.
export async function drain({
  buffer, sink, lock, flushMs, idleExitMs, log = () => {},
  flush = flushOnce,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  // Checking the lock before every push keeps its heartbeat fresh through a
  // long pass, and stops a flusher that was taken over from pushing duplicates.
  const guarded = {
    async push(events) {
      if (!lock.stillMine()) throw new Error("lock lost to another flusher");
      return sink.push(events);
    },
  };

  let lastActivity = now();
  let backoff = 0;
  while (now() - lastActivity < idleExitMs) {
    await sleep(backoff || flushMs);
    if (!lock.stillMine()) return log("lock lost to another flusher, exiting"), false;

    // Only new events or a pass that got events out of the buffer count as
    // activity, so an unreachable sink doesn't keep this process alive forever.
    if (buffer.pending()) lastActivity = now();
    const { delivered, rejected, error } = await flush(buffer, guarded);
    if (delivered || rejected) lastActivity = now();

    if (error) {
      backoff = Math.min(MAX_BACKOFF_MS, (backoff || flushMs) * 2);
      log(`push failed, retry in ${backoff}ms: ${error.message}`);
    } else {
      if (backoff) log("push recovered");
      backoff = 0;
    }
  }
  return true;
}
