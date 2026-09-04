"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Phone-camera client for the bulk-scan contract (docs/bulk-scan-rig.md).
// Same job as the Pi rig: watch for a new card, photograph it, POST it to
// /api/bulk/photo, keep seq honest. It does NOT identify cards — that is
// a server-side job (src/lib/bulkScan.ts, Claude-vision + two-pass
// cross-check) and duplicating it here would undermine that verification.
//
// "New card" is detected client-side by diffing a downscaled grayscale
// frame against the previous tick: motion, then several stable ticks in a
// row, triggers a capture. Same-origin fetch to /api/bulk/photo, so no
// CORS is needed — this page must stay served from this app, not a
// separate static host.

const MOTION_THRESHOLD = 18; // 0-255 avg luma diff; tune against real cards/lighting
const STABLE_TICKS_NEEDED = 4; // consecutive quiet ticks before a capture fires
// After the motion settles, the scene must actually DIFFER from what it was
// before the motion began, or nothing is captured. A hand reaching over the
// table (usually for the Stop button) is motion followed by the exact same
// scene — which used to earn every session a phantom duplicate photo of the
// last card. A genuinely new card, even another copy of the same Mountain,
// lands at a different angle and offset and clears this easily.
const SCENE_CHANGE_MIN = 6;
const TICK_MS = 120;
const DETECT_W = 160;
const DETECT_H = 120;
const MAX_UPLOAD_ATTEMPTS = 5;

type Phase = "setup" | "watching" | "halted";

interface LogEntry {
  seq: number;
  ok: boolean;
  message: string;
  thumbnail: string;
}

class HaltError extends Error {}

function frameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const la = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const lb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    sum += Math.abs(la - lb);
    n++;
  }
  return n ? sum / n : 0;
}

