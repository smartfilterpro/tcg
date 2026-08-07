"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import { CreditLock } from "@/components/CreditLock";
import { useCredits } from "@/components/useCredits";
import type { GradeReport } from "@/lib/grading";
import type { GradeValue } from "@/lib/gradeValue";
import { quadLooksLikeCard, quadNearEdge, type CenteringMeasurement, type Quad } from "@/lib/cardGeometry";
import {
  loadPhoto,
  initialQuad,
  previewSide,
  prepareSide,
  type LoadedPhoto,
  type PreparedSide,
  type SidePreview,
} from "@/lib/cardImage";
import { uploadCardPhoto } from "@/lib/photos";
import { photoSrc } from "@/lib/art";
import CardCropper from "@/components/CardCropper";
import CenteringDiagram from "@/components/CenteringDiagram";
import GradeReportView, { gradeColor } from "@/components/GradeReportView";
import type { SavedGrade } from "@/app/api/grade/reports/route";
import { FanMark } from "@/components/Logo";
import { APP_NAME } from "@/lib/branding";

const GRADE_STEPS = [
  "Flattening the card and measuring its borders…",
  `${AI_NAME} is examining the corner close-ups…`,
  "Checking edges for whitening…",
  "Scanning the surface for scratches and print flaws…",
  "Pricing it against graded sales…",
  "Writing up the grading report…",
];

interface SideState {
  photo: LoadedPhoto;
  quad: Quad;
  detected: boolean;
  preview: SidePreview | null;
}

/** Capture-column panel chrome, per artboard 12: slightly tighter than the
 *  report column's, since the column itself is only 330px wide. */
const CAPTURE_PANEL = "rounded-2xl border border-brand-line bg-white p-4";

/** The pill used for both header actions on a finished report. */
const OUTLINE_PILL =
  "whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[15px] py-2 text-[12.5px] font-medium hover:bg-brand-sunken";

const MIGRATION_NOTE =
  "Your saved grades are NOT gone — the database is missing a one-time update. " +
  "Ask the admin to run supabase/migrations/024_grade_reports.sql.";

