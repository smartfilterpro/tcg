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

// Motion is measured as the FRACTION OF PIXELS that changed meaningfully,
// not the average brightness change of the whole frame. The average was the
// original sin: a card dropping into a bucket that fills 15% of the view is
// a big change in a small area, and averaged over the frame it vanished —
// close-up tests worked, the real rig never triggered. A pixel counts as
// changed past PIXEL_DELTA luma; the thresholds below are fractions of the
// frame. The live meter on the watching screen shows the exact number the
// detector sees, so aiming and tuning stop being guesswork.
const PIXEL_DELTA = 26; // 0-255 per-pixel luma difference that counts as change
// Hysteresis, tuned against the real rig: a card drop peaks 23-50% and
// settles to 0-1% (field-measured on the meter). ARM sits comfortably
// under the weakest observed peak so a soft drop still registers; SETTLE
// sits just over the observed calm. The PEAK IS THE EVIDENCE: an armed
// episode captures when the motion falls back to calm, full stop — no
// does-the-scene-look-different test, because a card that disappears into
// the bucket leaves the settled scene looking like it did before, and
// that test was eating every capture.
const ARM_FRAC = 0.15; // an episode starts when ≥15% of pixels change
const SETTLE_FRAC = 0.02; // …and captures when change falls back under 2%
const STABLE_TICKS_NEEDED = 2; // ~240ms of calm — fire on the drop from peak
const TICK_MS = 120;
const DETECT_W = 160;
const DETECT_H = 120;
const MAX_UPLOAD_ATTEMPTS = 5;
// Parallel uploads in the air before the shutter waits. The phone's uplink
// is the real limit; four keeps a fast chute moving without swamping it.
const MAX_IN_FLIGHT = 4;

type Phase = "setup" | "watching" | "halted";

interface LogEntry {
  seq: number;
  ok: boolean;
  message: string;
  thumbnail: string;
}

class HaltError extends Error {}

/** Fraction of pixels whose luma moved more than PIXEL_DELTA — localized
 *  change at full strength instead of diluted into a frame-wide average. */
function changedFraction(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let changed = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const la = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const lb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    if (Math.abs(la - lb) > PIXEL_DELTA) changed++;
    n++;
  }
  return n ? changed / n : 0;
}

