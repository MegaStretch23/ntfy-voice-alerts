import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, explain, shouldSpeak, toSpeech, createAnnouncer, speechSynthesisSpeaker, readLines, connect, ttsCommand, normPriority } from "../src/voice-alerts.mjs";

const msg = (o = {}) => ({ id: "x", time: 0, topic: "t", title: "T", message: "M", priority: 4, tags: [], ...o });
const stream = (chunks) => new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close(); } });

test("parseLine: message event is normalised", () => {
  const m = parseLine('{"id":"a","time":5,"event":"message","topic":"t","title":"Hi","message":"yo","priority":5,"tags":["x",1]}');
  assert.deepEqual(m, { id: "a", time: 5, topic: "t", title: "Hi", message: "yo", priority: 5, tags: ["x", "1"] });
});
test("parseLine: defaults, non-message events and blanks", () => {
  assert.equal(parseLine('{"event":"message","message":"m"}').priority, 3);
  assert.equal(parseLine('{"event":"open"}'), null);
  assert.equal(parseLine('{"event":"keepalive"}'), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("[1,2]"), null);
});
test("parseLine: invalid JSON throws", () => assert.throws(() => parseLine("{nope"), /bad JSON line/));
test("normPriority clamps and defaults", () => {
  assert.deepEqual([0, 9, "4", "x", undefined, 2.6].map(normPriority), [1, 5, 4, 3, 3, 3]);
});

test("explain: priority threshold, tags, match, mute", () => {
  assert.equal(shouldSpeak(msg({ priority: 3 })), false);
  assert.equal(shouldSpeak(msg({ priority: 4 })), true);
  assert.equal(shouldSpeak(msg({ priority: 3 }), { minPriority: 3 }), true);
  assert.equal(shouldSpeak(msg({ priority: 2, tags: ["skull"] }), { speakTags: ["skull"] }), true);
  assert.equal(shouldSpeak(msg({ title: "Disk", message: "full" }), { match: /meta/i }), false);
  assert.equal(shouldSpeak(msg({ title: "Meta Read Failed" }), { match: /meta/i }), true);
  assert.equal(shouldSpeak(msg({ title: "Meta Read Failed" }), { mute: /meta/i }), false);
  assert.equal(explain(msg({ priority: 1 })).reason, "below priority 4");
  assert.equal(explain(msg({ priority: 1, tags: ["a"] }), { speakTags: ["a"] }).reason, "tag");
});

test("toSpeech: strips urls, markdown, emoji; joins title and message", () => {
  assert.equal(toSpeech(msg({ title: "**Deploy blocked** \u{1F6A8}", message: "See [log](https://e.com/a?b=1) now", priority: 4 })), "Deploy blocked. See log link now.");
  assert.equal(toSpeech(msg({ title: "", message: "only body" })), "only body.");
  assert.equal(toSpeech(msg({ title: "Done!", message: "" })), "Done!");
});
test("toSpeech: urgent prefix only at priority 5 and can be turned off", () => {
  assert.equal(toSpeech(msg({ priority: 5, title: "A", message: "b" })), "Urgent. A. b.");
  assert.equal(toSpeech(msg({ priority: 5, title: "A", message: "b" }), { urgentPrefix: false }), "A. b.");
  assert.equal(toSpeech(msg({ priority: 4, title: "A", message: "b" })), "A. b.");
});
test("toSpeech: truncates on a word boundary and never exceeds maxChars by more than the final period", () => {
  const long = "word ".repeat(100);
  const s = toSpeech(msg({ title: "", message: long }), { maxChars: 40 });
  assert.ok(s.length <= 41 && s.endsWith("word."), s);
  assert.equal(toSpeech(msg({ title: "", message: "\u{1F6A8}\u{1F6A8}" })), "");
});

