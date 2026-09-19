import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pruneSessions, sessionContext } from "../plugins/usage-analytics/scripts/session-context.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "session-context-"));
const noConfig = { user: "", project: "", source: "dev" };
const notARepo = () => { throw Object.assign(new Error("exit 128"), { status: 128 }); };

// A fake git: answers by subcommand, counts calls.
function fakeGit(answers) {
  const git = (cmd, args) => {
    git.calls++;
    const answer = answers[args[0]];
    if (typeof answer === "function") return answer();
    if (answer === undefined) return notARepo();
    return answer + "\n";
  };
  git.calls = 0;
  return git;
}
const resolve = (over) => sessionContext({ dir: tmpDir(), sessionId: "s-1", cwd: "/work/webshop", config: noConfig, ...over });

test("the identity tag is the configured user, else the git email, else the OS user", () => {
  const exec = fakeGit({ config: "dev@example.com" });
  assert.equal(resolve({ exec, config: { ...noConfig, user: "agent:reviewer" } }).user, "agent:reviewer");
  assert.equal(resolve({ exec }).user, "dev@example.com");
  assert.equal(resolve({ exec: fakeGit({}) }).user, os.userInfo().username);
});

for (const [remote, project] of [
  ["git@github.com:signifly/webshop.git", "webshop"],
  ["https://github.com/signifly/webshop", "webshop"],
  ["https://github.com/signifly/webshop.git/", "webshop"],
  ["ssh://git@host:2222/signifly/web.shop.git", "web.shop"],
  ["https://user:s3cr3t-t0ken@github.com/signifly/webshop.git", "webshop"],
]) {
  test(`the project of ${remote.replace(/:[^:@/]+@/, ":***@")} is ${project}, and nothing else from the URL is kept`, () => {
    const context = resolve({ exec: fakeGit({ remote }) });
    assert.equal(context.project, project);
    assert.ok(!JSON.stringify(context).includes("s3cr3t"));
  });
}

test("without a remote the project is the repo folder, else the working folder; a configured project wins", () => {
  assert.equal(resolve({ exec: fakeGit({ "rev-parse": "/work/mono-repo" }) }).project, "mono-repo");
  assert.equal(resolve({ exec: fakeGit({}) }).project, "webshop");
  assert.equal(resolve({ exec: fakeGit({ remote: "git@h:o/r.git" }), config: { ...noConfig, project: "pinned" } }).project, "pinned");
});

test("the context is resolved once per session, then served from the cache", () => {
  const dir = tmpDir();
  const exec = fakeGit({ config: "dev@example.com", remote: "git@h:o/first.git" });
  const first = sessionContext({ dir, sessionId: "s-1", cwd: "/w", config: noConfig, exec });
  const calls = exec.calls;
  const again = sessionContext({ dir, sessionId: "s-1", cwd: "/w", config: noConfig, exec: fakeGit({ remote: "git@h:o/changed.git" }) });
  assert.deepEqual(again, first);
  assert.equal(exec.calls, calls);
  assert.deepEqual(Object.keys(first).sort(), ["project", "source", "user"]);
});

test("when git itself fails, the fallback answer is reused for a couple of minutes instead of re-running git on every event", () => {
  const dir = tmpDir();
  let clock = 1_000_000;
  const broken = fakeGit({ config: () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); }, remote: () => { throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }); } });
  const args = { dir, sessionId: "s-1", cwd: "/work/webshop", config: noConfig, now: () => clock };
  const degraded = sessionContext({ ...args, exec: broken });
  const callsAfterFirst = broken.calls;
  for (let i = 0; i < 20; i++) sessionContext({ ...args, exec: broken });
  assert.equal(broken.calls, callsAfterFirst);
  assert.deepEqual(Object.keys(degraded).sort(), ["project", "source", "user"]);

  clock += 3 * 60 * 1000; // …and once git works again, the real answer replaces it
  const healthy = fakeGit({ config: "dev@example.com", remote: "git@h:o/webshop.git" });
  assert.equal(sessionContext({ ...args, exec: healthy }).user, "dev@example.com");
  clock += 60 * 60 * 1000;
  assert.equal(sessionContext({ ...args, exec: broken }).user, "dev@example.com"); // now cached for good
});

const DAY = 24 * 60 * 60 * 1000;
const cacheSession = (dir, sessionId, ageMs) => {
  sessionContext({ dir, sessionId, cwd: "/w", config: noConfig, exec: fakeGit({}) });
  const file = path.join(dir, "sessions", `${sessionId}.json`);
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(file, then, then);
};
const cachedSessions = (dir) => fs.readdirSync(path.join(dir, "sessions")).sort();

test("pruning forgets sessions untouched for more than six days and keeps the rest", () => {
  const dir = tmpDir();
  cacheSession(dir, "last-week", 7 * DAY);
  cacheSession(dir, "five-days-ago", 5 * DAY);
  cacheSession(dir, "today", 0);
  pruneSessions(dir);
  assert.deepEqual(cachedSessions(dir), ["five-days-ago.json", "today.json"]);
});

test("pruning a data dir with no session cache yet is silent", () => {
  const lines = [];
  pruneSessions(tmpDir(), { log: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
});

test("a session cache that cannot be pruned is logged, not thrown", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "sessions"), "not a directory");
  const lines = [];
  pruneSessions(dir, { log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /cannot prune session cache/);
});
