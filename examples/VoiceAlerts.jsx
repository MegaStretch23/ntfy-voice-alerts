"use client";
// Next.js (app router) client component. Copy src/voice-alerts.mjs next to it (or into lib/) and fix the import path.
// Browsers such as Chrome can refuse speech until the page has had a click, hence the Enable button.
import { useEffect, useRef, useState } from "react";
import { connect, createAnnouncer, speechSynthesisSpeaker } from "./voice-alerts.mjs";

export default function VoiceAlerts({ server = "https://ntfy.sh", topic, minPriority = 4 }) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("off");
  const [last, setLast] = useState("");
  const speaker = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    const ann = createAnnouncer({
      speak: speaker.current,
      filter: { minPriority },
      onError: (e) => setStatus(`speech failed: ${e.message}`),
    });
    connect({
      server, topic, signal: ac.signal, onStatus: setStatus,
      onMessage: (m) => { const r = ann.handle(m); if (r.action === "speak") setLast(r.text); },
    });
    return () => ac.abort();
  }, [enabled, server, topic, minPriority]);

  function enable() {
    try {
      speaker.current = speechSynthesisSpeaker();            // local voices only
      speaker.current("Voice alerts on.").then(() => setEnabled(true), (e) => setStatus(`cannot speak: ${e.message}`));
    } catch (e) { setStatus(`cannot speak: ${e.message}`); }
  }

  return (
    <div>
      <button onClick={enable} disabled={enabled}>{enabled ? "Voice alerts on" : "Enable voice alerts"}</button>
      <span> {status}</span>{last ? <div>Last spoken: {last}</div> : null}
    </div>
  );
}
