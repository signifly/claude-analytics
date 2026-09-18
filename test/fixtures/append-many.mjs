// Child process: appends `count` uniquely named events, like that many hook runs.
import { openBuffer } from "../../plugins/usage-analytics/scripts/event-buffer.mjs";
const [dir, writer, count] = process.argv.slice(2);
const buffer = openBuffer(dir);
for (let i = 0; i < Number(count); i++) buffer.append({ ts: Date.now(), sub: i, kind: "tool", name: `w${writer}-${i}` });
