// One pass of the flusher: move everything the buffer holds to the sink.
// The sink answers "ok" or "rejected" per push, or throws when a retry makes sense.

// ~1 MiB per push (Promtail's default batch size); an estimate, not a hard limit.
const DEFAULT_MAX_PUSH_BYTES = 1024 * 1024;

function chunk(events, maxBytes) {
  const chunks = [];
  let bytes = Infinity;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 64;
    if (bytes + size > maxBytes) {
      chunks.push([]);
      bytes = 0;
    }
    chunks.at(-1).push(event);
    bytes += size;
  }
  return chunks;
}

// Never throws. On a retryable failure everything unsent stays held, in order,
// and `error` says why; the caller decides when to try again.
export async function flushOnce(buffer, sink, { maxPushBytes = DEFAULT_MAX_PUSH_BYTES } = {}) {
  const result = { delivered: 0, rejected: 0, error: null };
  try {
    await pushAll(buffer, sink, maxPushBytes, result);
  } catch (err) {
    result.error = err; // the buffer itself failed (disk, permissions)
  }
  return result;
}

async function pushAll(buffer, sink, maxPushBytes, result) {
  for (const batch of buffer.claim()) {
    const rejected = [];
    let sent = 0;
    for (const events of chunk(batch.events, maxPushBytes)) {
      try {
        if ((await sink.push(events)) === "rejected") rejected.push(...events);
        else result.delivered += events.length;
      } catch (err) {
        result.error = err;
        break;
      }
      sent += events.length;
    }
    result.rejected += rejected.length;
    batch.settle({ sent, rejected });
    if (result.error) break; // keep order: don't send newer batches past a held one
  }
}