export default function BulkCapturePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const detectCanvasRef = useRef<HTMLCanvasElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tickHandleRef = useRef<number | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  /** What the table looked like just before the current disturbance began —
   *  the reference for "did anything actually change?". */
  const preMotionFrameRef = useRef<Uint8ClampedArray | null>(null);
  const armedRef = useRef(false);
  const stableTicksRef = useRef(0);
  const capturingRef = useRef(false);

  // Locked in at "Start" so an in-flight upload never races a form edit.
  const jobRef = useRef("");
  const keyRef = useRef("");
  const passRef = useRef<1 | 2>(1);
  const seqRef = useRef(1);

  const [phase, setPhase] = useState<Phase>("setup");
  const [job, setJob] = useState("");
  const [key, setKey] = useState("");
  const [pass, setPass] = useState<1 | 2>(1);
  const [startSeq, setStartSeq] = useState(1);
  const [showKey, setShowKey] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [haltMessage, setHaltMessage] = useState<string | null>(null);
  const [cardsCaptured, setCardsCaptured] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);

  // Prefill from a link like /bulk/capture?job=<uuid>&key=<device_key>&pass=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const j = params.get("job");
    const k = params.get("key");
    const p = params.get("pass");
    // seq: for the re-shoot flow — a link can point straight at the card
    // to replace, since posting the same seq overwrites that position.
    const s = parseInt(params.get("seq") ?? "", 10);
    if (j) setJob(j);
    if (k) setKey(k);
    if (p === "2") setPass(2);
    if (Number.isFinite(s) && s >= 1) setStartSeq(s);
  }, []);

  const stopEverything = useCallback(() => {
    if (tickHandleRef.current !== null) {
      window.clearInterval(tickHandleRef.current);
      tickHandleRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopEverything, [stopEverything]);

  // Keep the screen awake while watching — same pattern as scan/page.tsx.
  useEffect(() => {
    if (phase !== "watching") return;
    let sentinel: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request("screen")
      .then((s) => {
        sentinel = s;
      })
      .catch(() => {
        // Denied, unsupported, or the tab isn't visible — not fatal.
      });
    return () => {
      void sentinel?.release().catch(() => {});
    };
  }, [phase]);

  async function uploadFrame(blob: Blob, seq: number): Promise<{ ordinal: number; seq: number }> {
    const form = new FormData();
    form.append("job", jobRef.current);
    form.append("pass", String(passRef.current));
    form.append("seq", String(seq));
    form.append("photo", blob, `frame_${String(seq).padStart(5, "0")}.jpg`);

    let lastError = "unknown error";
    for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000)); // 2s, 4s, 8s, 16s
      }
      try {
        const res = await fetch("/api/bulk/photo", {
          method: "POST",
          headers: { "x-bulk-key": keyRef.current },
          body: form,
        });
        if (res.status === 200) {
          const body = await res.json();
          // body.ordinal echoes the position WITHIN this pass (what we
          // sent) — that's the drift check. body.seq is deliberately
          // something else on pass 2: the paired PASS-1 row (N+1-ordinal),
          // by design, per the contract. Comparing seq here would false-
          // positive-halt on almost every pass-2 upload.
          if (body.ordinal !== seq) {
            throw new HaltError(
              `sent seq=${seq} but server assigned ordinal=${body.ordinal} within this pass — pairing is drifting, stop and check the job`
            );
          }
          return body;
        }
        if (res.status === 401 || res.status === 403 || res.status === 409) {
          const text = await res.text().catch(() => "");
          throw new HaltError(`HALT ${res.status}: ${text || res.statusText}`);
        }
        lastError = `HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`;
      } catch (e) {
        if (e instanceof HaltError) throw e;
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new HaltError(
      `seq=${seq} would not upload after ${MAX_UPLOAD_ATTEMPTS} attempts (${lastError})`
    );
  }

  const captureAndUpload = useCallback(() => {
    if (capturingRef.current) return;
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return;
    capturingRef.current = true;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      capturingRef.current = false;
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const thumbnail = canvas.toDataURL("image/jpeg", 0.4);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          capturingRef.current = false;
          return;
        }
        const seq = seqRef.current;
        uploadFrame(blob, seq)
          .then((body) => {
            seqRef.current += 1;
            setCardsCaptured((c) => c + 1);
            setLog((l) =>
              [{ seq, ok: true, message: `uploaded (ordinal ${body.ordinal})`, thumbnail }, ...l].slice(
                0,
                20
              )
            );
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            setLog((l) => [{ seq, ok: false, message, thumbnail }, ...l].slice(0, 20));
            setHaltMessage(message);
            setPhase("halted");
            stopEverything();
          })
          .finally(() => {
            capturingRef.current = false;
          });
      },
      "image/jpeg",
      0.85
    );
  }, [stopEverything]);

  const tick = useCallback(() => {
    // Detection keeps running DURING an upload — only the trigger waits.
    // Skipping the whole tick made capture timing feel random: a card
    // placed while the previous photo was still uploading was never seen
    // (its motion happened during the blackout), and the stale previous
    // frame caused a spurious "motion" spike the moment ticks resumed.
    const video = videoRef.current;
    const canvas = detectCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, DETECT_W, DETECT_H);
    const frame = ctx.getImageData(0, 0, DETECT_W, DETECT_H).data;
    const prev = prevFrameRef.current;
    prevFrameRef.current = new Uint8ClampedArray(frame);
    if (!prev) return;

    const diff = frameDiff(prev, frame);

    if (diff > MOTION_THRESHOLD) {
      if (!armedRef.current) preMotionFrameRef.current = prev;
      armedRef.current = true;
      stableTicksRef.current = 0;
      return;
    }

    stableTicksRef.current += 1;
    if (!armedRef.current || stableTicksRef.current < STABLE_TICKS_NEEDED) return;
    // An upload is in flight: stay armed with the counter satisfied, and
    // fire on the first tick after the pipe frees up.
    if (capturingRef.current) return;
    armedRef.current = false;
    stableTicksRef.current = 0;
    const before = preMotionFrameRef.current;
    preMotionFrameRef.current = null;
    // Settled back to the same scene: a hand passed over, nothing changed —
    // not a card. See SCENE_CHANGE_MIN.
    if (before && frameDiff(before, frame) < SCENE_CHANGE_MIN) return;
    captureAndUpload();
  }, [captureAndUpload]);

  async function startCapture() {
    if (!job.trim() || !key.trim()) {
      setSetupError("Job ID and device key are both required.");
      return;
    }
    setSetupError(null);
    jobRef.current = job.trim();
    keyRef.current = key.trim();
    passRef.current = pass;
    seqRef.current = startSeq;
    prevFrameRef.current = null;
    armedRef.current = false;
    stableTicksRef.current = 0;
    setHaltMessage(null);
    setLog([]);
    setCardsCaptured(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1600 }, height: { ideal: 1200 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (e) {
      setSetupError(`Could not access the camera: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    setPhase("watching");
    tickHandleRef.current = window.setInterval(tick, TICK_MS);
  }

  function stopCapture() {
    stopEverything();
    setPhase("setup");
  }

  function resumeAfterHalt() {
    // seqRef.current already sits at the card that failed — resuming just
    // re-arms the camera/tick loop; the next successful upload picks up
    // from the same seq, same as --start-seq on the Pi rig.
    setStartSeq(seqRef.current);
    setHaltMessage(null);
    setPhase("setup");
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center px-4 py-6">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-lg font-semibold">Bulk scan — phone capture</h1>
        <p className="text-sm text-neutral-400">
          Watches the camera, auto-captures when a new card settles, and uploads it. Cards are
          identified server-side after upload — this page never tries to read them itself.
        </p>

        {phase === "setup" && (
          <div className="space-y-3">
            <label className="block text-sm">
              Job ID
              <input
                className="mt-1 w-full rounded bg-neutral-900 border border-neutral-700 px-3 py-2"
                value={job}
                onChange={(e) => setJob(e.target.value)}
                placeholder="uuid from the admin page"
              />
            </label>
            <label className="block text-sm">
              Device key
              <div className="mt-1 flex gap-2">
                <input
                  className="flex-1 rounded bg-neutral-900 border border-neutral-700 px-3 py-2"
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="bk_..."
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <button
                  type="button"
                  className="rounded border border-neutral-700 px-3 text-sm"
                  onClick={() => setShowKey((s) => !s)}
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <div className="flex gap-3">
              <label className="flex-1 text-sm">
                Pass
                <select
                  className="mt-1 w-full rounded bg-neutral-900 border border-neutral-700 px-3 py-2"
                  value={pass}
                  onChange={(e) => setPass(Number(e.target.value) as 1 | 2)}
                >
                  <option value={1}>1 (feed order)</option>
                  <option value={2}>2 (reverse order)</option>
                </select>
              </label>
              <label className="flex-1 text-sm">
                Start seq
                <input
                  className="mt-1 w-full rounded bg-neutral-900 border border-neutral-700 px-3 py-2"
                  type="number"
                  min={1}
                  value={startSeq}
                  onChange={(e) => setStartSeq(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            </div>
            {setupError && <p className="text-sm text-red-400">{setupError}</p>}
            <button
              type="button"
              onClick={startCapture}
              className="w-full rounded bg-emerald-600 hover:bg-emerald-500 py-3 font-medium"
            >
              Start camera
            </button>
          </div>
        )}

        {/* Always mounted, even outside "watching" — startCapture() attaches
            the stream to this element the moment getUserMedia resolves, and
            a conditionally-rendered <video> wouldn't exist in the DOM yet at
            that point (videoRef.current would be null, the attach would
            silently no-op, and the element that mounts afterward would never
            get the stream — permission granted, black screen). */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={
            phase === "watching"
              ? "w-full rounded border border-neutral-800 bg-black"
              : "hidden"
          }
        />

        {phase === "watching" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm text-neutral-400">
              <span>
                pass {passRef.current} · seq {seqRef.current} · {cardsCaptured} uploaded
              </span>
              <button
                type="button"
                onClick={stopCapture}
                className="rounded border border-neutral-700 px-3 py-1"
              >
                Stop
              </button>
            </div>
            <button
              type="button"
              onClick={captureAndUpload}
              className="w-full rounded bg-neutral-800 hover:bg-neutral-700 py-3 font-medium"
            >
              Capture now (manual override)
            </button>
          </div>
        )}

        {phase === "halted" && (
          <div className="space-y-3">
            <div className="rounded border border-red-800 bg-red-950/50 p-3 text-sm text-red-300">
              {haltMessage}
            </div>
            <button
              type="button"
              onClick={resumeAfterHalt}
              className="w-full rounded bg-emerald-600 hover:bg-emerald-500 py-3 font-medium"
            >
              Fix and resume from seq {seqRef.current}
            </button>
          </div>
        )}

        {log.length > 0 && (
          <ul className="space-y-1 text-sm">
            {log.map((entry) => (
              <li
                key={`${entry.seq}-${entry.message}`}
                className={`flex items-center gap-2 rounded border px-2 py-1 ${
                  entry.ok ? "border-neutral-800" : "border-red-800 bg-red-950/30"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={entry.thumbnail} alt="" className="h-8 w-8 rounded object-cover" />
                <span className="text-neutral-400">seq {entry.seq}:</span>
                <span className={entry.ok ? "text-neutral-300" : "text-red-300"}>
                  {entry.message}
                </span>
              </li>
            ))}
          </ul>
        )}

        <canvas ref={detectCanvasRef} width={DETECT_W} height={DETECT_H} className="hidden" />
        <canvas ref={captureCanvasRef} className="hidden" />
      </div>
    </main>
  );
}
