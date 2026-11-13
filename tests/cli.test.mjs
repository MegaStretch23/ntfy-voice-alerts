import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { parseArgs, main } from "../bin/ntfy-voice.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "ntfy-voice.mjs");

test("parseArgs: defaults, repeatable --tag, numbers, errors", () => {
  const o = parseArgs(["--file", "f", "--tag", "a", "--tag", "b", "--min-priority", "3"]);
  assert.deepEqual([o.file, o.tags, o.minPriority, o.dedupe, o.speak], ["f", ["a", "b"], 3, 60, false]);
  assert.throws(() => parseArgs([]), /exactly one/);
  assert.throws(() => parseArgs(["--file", "f", "--topic", "t"]), /exactly one/);
  assert.throws(() => parseArgs(["--file"]), /needs a value/);
  assert.throws(() => parseArgs(["--file", "f", "--max-chars", "x"]), /needs a number/);
  assert.throws(() => parseArgs(["--file", "f", "--bogus"]), /unknown argument/);
});

test("replay of samples/stream.jsonl prints exactly samples/example_output.txt (README quotes it)", async () => {
  const lines = []; const code = await main(["--file", join(root, "samples/stream.jsonl")], (s) => lines.push(s));
  assert.equal(code, 0);
  assert.equal(lines.join("\n") + "\n", readFileSync(join(root, "samples/example_output.txt"), "utf8"));
});

test("README quotes the saved output verbatim", () => {
  assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(readFileSync(join(root, "samples/example_output.txt"), "utf8").trimEnd()));
});

test("CLI flags change the result: --min-priority 3 speaks the p3 message; --mute silences a title", async () => {
  const run = async (...a) => { const l = []; await main(["--file", join(root, "samples/stream.jsonl"), ...a], (s) => l.push(s)); return l; };
  assert.ok((await run("--min-priority", "3")).some((l) => l.includes("SPEAK  Backup finished")));
  assert.ok((await run("--mute", "disk")).some((l) => l.includes("muted: Disk 91% on box 1")));
  assert.ok((await run("--dedupe-seconds", "0")).filter((l) => l.includes("SPEAK  Urgent. Meta")).length === 3);
});

test("a bad line in the file is a FAILED line and exit code 1", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "nva-")), "bad.jsonl");
  writeFileSync(f, '{"event":"message","title":"ok","message":"x","priority":5}\n{broken\n');
  const l = []; const code = await main(["--file", f], (s) => l.push(s));
  assert.equal(code, 1); assert.ok(l.some((s) => s.startsWith("FAILED: bad JSON line"))); assert.match(l.at(-1), /1 spoken.*1 errors/);
});

test("--speak with no TTS tool on PATH fails loudly", () => {
  const r = spawnSync(process.execPath, [cli, "--file", join(root, "samples/stream.jsonl"), "--speak"], { env: { ...process.env, PATH: "/nonexistent" }, encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /FAILED: --speak needs a local TTS tool/);
});

test("--speak runs the TTS tool with the text on stdin (fake espeak-ng on PATH)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nva-bin-")); const out = join(dir, "heard.txt");
  writeFileSync(join(dir, "espeak-ng"), `#!/bin/sh\n/bin/cat >> "${out}"\necho >> "${out}"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [cli, "--file", join(root, "samples/stream.jsonl"), "--speak"], { env: { ...process.env, PATH: dir }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const heard = readFileSync(out, "utf8").trim().split("\n");
  assert.equal(heard.length, 5); assert.equal(heard[0], "Urgent. Meta Read Failed. Token expired on the ad account read, 3 retries used.");
});

test("live mode against a local HTTP server that streams ntfy JSON (real fetch, real stream)", async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization]);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write('{"id":"o","event":"open","topic":"t"}\n{"id":"a","event":"message","title":"Meta Read');
    setTimeout(() => res.write(' Failed","message":"x","priority":5}\n{"id":"b","event":"message","title":"fine","message":"y","priority":3}\n'), 20);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const p = spawn(process.execPath, [cli, "--topic", "fleet", "--server", url, "--count", "2"], { env: { ...process.env, NTFY_TOKEN: "tok" } });
  let out = ""; p.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => p.on("close", r));
  srv.closeAllConnections(); srv.close();
  assert.equal(code, 0);
  assert.match(out, /status: connected/); assert.match(out, /p5 SPEAK  Urgent\. Meta Read Failed\. x\./); assert.match(out, /p3 SKIP/);
  assert.match(out, /summary: 2 messages, 1 spoken, 1 filtered/);
  assert.deepEqual(seen[0], ["/fleet/json", "Bearer tok"]);
});
