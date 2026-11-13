// ntfy-voice-alerts: speak urgent ntfy messages out loud. No dependencies, no Node-only imports
// (runs in a browser or in Node 18+). The speaking itself is injected, so everything below is testable offline.

/** Normalise an ntfy priority (1-5) to an integer, default 3 (ntfy's default). */
export function normPriority(p) {
  const n = Number(p);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 3;
}

/**
 * Parse one line of ntfy's JSON stream (`GET /<topic>/json`).
 * Returns null for blank lines and for non-message events (open, keepalive, poll_request).
 * Throws an Error for a line that is not valid JSON.
 */
export function parseLine(line) {
  const s = String(line).trim();
  if (!s) return null;
  let o;
  try { o = JSON.parse(s); } catch (e) { throw new Error(`bad JSON line: ${s.slice(0, 80)}`); }
  if (!o || typeof o !== "object" || o.event !== "message") return null;
  return {
    id: o.id == null ? "" : String(o.id),
    time: Number(o.time) || 0,
    topic: o.topic == null ? "" : String(o.topic),
    title: o.title == null ? "" : String(o.title),
    message: o.message == null ? "" : String(o.message),
    priority: normPriority(o.priority),
    tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
  };
}

/**
 * Decide whether a message is worth speaking.
 * Speak when priority >= minPriority (default 4 = ntfy "high") OR a tag is in speakTags;
 * then require `match` (RegExp on title + message) if given, and refuse anything `mute` matches.
 */
export function explain(msg, { minPriority = 4, speakTags = [], match = null, mute = null } = {}) {
  const text = `${msg.title}\n${msg.message}`;
  const byPriority = msg.priority >= minPriority;
  const byTag = msg.tags.some((t) => speakTags.includes(t));
  if (!byPriority && !byTag) return { speak: false, reason: `below priority ${minPriority}` };
  if (match && !match.test(text)) return { speak: false, reason: "does not match --match" };
  if (mute && mute.test(text)) return { speak: false, reason: "muted" };
  return { speak: true, reason: byPriority ? `priority ${msg.priority}` : "tag" };
}

export const shouldSpeak = (msg, opts) => explain(msg, opts).speak;