/** One photo: empty slot, or the cropper plus its live flattened preview. */
function SidePanel({
  label,
  hint,
  side,
  onFile,
  onQuad,
  onRedetect,
}: {
  label: string;
  hint: string;
  side: SideState | null;
  onFile: (f: File) => void;
  onQuad: (q: Quad) => void;
  onRedetect: () => void;
}) {
  if (!side) {
    return (
      <div className={CAPTURE_PANEL}>
        <div className="mb-[9px] font-display text-sm font-bold">{label}</div>
        <label className="block cursor-pointer">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = "";
            }}
          />
          <div className="flex aspect-[63/88] flex-col items-center justify-center rounded-[9px] border-2 border-dashed border-brand-line-strong bg-brand-panel-alt hover:bg-brand-sunken">
            <div className="text-3xl">📷</div>
            <div className="mt-1 text-sm font-medium">Add a photo</div>
            <div className="mt-0.5 px-3 text-center text-[11px] text-brand-ink5">{hint}</div>
          </div>
        </label>
      </div>
    );
  }

  const m = side.preview?.measurement ?? null;
  const metrics = side.preview?.metrics;
  const nearEdge = quadNearEdge(side.quad, side.photo.width, side.photo.height);
  const bleed = side.preview?.bleed ?? 0;
  const wrongShape = !quadLooksLikeCard(side.quad);
  return (
    <div className={CAPTURE_PANEL}>
      <div className="mb-[9px] font-display text-sm font-bold">{label}</div>
      <CardCropper
        photo={side.photo}
        quad={side.quad}
        onChange={onQuad}
        onRedetect={onRedetect}
        detected={side.detected}
        actions={
          <label className="cursor-pointer">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = "";
              }}
            />
            <span className="inline-block whitespace-nowrap rounded-full border border-brand-line-strong bg-white px-[13px] py-[7px] text-[12.5px] font-medium hover:bg-brand-sunken">
              ↺ Retake
            </span>
          </label>
        }
      />
      {side.preview && (
        <div className="mt-3 flex gap-[11px] rounded-[10px] bg-brand-panel-alt p-2.5">
          <CenteringDiagram
            compact
            cardDataUrl={side.preview.cardDataUrl}
            measurement={m}
            label={`${label} flattened`}
          />
          <div className="min-w-0 text-[11.5px] leading-[1.5] text-brand-ink3">
            <p className="font-bold text-brand-ink2">This is what gets graded</p>
            {wrongShape && (
              <p className="font-medium text-brand-warning">
                That outline isn&apos;t card-shaped — a card is noticeably taller than it is wide.
                Drag each handle onto a corner of the card, or tap Auto-detect again.
              </p>
            )}
            {/* Correct crops measure a few percent; a genuinely misplaced
                outline runs 30% and up. */}
            {bleed > 0.25 && (
              <p className="font-medium text-brand-warning">
                The outline is catching the table around the card — pull the corners in until only
                the card is left.
              </p>
            )}
            {m ? (
              <>
                <p className="mt-[3px]">
                  Centering{" "}
                  {m.lr ? <b>{`${m.lr.pct[0]}/${m.lr.pct[1]} across`}</b> : "— across"} ·{" "}
                  {m.tb ? <b>{`${m.tb.pct[0]}/${m.tb.pct[1]} down`}</b> : "— down"} — allows up to a{" "}
                  <b>{m.cap}</b>
                </p>
                {(!m.lr || !m.tb) && (
                  <p className="text-brand-ink4">{(!m.lr ? m.lrNote : m.tbNote) ?? ""}</p>
                )}
                <p className="mt-[3px] text-brand-ink5">
                  The blue bands should sit exactly on the printed border. If they don&apos;t, nudge
                  the corners.
                </p>
              </>
            ) : (
              <p>
                No border this scan can read reliably — common on full-art and borderless cards, so
                centering will be judged by eye instead.
              </p>
            )}
            {nearEdge && (
              <p className="font-medium text-brand-warning">
                The card fills the frame — leave a little space around it so it can be found
                reliably.
              </p>
            )}
            {metrics?.blurry && (
              <p className="font-medium text-brand-warning">
                Looks soft — a sharper photo grades better.
              </p>
            )}
            {metrics?.glary && (
              <p className="font-medium text-brand-warning">
                Glare detected — try even, indirect light.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A saved grade, reopened. Scrolls the whole overlay rather than a fixed
 *  panel, which is what keeps it on screen when a phone keyboard or zoom
 *  shifts the viewport. */
/** Recording what a card ACTUALLY graded.
 *
 *  This is the only real supervision the grader will ever get — everything
 *  else in a saved report is the model's own opinion, and a dataset of a
 *  model's opinions can only teach it to be more sure of them. So it is asked
 *  for plainly, on the report it belongs to, at the moment someone has the
 *  slab in their hand. */
function OutcomeForm({ grade, onSaved }: { grade: SavedGrade; onSaved: () => void }) {
  const [open, setOpen] = useState(grade.actualGrade != null);
  const [value, setValue] = useState(grade.actualGrade?.toString() ?? "");
  const [grader, setGrader] = useState(grade.actualGrader ?? "PSA");
  const [cert, setCert] = useState(grade.actualCert ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const predicted = grade.estimatedGrade;
  const actual = grade.actualGrade;
  const delta = predicted != null && actual != null ? predicted - actual : null;

  async function save(clear = false) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/grade/reports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: grade.id,
          actualGrade: clear ? null : Number(value),
          actualGrader: clear ? null : grader,
          actualCert: clear ? null : cert,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't save that");
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save that");
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <button
        className="self-start rounded-full border border-brand-line-strong bg-white px-4 py-2 text-[12.5px] font-medium hover:bg-brand-sunken"
        onClick={() => setOpen(true)}
      >
        Did you get it graded? Record the real result
      </button>
    );
  }

  return (
    <div className="rounded-[14px] border border-brand-line bg-white p-4">
      <div className="mb-1 font-display text-[15px] font-bold">What did it actually grade?</div>
      <p className="mb-3 text-[12.5px] leading-[1.55] text-brand-ink3">
        Only worth filling in once the card is back from the grader. It&apos;s what teaches the
        estimate to get better — and it shows you how close this one was.
      </p>
      {actual != null && delta != null && (
        <div className="mb-3 rounded-[10px] bg-brand-panel-alt px-3 py-2 text-[12.5px] text-brand-ink2">
          Estimated <b>{predicted}</b>, actually <b>{actual}</b> —{" "}
          {delta === 0
            ? "exactly right."
            : `${Math.abs(delta)} ${Math.abs(delta) === 1 ? "point" : "points"} ${
                delta > 0 ? "optimistic" : "conservative"
              }.`}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] font-medium text-brand-ink3">
          Grade
          <input
            type="number"
            min={1}
            max={10}
            step={0.5}
            className="w-[86px] rounded-[10px] border border-brand-line-strong px-2.5 py-1.5 text-sm outline-none focus:border-brand-accent"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-medium text-brand-ink3">
          Graded by
          <select
            className="rounded-[10px] border border-brand-line-strong bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-accent"
            value={grader}
            onChange={(e) => {
              setGrader(e.target.value);
              setSaved(false);
            }}
          >
            {["PSA", "BGS", "CGC", "SGC", "other"].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[12px] font-medium text-brand-ink3">
          Cert number <span className="font-normal text-brand-ink5">(optional)</span>
          <input
            className="rounded-[10px] border border-brand-line-strong px-2.5 py-1.5 text-sm outline-none focus:border-brand-accent"
            value={cert}
            onChange={(e) => {
              setCert(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <button
          className="rounded-full bg-brand-ink px-4 py-2 text-[13px] font-medium text-brand-canvas hover:bg-brand-ink2 disabled:opacity-50"
          disabled={busy || !value}
          onClick={() => save()}
        >
          {busy ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
        {actual != null && (
          <button
            className="text-[12px] text-brand-ink4 hover:underline"
            disabled={busy}
            onClick={() => {
              setValue("");
              setCert("");
              save(true);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {err && <p className="mb-0 mt-2 text-[12.5px] text-brand-negative">{err}</p>}
    </div>
  );
}

function SavedGradeModal({
  grade,
  onClose,
  onDelete,
  onOutcomeSaved,
}: {
  grade: SavedGrade;
  onClose: () => void;
  onDelete: () => void;
  onOutcomeSaved: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-brand-ink/60 p-4" onClick={onClose}>
      <div
        className="mx-auto my-4 w-full max-w-[min(60rem,94vw)] rounded-2xl bg-brand-canvas p-4 shadow-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg font-bold">
              {grade.cardName ?? "Saved grade"}
            </h2>
            <p className="text-xs text-brand-ink5">
              Graded {new Date(grade.createdAt).toLocaleString()}
            </p>
          </div>
          <button
            className="shrink-0 text-xl leading-none text-brand-ink5 hover:text-brand-ink"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <GradeReportView
          report={grade.report}
          value={grade.value}
          measurement={grade.measurement}
          cardImage={photoSrc(grade.frontUrl)}
          backImage={photoSrc(grade.backUrl)}
          meta={`saved ${new Date(grade.createdAt).toLocaleDateString()}`}
          headerActions={
            <button className={OUTLINE_PILL} onClick={onClose}>
              Close
            </button>
          }
          footer={
            <>
              <OutcomeForm grade={grade} onSaved={onOutcomeSaved} />
              <div className="rounded-[14px] bg-brand-sunken px-4 py-[14px] text-[12.5px] leading-[1.55] text-brand-ink2">
                <b className="font-display">An estimate for fun and planning</b> — not an official
                grade. PSA, BGS or CGC may grade differently after physical inspection.
              </div>
              <button
                className="self-start text-[12.5px] text-brand-negative hover:underline"
                onClick={() => {
                  if (confirm("Delete this saved grade?")) onDelete();
                }}
              >
                Delete this grade
              </button>
            </>
          }
        />
      </div>
    </div>
  );
}

export default function GradePage() {
  const creditState = useCredits();
  const [front, setFront] = useState<SideState | null>(null);
  const [back, setBack] = useState<SideState | null>(null);
  const [grading, setGrading] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<GradeReport | null>(null);
  const [value, setValue] = useState<GradeValue | null>(null);
  const [shown, setShown] = useState<{ front: PreparedSide; back: PreparedSide } | null>(null);
  const [gradeSeconds, setGradeSeconds] = useState<number | null>(null);
  const [fee, setFee] = useState(25);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [history, setHistory] = useState<SavedGrade[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openGrade, setOpenGrade] = useState<SavedGrade | null>(null);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  useEffect(() => {
    if (!grading) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, GRADE_STEPS.length - 1)), 5000);
    return () => clearInterval(t);
  }, [grading]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/grade/reports");
      const json = await res.json();
      // Surface load failures loudly — a failed fetch must never look like an
      // empty history. Without the res.ok check this swallowed every error and
      // rendered "no saved grades", which is indistinguishable from losing them.
      if (!res.ok) throw new Error(json.error || "load failed");
      setHistory(json.grades ?? []);
      setHistoryError(json.migrated === false ? MIGRATION_NOTE : null);
    } catch (e) {
      setHistory([]);
      setHistoryError(
        `Couldn't load your grading history just now — your saved grades are NOT gone. (${
          e instanceof Error ? e.message : "load failed"
        }) Refresh in a moment.`
      );
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function pickFile(which: "front" | "back", file: File) {
    const setter = which === "front" ? setFront : setBack;
    try {
      const photo = await loadPhoto(file);
      urlsRef.current.push(photo.url);
      const { quad, detected } = initialQuad(photo);
      setter({ photo, quad, detected, preview: previewSide(photo, quad) });
    } catch {
      setError("That photo couldn't be opened — try another.");
    }
  }

  function updateQuad(which: "front" | "back", quad: Quad) {
    const setter = which === "front" ? setFront : setBack;
    setter((s) => (s ? { ...s, quad } : s));
  }

  // Re-measure shortly after the corners stop moving: instant feedback
  // without recomputing the warp on every pointer event.
  useEffect(() => {
    if (!front) return;
    const t = setTimeout(
      () => setFront((s) => (s ? { ...s, preview: previewSide(s.photo, s.quad) } : s)),
      250
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [front?.quad]);

  useEffect(() => {
    if (!back) return;
    const t = setTimeout(
      () => setBack((s) => (s ? { ...s, preview: previewSide(s.photo, s.quad) } : s)),
      250
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back?.quad]);

  function redetect(which: "front" | "back") {
    const setter = which === "front" ? setFront : setBack;
    setter((s) => {
      if (!s) return s;
      const { quad, detected } = initialQuad(s.photo);
      return { ...s, quad, detected, preview: previewSide(s.photo, quad) };
    });
  }

  async function saveGrade(
    rep: GradeReport,
    val: GradeValue | null,
    measurement: CenteringMeasurement | null,
    prepared: { front: PreparedSide; back: PreparedSide }
  ) {
    setSaveState("saving");
    setSaveError(null);
    try {
      const [frontUrl, backUrl] = await Promise.all([
        uploadCardPhoto(prepared.front.cardBlob),
        uploadCardPhoto(prepared.back.cardBlob),
      ]);
      const res = await fetch("/api/grade/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report: rep,
          value: val,
          measurement,
          cardId: val?.cardId ?? null,
          cardName: val?.cardName ?? rep.card_identified,
          frontUrl,
          backUrl,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSaveState("saved");
      loadHistory();
    } catch (e) {
      setSaveState("failed");
      setSaveError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function grade() {
    if (!front || !back || grading) return;
    setGrading(true);
    setError(null);
    setReport(null);
    setValue(null);
    setSaveState("idle");
    const startedAt = Date.now();
    try {
      const [f, b] = await Promise.all([
        prepareSide(front.photo, front.quad),
        prepareSide(back.photo, back.quad),
      ]);
      if (!f || !b) throw new Error("Couldn't flatten the card — try replacing the corners.");
      setShown({ front: f, back: b });

      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fee,
          front: {
            card: { data: f.cardBase64, mediaType: "image/jpeg" },
            corners: f.corners.map((c) => ({ label: c.label, data: c.base64, mediaType: "image/jpeg" })),
            centering: f.measurement,
          },
          back: {
            card: { data: b.cardBase64, mediaType: "image/jpeg" },
            corners: b.corners.map((c) => ({ label: c.label, data: c.base64, mediaType: "image/jpeg" })),
            centering: b.measurement,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Grading failed");
      // The grade is a job now, like a scan: the model runs for half a
      // minute and a locked phone used to kill the request while the credits
      // were already spent. Poll rather than await — a poll just resumes on
      // the next tick after a sleep.
      const result = await watchGradeJob(json.jobId);
      setGradeSeconds(Math.round((Date.now() - startedAt) / 1000));
      setReport(result.report);
      setValue(result.value ?? null);
      saveGrade(result.report, result.value ?? null, f.measurement, { front: f, back: b });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grading failed");
    }
    setGrading(false);
  }

  async function watchGradeJob(
    jobId: string
  ): Promise<{ report: GradeReport; value: GradeValue | null }> {
    for (;;) {
      const res = await fetch(`/api/grade?job=${encodeURIComponent(jobId)}`);
      const json = await res.json();
      const job = json.job as {
        status: string;
        result: { report: GradeReport; value: GradeValue | null } | null;
        error: string | null;
      } | null;
      if (!job) throw new Error("That grading run couldn't be found.");
      if (job.status === "error") throw new Error(job.error || "Grading failed");
      if (job.status === "done" && job.result) return job.result;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  function reset() {
    setReport(null);
    setValue(null);
    setShown(null);
    setFront(null);
    setBack(null);
    setSaveState("idle");
  }

  // Pick up a grade already running — the phone locked, the person came
  // back, and the report is sitting on the server, paid for. Without this
  // the obvious move is to grade again and pay twice.
  //
  // The flattened previews are gone with the old page state, so the report
  // renders without them; the saved-report history has its own copies.
  useEffect(() => {
    let live = true;
    fetch("/api/grade")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const job = j?.job as { id: string; status: string } | null | undefined;
        if (!live || !job || job.status !== "running") return;
        setGrading(true);
        watchGradeJob(job.id)
          .then((result) => {
            if (!live) return;
            setReport(result.report);
            setValue(result.value ?? null);
          })
          .catch((e) => live && setError(e instanceof Error ? e.message : "Grading failed"))
          .finally(() => live && setGrading(false));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the screen awake while a grade runs, where the browser allows it.
  // The job survives sleep either way; this just avoids the round trip.
  useEffect(() => {
    if (!grading) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock
      ?.request("screen")
      .then((sen) => {
        sentinel = sen;
      })
      .catch(() => {});
    return () => {
      void sentinel?.release().catch(() => {});
    };
  }, [grading]);

  async function deleteGrade(id: string) {
    await fetch(`/api/grade/reports?id=${id}`, { method: "DELETE" });
    setOpenGrade(null);
    loadHistory();
  }

  return (
    <>
      <div className="mb-5">
        <h1 className="font-display text-[26px] font-bold tracking-[-.025em]">Card grading</h1>
        <p className="mt-[3px] max-w-[74ch] text-sm leading-[1.6] text-brand-ink3">
          Place the card&apos;s corners and {APP_NAME} flattens out the camera angle, measures the
          borders in software, then has {AI_NAME} judge corners, edges and surface from the
          close-ups — and tells you whether grading would actually pay. Every grade is kept, so you
          can come back to it.
        </p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[330px_minmax(0,1fr)]">
        {/* capture column */}
        <div className="flex flex-col gap-3">
          <SidePanel
            label="Front"
            hint="Whole card visible, bright even light"
            side={front}
            onFile={(f) => pickFile("front", f)}
            onQuad={(q) => updateQuad("front", q)}
            onRedetect={() => redetect("front")}
          />
          <SidePanel
            label="Back"
            hint="The back reveals edge wear best"
            side={back}
            onFile={(f) => pickFile("back", f)}
            onQuad={(q) => updateQuad("back", q)}
            onRedetect={() => redetect("back")}
          />

          <div className={CAPTURE_PANEL}>
            <label className="flex flex-wrap items-center gap-[9px] text-[12.5px] text-brand-ink3">
              <span>Grading fee per card</span>
              <span className="flex items-center gap-1">
                $
                <input
                  type="number"
                  min={0}
                  max={500}
                  step={1}
                  value={fee}
                  onChange={(e) => setFee(Math.max(0, Math.min(500, Number(e.target.value) || 0)))}
                  className="w-[62px] rounded-lg border border-brand-line-strong px-[9px] py-[5px] font-mono text-[13px] text-brand-ink outline-none focus:border-brand-accent"
                />
              </span>
              <span className="text-brand-ink5">used for the &ldquo;worth it?&rdquo; maths</span>
            </label>
            {/* The grade itself is a model call, so the balance decides,
                not the plan — a Pro out of credits is in the same place as
                a free user, and should be told so plainly. */}
            {creditState.empty ? (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-1">
                <CreditLock plan={creditState.credits?.plan} label="Out of credits to grade" />
              </div>
            ) : (
              <button
                className="mt-3 w-full whitespace-nowrap rounded-full bg-brand-ink px-4 py-3 text-[14.5px] font-medium text-brand-canvas hover:bg-brand-ink2 disabled:opacity-50"
                disabled={!front || !back || grading}
                onClick={grade}
              >
                {grading ? "Grading…" : "Grade my card"}
              </button>
            )}
            {grading && (
              <div className="mt-2.5 flex items-center gap-2">
                <FanMark size={16} className="animate-spin-slow shrink-0" />
                <p className="animate-pulse text-[12.5px] text-brand-ink3">{GRADE_STEPS[step]}</p>
              </div>
            )}
            {error && <p className="mt-2.5 text-[12.5px] text-brand-negative">{error}</p>}
          </div>

          <div className="rounded-[14px] bg-brand-sunken px-4 py-[14px] text-[12.5px] leading-[1.55] text-brand-ink2">
            <b className="font-display">An estimate for fun and planning</b> — not an official
            grade. PSA, BGS or CGC may grade differently after physical inspection.
          </div>
        </div>

        {/* report column */}
        <div className="flex min-w-0 flex-col gap-3">
          {report ? (
            <GradeReportView
              report={report}
              value={value}
              measurement={shown?.front.measurement ?? null}
              cardImage={shown?.front.cardDataUrl ?? null}
              corners={shown?.front.corners}
              meta={gradeSeconds != null ? `graded in ${gradeSeconds}s` : undefined}
              headerActions={
                <button className={OUTLINE_PILL} onClick={reset}>
                  Grade another
                </button>
              }
              headerNote={
                <>
                  {saveState === "saved" && (
                    <span className="text-brand-positive">
                      ✓ Saved — it&apos;s in your grading history below.
                    </span>
                  )}
                  {saveState === "saving" && <span className="text-brand-ink5">Saving…</span>}
                  {saveState === "failed" && (
                    <span className="text-[#7A5A12]">
                      Couldn&apos;t save this grade — {saveError}{" "}
                      <button
                        className="font-medium underline"
                        onClick={() =>
                          shown && report && saveGrade(report, value, shown.front.measurement, shown)
                        }
                      >
                        Try again
                      </button>
                    </span>
                  )}
                </>
              }
            />
          ) : (
            <div className="rounded-[18px] border border-brand-line bg-white p-8 text-center">
              <div className="text-3xl">🔎</div>
              <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-[1.6] text-brand-ink3">
                Add a photo of the front and the back, check the corner handles sit on the card,
                then grade it. The report lands here.
              </p>
            </div>
          )}

          {historyError && (
            <div className="rounded-[14px] border border-[#F0DFA8] bg-[#FFF8E1] px-[17px] py-[15px] text-[13px] leading-[1.6] text-[#7A5A12]">
              {historyError}
            </div>
          )}

          {history && history.length > 0 && (
            <div className="overflow-hidden rounded-[18px] border border-brand-line bg-white">
              <div className="px-[22px] pb-1.5 pt-[18px]">
                <div className="font-display text-base font-bold">Grading history</div>
                <div className="mt-0.5 text-xs text-brand-ink5">
                  Tap any card to reopen its full report.
                </div>
              </div>
              {history.map((g) => (
                <button
                  key={g.id}
                  className="flex w-full items-center gap-[13px] border-t border-brand-panel-alt px-[22px] py-[11px] text-left hover:bg-brand-panel-alt"
                  onClick={() => setOpenGrade(g)}
                >
                  <span className="block aspect-[63/88] w-[34px] shrink-0 overflow-hidden rounded bg-brand-sunken">
                    {g.frontUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photoSrc(g.frontUrl)!} alt="" className="h-full w-full object-cover" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {g.cardName ?? "Unidentified card"}
                    </span>
                    <span className="block text-[11.5px] text-brand-ink4">
                      {new Date(g.createdAt).toLocaleDateString()}
                      {g.report?.centering?.estimate ? ` · ${g.report.centering.estimate}` : ""}
                    </span>
                  </span>
                  {g.estimatedGrade != null && (
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 font-display text-[13px] font-bold text-white ${gradeColor(g.estimatedGrade)}`}
                    >
                      {g.estimatedGrade}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {openGrade && (
        <SavedGradeModal
          grade={openGrade}
          onClose={() => setOpenGrade(null)}
          onDelete={() => deleteGrade(openGrade.id)}
          onOutcomeSaved={loadHistory}
        />
      )}
    </>
  );
}
