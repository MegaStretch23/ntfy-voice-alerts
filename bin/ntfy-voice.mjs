#!/usr/bin/env node
// ntfy-voice: replay a saved ntfy JSON stream (--file) or follow a live topic (--topic) and speak the urgent messages.
// Without --speak nothing is spoken: the lines show what WOULD be said. Config comes from flags; the token only from $NTFY_TOKEN.
import { readFileSync, accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { parseLine, createAnnouncer, connect, ttsCommand } from "../src/voice-alerts.mjs";

const HELP = `usage: ntfy-voice (--file stream.jsonl | --topic NAME [--server URL]) [options]
  --min-priority N     speak priority >= N (default 4 = ntfy "high")
  --tag NAME           also speak this tag (repeatable)
  --match REGEX        require title+message to match
  --mute REGEX         never speak when it matches
  --dedupe-seconds N   skip the same text again within N seconds (default 60)
  --max-chars N        cut spoken text at N characters (default 140)
  --max-queue N        waiting texts kept (default 5, oldest dropped)
  --count N            live mode: stop after N message events
  --speak              really speak with a local TTS tool (espeak-ng/espeak, say, or PowerShell SAPI); default is dry run
env: NTFY_TOKEN        sent as "Authorization: Bearer ..." in live mode`;

export function parseArgs(argv) {
  const o = { tags: [], minPriority: 4, dedupe: 60, maxChars: 140, maxQueue: 5, speak: false };
  const need = (i, f) => { if (i + 1 >= argv.length) throw new Error(`${f} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--speak") o.speak = true;
    else if (["--file", "--topic", "--server", "--match", "--mute"].includes(a)) { o[a.slice(2)] = need(i, a); i++; }
    else if (a === "--tag") { o.tags.push(need(i, a)); i++; }
    else if (["--min-priority", "--dedupe-seconds", "--max-chars", "--max-queue", "--count"].includes(a)) {
      const n = Number(need(i, a)); if (!Number.isFinite(n) || n < 0) throw new Error(`${a} needs a number`);
      o[{ "--min-priority": "minPriority", "--dedupe-seconds": "dedupe", "--max-chars": "maxChars", "--max-queue": "maxQueue", "--count": "count" }[a]] = n; i++;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.help && !o.file === !o.topic) throw new Error("give exactly one of --file or --topic");
  return o;
}

function have(name) {
  for (const d of (process.env.PATH || "").split(delimiter)) { try { accessSync(join(d, name), constants.X_OK); return true; } catch {} }
  return false;
}

function localSpeaker() {
  const t = ttsCommand(process.platform, have);
  if (!t) throw new Error("--speak needs a local TTS tool (espeak-ng, espeak, say or powershell); none found on PATH");
  return (text) => new Promise((resolve, reject) => {
    const p = spawn(t.cmd, t.args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${t.cmd} exited ${c}: ${err.trim().slice(0, 100)}`))));
    p.stdin.end(text);
  });
}

export async function main(argv, out = (s) => console.log(s)) {
  const o = parseArgs(argv);
  if (o.help) { out(HELP); return 0; }
  const spoken = [];
  const speak = o.speak ? localSpeaker() : async (t) => { spoken.push(t); };
  let clock = Date.now(), failures = 0, bad = 0, seen = 0;
  const ann = createAnnouncer({
    speak, now: () => clock, dedupeMs: o.dedupe * 1000, maxQueue: o.maxQueue,
    filter: { minPriority: o.minPriority, speakTags: o.tags, match: o.match ? new RegExp(o.match, "i") : null, mute: o.mute ? new RegExp(o.mute, "i") : null },
    speech: { maxChars: o.maxChars }, onError: (e, text) => { failures++; out(`FAILED: speak: ${e.message} (text: ${text.slice(0, 40)})`); },
  });
  const onMessage = (m) => {
    seen++;
    if (o.file) clock = m.time * 1000;   // replay: dedupe uses the stream's own timestamps, so the output is repeatable
    const r = ann.handle(m);
    out(r.action === "speak" ? `p${m.priority} SPEAK  ${r.text}${r.dropped ? "   (dropped oldest queued: " + r.dropped + ")" : ""}` : `p${m.priority} SKIP   ${r.reason}: ${m.title || m.message}`.slice(0, 160));
  };
  const onBad = (e) => { bad++; out(`FAILED: ${e.message}`); };
  if (o.file) {
    for (const line of readFileSync(o.file, "utf8").split("\n")) { try { const m = parseLine(line); if (m) onMessage(m); } catch (e) { onBad(e); } }
  } else {
    const ac = new AbortController();
    process.once("SIGINT", () => ac.abort());
    const token = process.env.NTFY_TOKEN;
    await connect({
      server: o.server, topic: o.topic, signal: ac.signal, headers: token ? { Authorization: `Bearer ${token}` } : {},
      onMessage: (m) => { onMessage(m); if (o.count && seen >= o.count) ac.abort(); }, onBadLine: onBad, onStatus: (s) => out(`status: ${s}`),
    });
  }
  await ann.idle();
  const s = ann.stats;
  out(`summary: ${seen} messages, ${s.spoken} spoken, ${s.filtered} filtered, ${s.duplicates} duplicates, ${s.dropped} dropped, ${s.errors + bad} errors`);
  return failures || bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
}