test("announcer: speaks in order, one at a time", async () => {
  const log = []; let active = 0, maxActive = 0;
  const a = createAnnouncer({ speak: async (t) => { active++; maxActive = Math.max(maxActive, active); log.push(t); await new Promise((r) => setTimeout(r, 5)); active--; } });
  a.handle(msg({ title: "one", message: "" })); a.handle(msg({ title: "two", message: "" })); a.handle(msg({ title: "three", message: "" }));
  await a.idle();
  assert.deepEqual(log, ["one.", "two.", "three."]);
  assert.equal(maxActive, 1);
  assert.equal(a.stats.spoken, 3);
});
test("announcer: duplicate inside the window is skipped, allowed after it", async () => {
  let t = 1000; const log = [];
  const a = createAnnouncer({ speak: async (x) => { log.push(x); }, now: () => t, dedupeMs: 60000 });
  assert.equal(a.handle(msg({ title: "Down" })).action, "speak");
  t += 59999; assert.equal(a.handle(msg({ title: "Down" })).action, "duplicate");
  t += 1; assert.equal(a.handle(msg({ title: "Down" })).action, "speak");
  await a.idle();
  assert.equal(log.length, 2); assert.equal(a.stats.duplicates, 1);
});
test("announcer: full queue drops the OLDEST waiting text", async () => {
  let release; const gate = new Promise((r) => (release = r)); const log = [];
  const a = createAnnouncer({ speak: async (x) => { log.push(x); await gate; }, maxQueue: 2 });
  a.handle(msg({ title: "a", message: "" }));          // being spoken
  await new Promise((r) => setTimeout(r, 1));
  a.handle(msg({ title: "b", message: "" })); a.handle(msg({ title: "c", message: "" }));
  const r = a.handle(msg({ title: "d", message: "" }));
  assert.equal(r.dropped, "b."); assert.equal(a.stats.dropped, 1);
  release(); await a.idle();
  assert.deepEqual(log, ["a.", "c.", "d."]);
});
test("announcer: a failing speak() is counted, reported and does not stop the queue", async () => {
  const errs = []; const log = [];
  const a = createAnnouncer({ speak: async (x) => { if (x === "bad.") throw new Error("boom"); log.push(x); }, onError: (e, t) => errs.push([e.message, t]) });
  a.handle(msg({ title: "bad", message: "" })); a.handle(msg({ title: "good", message: "" }));
  await a.idle();
  assert.deepEqual(errs, [["boom", "bad."]]); assert.deepEqual(log, ["good."]); assert.equal(a.stats.errors, 1);
});
test("announcer: filtered and empty messages are counted, nothing spoken", async () => {
  const a = createAnnouncer({ speak: async () => { throw new Error("must not run"); } });
  assert.equal(a.handle(msg({ priority: 2 })).action, "filtered");
  assert.equal(a.handle(msg({ title: "\u{1F6A8}", message: "" })).reason, "nothing speakable");
  await a.idle(); assert.equal(a.stats.filtered, 2); assert.equal(a.stats.spoken, 0);
});
test("announcer: speak must be a function", () => assert.throws(() => createAnnouncer({}), TypeError));

test("speechSynthesisSpeaker: picks a local voice and resolves on end", async () => {
  const spoken = [];
  class U { constructor(t) { this.text = t; } }
  const synth = { getVoices: () => [{ name: "remote", localService: false }, { name: "local", localService: true }], speak(u) { spoken.push(u); setTimeout(() => u.onend(), 1); } };
  await speechSynthesisSpeaker({ synth, Utterance: U, rate: 1.2 })("hello");
  assert.equal(spoken[0].voice.name, "local"); assert.equal(spoken[0].text, "hello"); assert.equal(spoken[0].rate, 1.2);
});
test("speechSynthesisSpeaker: localOnly refuses when only remote voices exist, and a named remote voice", async () => {
  class U {}
  const synth = { getVoices: () => [{ name: "remote", localService: false }], speak() { throw new Error("must not speak"); } };
  await assert.rejects(speechSynthesisSpeaker({ synth, Utterance: U })("x"), /no local voice/);
  await assert.rejects(speechSynthesisSpeaker({ synth, Utterance: U, voiceName: "remote" })("x"), /not a local voice/);
  await assert.rejects(speechSynthesisSpeaker({ synth, Utterance: U, voiceName: "nope" })("x"), /voice not found/);
});
test("speechSynthesisSpeaker: remote voice allowed only when localOnly is false; utterance error rejects", async () => {
  class U {}
  const synth = { getVoices: () => [{ name: "remote", localService: false }], speak(u) { setTimeout(() => u.onerror({ error: "not-allowed" }), 1); } };
  await assert.rejects(speechSynthesisSpeaker({ synth, Utterance: U, localOnly: false })("x"), /not-allowed/);
});
test("speechSynthesisSpeaker: throws without speechSynthesis", () => assert.throws(() => speechSynthesisSpeaker({ synth: null, Utterance: null }), /not available/));