/** Turn a message into a short, speakable sentence: drop URLs, markdown and emoji, cut at maxChars on a word boundary. */
export function toSpeech(msg, { maxChars = 140, urgentPrefix = true } = {}) {
  const clean = (s) => String(s)
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[*_`#~>\[\]()]/g, " ")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = clean(msg.title), body = clean(msg.message);
  let text = [title, body].filter(Boolean).map((p) => (/[.!?]$/.test(p) ? p : p + ".")).join(" ");
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const sp = cut.lastIndexOf(" ");
    text = (sp > maxChars * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!-]+$/, "") + ".";
  }
  if (text && urgentPrefix && msg.priority >= 5) text = "Urgent. " + text;
  return text;
}

/**
 * Queue + dedupe in front of a `speak(text) -> Promise` function.
 * - the same text within dedupeMs is skipped (a flapping alert is not read out every 10 s)
 * - at most maxQueue texts wait; when full the OLDEST waiting one is dropped (newer alerts matter more)
 * - a failing speak() is counted and passed to onError, never swallowed
 */
export function createAnnouncer({ speak, now = Date.now, dedupeMs = 60000, maxQueue = 5, filter = {}, speech = {}, onError = null }) {
  if (typeof speak !== "function") throw new TypeError("speak must be a function");
  const recent = new Map();
  const queue = [];
  const stats = { spoken: 0, filtered: 0, duplicates: 0, dropped: 0, errors: 0 };
  let running = null;

  async function pump() {
    while (queue.length) {
      const text = queue.shift();
      try { await speak(text); stats.spoken++; }
      catch (e) { stats.errors++; if (onError) onError(e, text); }
    }
    running = null;
  }

  function handle(msg) {
    const why = explain(msg, filter);
    if (!why.speak) { stats.filtered++; return { action: "filtered", reason: why.reason }; }
    const text = toSpeech(msg, speech);
    if (!text) { stats.filtered++; return { action: "filtered", reason: "nothing speakable" }; }
    const t = now();
    for (const [k, at] of recent) if (t - at >= dedupeMs) recent.delete(k);
    if (recent.has(text)) { stats.duplicates++; return { action: "duplicate", reason: `same text within ${dedupeMs / 1000}s`, text }; }
    recent.set(text, t);
    let dropped = null;
    if (queue.length >= maxQueue) { dropped = queue.shift(); stats.dropped++; }
    queue.push(text);
    if (!running) running = pump();
    return { action: "speak", reason: why.reason, text, dropped };
  }

  return { handle, stats, idle: async () => { while (running) await running; } };
}

/** speak() backed by the browser's speechSynthesis. localOnly (default) refuses voices that are not localService, so no remote voice is used. */
export function speechSynthesisSpeaker({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, localOnly = true, voiceName = null, rate = 1, volume = 1, lang = null } = {}) {
  if (!synth || !Utterance) throw new Error("speechSynthesis is not available here");
  return (text) => new Promise((resolve, reject) => {
    const voices = synth.getVoices();
    let v = null;
    if (voiceName) {
      v = voices.find((x) => x.name === voiceName);
      if (!v) return reject(new Error(`voice not found: ${voiceName}`));
    } else if (localOnly) {
      v = voices.find((x) => x.localService);
      if (!v) return reject(new Error("no local voice available (localService)"));
    }
    if (localOnly && v && !v.localService) return reject(new Error(`voice ${v.name} is not a local voice`));
    const u = new Utterance(text);
    u.rate = rate; u.volume = volume;
    if (lang) u.lang = lang;
    if (v) u.voice = v;
    u.onend = () => resolve();
    u.onerror = (e) => reject(new Error(`speech error: ${(e && e.error) || "unknown"}`));
    synth.speak(u);
  });
}

/** Read a fetch body (web ReadableStream) line by line; handles lines split across chunks. */
export async function readLines(body, onLine) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
  }
  buf += dec.decode();
  if (buf.trim()) onLine(buf);
}

const abortableSleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Follow an ntfy topic's JSON stream until `signal` aborts, reconnecting with doubling backoff
 * (resuming after the last seen message id with ?since=<id>). Bad lines go to onBadLine, status changes to onStatus.
 */
export async function connect({ server = "https://ntfy.sh", topic, fetch = globalThis.fetch, headers = {}, signal, onMessage, onBadLine = () => {}, onStatus = () => {}, sleep = abortableSleep, minDelayMs = 1000, maxDelayMs = 30000 }) {
  if (!topic) throw new Error("topic is required");
  const base = `${server.replace(/\/+$/, "")}/${topic.split(",").map(encodeURIComponent).join(",")}/json`;
  let lastId = "", delay = minDelayMs;
  while (!(signal && signal.aborted)) {
    try {
      const res = await fetch(lastId ? `${base}?since=${encodeURIComponent(lastId)}` : base, { headers, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      delay = minDelayMs;
      onStatus("connected");
      await readLines(res.body, (line) => {
        let msg;
        try { msg = parseLine(line); } catch (e) { onBadLine(e, line); return; }
        if (msg) { if (msg.id) lastId = msg.id; onMessage(msg); }
      });
      if (signal && signal.aborted) break;
      onStatus(`stream ended, reconnecting in ${minDelayMs} ms`);
      await sleep(minDelayMs, signal);   // a server that accepts and closes at once must not become a hot loop
    } catch (e) {
      if (signal && signal.aborted) break;
      onStatus(`error: ${e.message}; retry in ${delay} ms`);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/** Command that speaks `text` with a local text-to-speech tool, text on stdin (never in argv). `have(name)` says whether a command exists. */
export function ttsCommand(platform, have) {
  if (platform === "darwin" && have("say")) return { cmd: "say", args: [] };
  if (platform === "win32" && have("powershell")) {
    return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())"] };
  }
  for (const c of ["espeak-ng", "espeak"]) if (have(c)) return { cmd: c, args: ["--stdin"] };
  return null;
}