export default function BulkCapturePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const detectCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tickHandleRef = useRef<number | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const armedRef = useRef(false);
  const stableTicksRef = useRef(0);
  /** Strongest motion seen in the current episode / the previous one —
   *  shown on the meter so threshold tuning stays evidence-based. */
  const peakRef = useRef(0);
  const lastPeakRef = useRef(0);
  /** Uploads currently in the air; the shutter only waits at the cap. */
  const inFlightRef = useRef(0);
  const lowestFailedSeqRef = useRef<number | null>(null);
  /** True only while actually capturing (not preview): the tick loop and
   *  meter run in both modes, the shutter only in this one. */
  const detectionActiveRef = useRef(false);
  /** The live motion readout; written imperatively from the tick loop. */
  const meterRef = useRef<HTMLSpanElement>(null);

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
  const [info, setInfo] = useState<string | null>(null);
  /** Camera running for aiming, before capture starts. */
  const [previewing, setPreviewing] = useState(false);
  /** Digital zoom: the CENTER CROP of the frame, applied identically to the
   *  on-screen preview, the motion detector, and the uploaded photo — what
   *  you see is exactly what gets captured. Digital rather than the track's
   *  native zoom because native support is patchy across phones and the
   *  crop behaves the same everywhere; 1600px source at 2× still uploads
   *  800px, plenty for the reader. */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
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
    setPreviewing(false);
  }, []);

  /** The zoomed source rectangle: the center 1/zoom of the frame. */
  function cropOf(video: HTMLVideoElement) {
    const z = Math.max(1, zoomRef.current);
    const sw = video.videoWidth / z;
    const sh = video.videoHeight / z;
    return { sx: (video.videoWidth - sw) / 2, sy: (video.videoHeight - sh) / 2, sw, sh };
  }

  /** Turn the camera on without starting detection — for aiming and zooming
   *  before the first card, with the motion meter live. */
  async function openPreview() {
    if (streamRef.current) return;
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
      setPreviewing(true);
      prevFrameRef.current = null;
      if (tickHandleRef.current === null) {
        tickHandleRef.current = window.setInterval(tick, TICK_MS);
      }
    } catch (e) {
      setSetupError(`Could not access the camera: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
          // something else on pass 2 (a holding row; Finalize pairs the
          // passes by content), so comparing seq here would false-
          // positive-halt on every pass-2 upload.
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
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    if (inFlightRef.current >= MAX_IN_FLIGHT) return;

    // Claim the position NOW. Uploads run in PARALLEL — a chute feeds a
    // card every ~700ms and an upload takes longer than that, so the old
    // serial flow (shutter locked until the last photo landed) capped the
    // whole rig at one card per round trip. Claiming seq at capture time
    // is what keeps parallel uploads honestly numbered.
    const seq = seqRef.current;
    seqRef.current += 1;

    // A fresh canvas per capture: the next card can arrive and be drawn
    // before this one's blob has finished encoding.
    const canvas = document.createElement("canvas");
    const { sx, sy, sw, sh } = cropOf(video);
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      // Refund the claim only if nothing claimed after us — a numbering
      // hole would shift the pass-2 pairing of everything behind it.
      if (seqRef.current === seq + 1) seqRef.current = seq;
      return;
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const thumbnail = canvas.toDataURL("image/jpeg", 0.4);

    inFlightRef.current += 1;
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          inFlightRef.current -= 1;
          if (seqRef.current === seq + 1) seqRef.current = seq;
          return;
        }
        uploadFrame(blob, seq)
          .then((body) => {
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
            // Resume must restart at the FIRST hole, not past the frames
            // claimed after it while uploads overlapped.
            lowestFailedSeqRef.current = Math.min(lowestFailedSeqRef.current ?? seq, seq);
            seqRef.current = lowestFailedSeqRef.current;
            setHaltMessage(message);
            setPhase("halted");
            stopEverything();
          })
          .finally(() => {
            inFlightRef.current -= 1;
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

    const { sx, sy, sw, sh } = cropOf(video);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, DETECT_W, DETECT_H);
    const frame = ctx.getImageData(0, 0, DETECT_W, DETECT_H).data;
    const prev = prevFrameRef.current;
    prevFrameRef.current = new Uint8ClampedArray(frame);
    if (!prev) return;

    const diff = changedFraction(prev, frame);
    if (armedRef.current) peakRef.current = Math.max(peakRef.current, diff);

    // The live meter: what the detector sees, updated imperatively so 8
    // ticks a second never re-render the page.
    if (meterRef.current) {
      const peak = armedRef.current ? peakRef.current : lastPeakRef.current;
      meterRef.current.textContent =
        `motion ${(diff * 100).toFixed(1)}% · peak ${(peak * 100).toFixed(0)}% · ${
          !detectionActiveRef.current
            ? "preview — not capturing"
            : armedRef.current
              ? "armed — will capture when calm"
              : "watching"
        }${inFlightRef.current > 0 ? ` · ${inFlightRef.current} uploading` : ""}`;
    }
    if (!detectionActiveRef.current) return;

    if (diff > ARM_FRAC) {
      if (!armedRef.current) peakRef.current = diff;
      armedRef.current = true;
      stableTicksRef.current = 0;
      return;
    }

    // The dead zone between SETTLE and ARM neither counts as calm nor
    // resets the calm already banked — a brief flicker mid-settle (auto-
    // exposure catching up with the new card) must not hold the shutter.
    if (diff > SETTLE_FRAC) return;

    stableTicksRef.current += 1;
    if (!armedRef.current || stableTicksRef.current < STABLE_TICKS_NEEDED) return;
    // At the parallel-upload cap: stay armed with the counter satisfied,
    // and fire on the first tick with room in the pipe.
    if (inFlightRef.current >= MAX_IN_FLIGHT) return;
    armedRef.current = false;
    stableTicksRef.current = 0;
    lastPeakRef.current = peakRef.current;
    peakRef.current = 0;
    captureAndUpload();
  }, [captureAndUpload]);

  async function startCapture() {
    if (!job.trim() || !key.trim()) {
      setSetupError("Job ID and device key are both required.");
      return;
    }
    setSetupError(null);
    lowestFailedSeqRef.current = null;
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

    // A preview already opened the camera; reuse its stream.
    if (!streamRef.current) {
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
    }

    setPreviewing(false);
    detectionActiveRef.current = true;
    setPhase("watching");
    if (tickHandleRef.current === null) {
      tickHandleRef.current = window.setInterval(tick, TICK_MS);
    }
  }

  function stopCapture() {
    detectionActiveRef.current = false;
    stopEverything();
    // Resume where this run left off: seqRef points at the next unclaimed
    // position (or the first failed one, after a halt). Without this, a
    // stop-and-restart quietly re-posted seq 1 and OVERWROTE the cards
    // already shot — same-seq posts are the re-shoot mechanism, so the
    // server obliged. Editing the field back down is still how you
    // deliberately re-shoot.
    setStartSeq(seqRef.current);
    setInfo(
      `Stopped after card ${seqRef.current - 1}. Start seq is set to ${seqRef.current} — ` +
        `press Start to continue this pass where you left off.`
    );
    setPhase("setup");
  }

  /** Wipe this pass server-side and reset to seq 1 — the start-over button.
   *  Device-key authed, so it lives here with the person feeding cards. */
  async function eraseThisPass() {
    if (!job.trim() || !key.trim()) {
      setSetupError("Job ID and device key are both required.");
      return;
    }
    if (
      !confirm(
        `Erase every pass ${pass} photo in this job and start the pass over? The other pass is untouched.`
      )
    ) {
      return;
    }
    setSetupError(null);
    setInfo(null);
    try {
      const res = await fetch(
        `/api/bulk/photo?job=${encodeURIComponent(job.trim())}&pass=${pass}`,
        { method: "DELETE", headers: { "x-bulk-key": key.trim() } }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSetupError(json.error ?? `Erase failed (HTTP ${res.status})`);
        return;
      }
      setStartSeq(1);
      seqRef.current = 1;
      setInfo(`Pass ${pass} erased (${json.cleared ?? 0} photos). Start seq reset to 1.`);
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : "Erase failed");
    }
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
                  <option value={1}>1 (the only pass you need)</option>
                  <option value={2}>2 (optional — any order)</option>
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
            {info && <p className="text-sm text-emerald-400">{info}</p>}
            <button
              type="button"
              onClick={startCapture}
              className="w-full rounded bg-emerald-600 hover:bg-emerald-500 py-3 font-medium"
            >
              {previewing ? "Start capturing" : "Start camera"}
            </button>
            {!previewing && (
              <button
                type="button"
                onClick={openPreview}
                className="w-full rounded border border-neutral-700 py-2.5 text-sm hover:bg-neutral-900"
              >
                Preview camera — aim &amp; zoom first
              </button>
            )}
            <button
              type="button"
              onClick={eraseThisPass}
              className="w-full rounded border border-red-900 py-2.5 text-sm text-red-400 hover:bg-red-950/40"
            >
              Erase pass {pass} &amp; start it over
            </button>
          </div>
        )}

        {/* Always mounted, even outside "watching" — startCapture() attaches
            the stream to this element the moment getUserMedia resolves, and
            a conditionally-rendered <video> wouldn't exist in the DOM yet at
            that point (videoRef.current would be null, the attach would
            silently no-op, and the element that mounts afterward would never
            get the stream — permission granted, black screen). */}
        {/* The preview shows the same center crop the capture uses: the
            wrapper clips, the scale is the zoom. */}
        <div
          className={
            phase === "watching" || previewing
              ? "w-full overflow-hidden rounded border border-neutral-800 bg-black"
              : "hidden"
          }
        >
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full origin-center"
            style={{ transform: `scale(${zoom})` }}
          />
        </div>

        {(phase === "watching" || previewing) && (
          <label className="block text-sm text-neutral-400">
            Zoom {zoom.toFixed(1)}×
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              value={zoom}
              onChange={(e) => {
                const z = Number(e.target.value);
                setZoom(z);
                zoomRef.current = z;
              }}
              className="mt-1 w-full"
            />
          </label>
        )}

        {previewing && phase === "setup" && (
          <div className="flex items-center justify-between text-sm text-neutral-400">
            <span ref={meterRef} className="font-mono text-xs text-neutral-500" />
            <button
              type="button"
              onClick={stopCapture}
              className="rounded border border-neutral-700 px-3 py-1"
            >
              Close preview
            </button>
          </div>
        )}

        {phase === "watching" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm text-neutral-400">
              <span>
                pass {passRef.current} · seq {seqRef.current} · {cardsCaptured} uploaded
                <br />
                <span ref={meterRef} className="font-mono text-xs text-neutral-500" />
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
      </div>
    </main>
  );
}