test("readLines: lines split across chunks, CRLF-safe via JSON trim, trailing line without newline", async () => {
  const got = [];
  await readLines(stream(['{"a":', '1}\n{"b":2}\n{"c"', ":3}"]), (l) => got.push(l));
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});
test("readLines: multi-byte character split across chunks survives", async () => {
  const bytes = new TextEncoder().encode('{"m":"café"}\n');
  const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 9)); c.enqueue(bytes.slice(9)); c.close(); } });
  const got = []; await readLines(body, (l) => got.push(l));
  assert.equal(JSON.parse(got[0]).m, "café");
});

const line = (o) => JSON.stringify(o) + "\n";
test("connect: reconnects with doubling backoff, resumes with ?since=<last id>, reports bad lines", async () => {
  const urls = [], status = [], delays = [], msgs = [], bad = [];
  const ac = new AbortController();
  const replies = [
    () => { throw new Error("ECONNREFUSED"); },
    () => ({ ok: false, status: 503 }),
    () => ({ ok: true, body: stream([line({ event: "open" }), line({ id: "m1", event: "message", message: "one", priority: 5 }), "not json\n"]) }),
    () => { ac.abort(); return { ok: true, body: stream([line({ id: "m2", event: "message", message: "two" })]) }; },
  ];
  await connect({
    server: "http://x.test/", topic: "my topic", signal: ac.signal, headers: { Authorization: "Bearer t" },
    fetch: async (u, o) => { urls.push([u, o.headers.Authorization]); return replies[urls.length - 1](); },
    sleep: async (ms) => { delays.push(ms); },
    onMessage: (m) => msgs.push(m.id), onBadLine: (e) => bad.push(e.message), onStatus: (s) => status.push(s),
  });
  assert.deepEqual(delays, [1000, 2000, 1000]);   // two failures, then the normal end of stream waits minDelayMs too
  assert.equal(urls[0][0], "http://x.test/my%20topic/json");
  assert.equal(urls[2][0], "http://x.test/my%20topic/json");
  assert.equal(urls[3][0], "http://x.test/my%20topic/json?since=m1");
  assert.equal(urls[0][1], "Bearer t");
  assert.deepEqual(msgs, ["m1", "m2"]); assert.equal(bad.length, 1);
  assert.ok(status.some((s) => s.includes("HTTP 503")));
});
test("connect: backoff is capped and resets after a good connection", async () => {
  const delays = []; const ac = new AbortController(); let n = 0;
  await connect({
    topic: "t", signal: ac.signal, minDelayMs: 1000, maxDelayMs: 4000,
    fetch: async () => { n++; if (n === 5) ac.abort(); if (n === 4) return { ok: true, body: stream([]) }; throw new Error("down"); },
    sleep: async (ms) => { delays.push(ms); }, onMessage() {},
  });
  assert.deepEqual(delays, [1000, 2000, 4000, 1000]);
});
test("connect: topic is required; several topics are comma-joined", async () => {
  await assert.rejects(connect({ onMessage() {} }), /topic is required/);
  const ac = new AbortController(); let url;
  await connect({ topic: "a,b c", signal: ac.signal, fetch: async (u) => { url = u; ac.abort(); return { ok: true, body: stream([]) }; }, onMessage() {} });
  assert.equal(url, "https://ntfy.sh/a,b%20c/json");
});

test("ttsCommand: picks a tool per platform, text never in argv, null when none", () => {
  const set = (...n) => (x) => n.includes(x);
  assert.equal(ttsCommand("linux", set("espeak-ng", "espeak")).cmd, "espeak-ng");
  assert.equal(ttsCommand("linux", set("espeak")).cmd, "espeak");
  assert.deepEqual(ttsCommand("linux", set("espeak-ng")).args, ["--stdin"]);
  assert.equal(ttsCommand("darwin", set("say")).cmd, "say");
  const w = ttsCommand("win32", set("powershell"));
  assert.equal(w.cmd, "powershell"); assert.match(w.args.join(" "), /System\.Speech/); assert.match(w.args.join(" "), /\[Console\]::In\.ReadToEnd/);
  assert.equal(ttsCommand("linux", set()), null);
  assert.equal(ttsCommand("darwin", set("espeak-ng")).cmd, "espeak-ng");
});
