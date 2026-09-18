// The flusher's loop: flush every flushMs (1 s by default), back off while the sink is
// failing, stop when idle or when the flusher lock is lost.
import { flushOnce } from "./flush-once.mjs";
import { describe } from "./log.mjs";

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
      if (!lock.stillMine()) throw Object.assign(new Error("lock lost to another flusher"), { lockLost: true });
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
    const { delivered, rejected, error, settleError } = await flush(buffer, guarded);
    // Taken over mid-pass: that is not a sink problem, and there is nothing to wait for.
    if (error?.lockLost) return log("lock lost to another flusher, exiting"), false;
    if ((delivered || rejected) && !settleError) lastActivity = now();

    if (error || settleError) {
      backoff = Math.min(MAX_BACKOFF_MS, (backoff || flushMs) * 2);
      if (settleError)
        log(`delivered ${delivered} from ${settleError.batch} but could not settle it (${describe(settleError)}); it will be re-sent, retry in ${backoff}ms`);
      if (error) log(`push failed, retry in ${backoff}ms: ${describe(error)}`);
    } else {
      if (backoff) log("push recovered");
      backoff = 0;
    }
  }
  return true;
}
