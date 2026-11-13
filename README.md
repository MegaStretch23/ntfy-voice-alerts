# ntfy-voice-alerts

Speak your urgent [ntfy](https://ntfy.sh) alerts out loud. It follows a topic's JSON stream, keeps only the messages you care about (priority 4 and 5 by default), cleans them into a short sentence, skips repeats, and hands the sentence to a text-to-speech function. For a dashboard that is open on a laptop, that means "Meta Read Failed" is said aloud instead of waiting on a phone buzz.

It is one dependency-free ES module (`src/voice-alerts.mjs`, runs in a browser or Node 18+), a small CLI, and a Next.js client component example. The speaking is injected, so in the browser it uses `speechSynthesis` and in the CLI it uses a local tool (`espeak-ng`, `espeak`, `say` or PowerShell SAPI). Nothing in this repo calls a paid or hosted text-to-speech API.

**What it is not:** a notification service (ntfy does that), and not tested in a real browser or on Windows or macOS. See "What was measured" below for exactly what was run.

## Quickstart

Node 18+, nothing to install.

```bash
git clone https://github.com/MegaStretch23/ntfy-voice-alerts && cd ntfy-voice-alerts
node bin/ntfy-voice.mjs --file samples/stream.jsonl
```

`samples/stream.jsonl` is a hand-written file in the line format of ntfy's `/<topic>/json` stream (an `open` event, a `keepalive`, and 8 messages: priorities 2 to 5, one repeated alert, one with markdown, an emoji and a link, one long one). Without `--speak` the command only prints what it would say (`SPEAK` = would be spoken). Output, saved from a real run as `samples/example_output.txt` (a test fails if this README and the saved run drift apart):

```text
p3 SKIP   below priority 4: Backup finished
p5 SPEAK  Urgent. Meta Read Failed. Token expired on the ad account read, 3 retries used.
p4 SPEAK  Disk 91% on box 1. Free space 7 GB, cleanup job queued.
p5 SKIP   same text within 60s: Meta Read Failed
p4 SPEAK  Deploy blocked. See the build log link for the failing step.
p4 SPEAK  Queue stalled. The mission queue has had no completed task for 45 minutes and 12 tasks are waiting, the last worker heartbeat was at 09:14.
p2 SKIP   below priority 4: Low priority note
p5 SPEAK  Urgent. Meta Read Failed. Token expired on the ad account read, 3 retries used.
summary: 8 messages, 5 spoken, 2 filtered, 1 duplicates, 0 dropped, 0 errors
```

Reading it: priority 3 and 2 are below the default threshold; the second "Meta Read Failed" 20 s later is a duplicate inside the 60 s window, the third one 100 s later is spoken again; the link became the word "link", the markdown and the emoji are gone, and the long message was cut at 140 characters on a word boundary.

Follow a real topic and really speak:

```bash
node bin/ntfy-voice.mjs --topic my-fleet-alerts --speak
# self-hosted server, private topic:
NTFY_TOKEN=tk_yourtoken node bin/ntfy-voice.mjs --server https://ntfy.example.org --topic ops --speak --min-priority 3
```

Options: `--min-priority N`, `--tag NAME` (also speak this tag, repeatable), `--match REGEX`, `--mute REGEX`, `--dedupe-seconds N`, `--max-chars N`, `--max-queue N`, `--count N` (stop after N messages), `--speak`. `ntfy-voice --help` lists them. A line that is not valid JSON, or a speech call that fails, prints a `FAILED:` line and the exit code is 1.

## In a Next.js dashboard

Copy `src/voice-alerts.mjs` and `examples/VoiceAlerts.jsx` into your app and render `<VoiceAlerts topic="my-fleet-alerts" />` as a client component. The component shows an "Enable voice alerts" button because browsers such as Chrome can refuse speech until the page has had a click; clicking it speaks one test phrase and then starts the stream. It asks `speechSynthesis` for a voice with `localService: true` and refuses to speak with any other voice (`localOnly`, default), so a browser that only offers network voices produces an error message instead of sending your alert text away.

The library pieces, if you want to build your own:

```js
import { connect, createAnnouncer, speechSynthesisSpeaker } from "./voice-alerts.mjs";
const ann = createAnnouncer({ speak: speechSynthesisSpeaker(), filter: { minPriority: 4 } });
connect({ topic: "my-fleet-alerts", signal, onMessage: (m) => ann.handle(m) });
```

`connect` reconnects with a doubling delay (1 s up to 30 s) and resumes with `?since=<last id>`. `createAnnouncer` speaks one text at a time, skips the same text within `dedupeMs` (60 s), and when more than `maxQueue` (5) texts are waiting it drops the oldest waiting one.

## What was measured

| item | value |
|---|---|
| tests | 32 tests, under 1 s, `node --test tests/`; they cover parsing, filtering, speech text, dedupe/queue, the `speechSynthesis` wrapper (with a fake), line splitting across chunks, reconnect/backoff/`since`, the TTS command builder, the CLI, and a live run of the CLI against a local HTTP server that streams ntfy-format JSON |
| CLI speaking | exercised with a fake `espeak-ng` script on `PATH` that records its stdin: all 5 sentences arrived in order. No real audio was played |
| Next.js example | compiled with esbuild and server-rendered once with React (initial output is the Enable button); the click, `speechSynthesis` and the live stream in a browser were not run |
| ntfy server | not contacted: the stream tests use a local server that imitates the documented line format, not a real ntfy server |
| Node | v26.13.1 on Linux x86_64 |

Nothing else is claimed: no latency, no audio quality, no browser support list.

## Known limits

- Windows (PowerShell SAPI) and macOS (`say`) commands are built and unit-tested but have never been run by me.
- A token placed in browser code is visible to anyone who can load the page. Use `NTFY_TOKEN` with the CLI, or keep the dashboard on a private network or behind your own proxy.
- Whether a browser voice is really local is whatever the browser reports in `localService`.
- Dedupe is on the spoken text, so two different alerts with the same title and message are one alert.
- Messages that arrive while the machine or the tab is asleep are not spoken later in a smart way: after a reconnect ntfy replays from the last seen id, and each replayed message goes through the same filter and dedupe.
- English-oriented cleaning (it strips markdown, emoji and URLs; it does not translate or pronounce anything specially).

## Context

I use ntfy alerts for a fleet of agents and wanted the dashboard to say the critical ones aloud. This repo is independent of ntfy and of Anthropic.

## Also by the author

Unrelated to this tool, there is no paid version of ntfy-voice-alerts. Other things I publish: a pay-per-event [SEC Form 4 insider cluster scanner](https://apify.com/johnveds15/sec-form4-insider-clusters) on Apify ($0.0004 per Form 4 filing parsed, $0.02 per insider cluster detected, price read from the Apify API on 2026-11-13), and two source-code packs for agent work on Gumroad: the [Agent-Turn Delta-Debugger CLI](https://vedovino.gumroad.com/l/zdwyic) ($25) and the [Agent log policy checker](https://vedovino.gumroad.com/l/agent-log-policy-checker) ($19), prices as listed on 2026-11-13.

## License

MIT, see `LICENSE`.
