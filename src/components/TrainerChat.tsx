"use client";

// The TrainerAI chat, present on every signed-in page.
//
// A launcher pinned bottom-right and a panel above it. It deliberately does
// NOT take over the screen on desktop: most questions are asked *about*
// something on the page — this deck, that card — so covering the page would
// mean answering from memory.

import { useCallback, useEffect, useRef, useState } from "react";
import { AI_NAME } from "@/lib/branding";
import { FanMark } from "@/components/Logo";
import Markdown from "@/components/Markdown";
import { OutOfCreditsNote } from "@/components/CreditLock";
import { useCredits } from "@/components/useCredits";

interface Msg {
  id?: string;
  role: "user" | "assistant";
  content: string;
  refused?: boolean;
  pending?: boolean;
}

const STARTERS = [
  "What should I add to my best deck?",
  "What's the most valuable card I own?",
  "How does a Rare Candy work?",
  "Is anything I own worth grading?",
];

export default function TrainerChat() {
  const credits = useCredits();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant");
      const json = await res.json();
      if (res.ok) {
        setMigrated(json.migrated !== false);
        setMsgs(json.messages ?? []);
      }
    } catch {}
    setLoaded(true);
  }, []);

  // History is fetched when the panel is first opened, not on every page
  // load — this component mounts on every screen in the app.
  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open, busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setDraft("");
    setError(null);
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: question }]);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "The chat failed");
      setMsgs((m) => [...m, { role: "assistant", content: json.answer, refused: json.refused }]);
      // Re-read the balance: this is the one surface someone uses repeatedly
      // in a sitting, so it's where the lock has to appear on time rather
      // than at the next page load.
      credits.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The chat failed");
      // Put the question back so it isn't lost to a failed send.
      setMsgs((m) => m.slice(0, -1));
      setDraft(question);
    }
    setBusy(false);
  }

  async function clearHistory() {
    if (!confirm(`Forget this conversation? ${AI_NAME} won't remember what you've discussed.`)) {
      return;
    }
    await fetch("/api/assistant", { method: "DELETE" });
    setMsgs([]);
  }

  return (
    <>
      {/* launcher */}
      <button
        aria-label={open ? `Close ${AI_NAME}` : `Ask ${AI_NAME}`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setTimeout(() => inputRef.current?.focus(), 80);
        }}
        className={`fixed bottom-4 right-4 z-40 flex h-[52px] items-center gap-2.5 rounded-full px-4 text-brand-canvas shadow-lg transition-transform hover:scale-105 sm:bottom-6 sm:right-6 ${
          open ? "bg-brand-ink2" : "bg-brand-ink"
        }`}
      >
        {open ? (
          <span className="px-1 text-lg leading-none">✕</span>
        ) : (
          <>
            <FanMark size={22} reversed />
            <span className="hidden text-[13.5px] font-medium sm:inline">Ask {AI_NAME}</span>
          </>
        )}
      </button>

      {/* Wider on a big screen than the 30rem it used to be fixed at. A
          deckbuilding answer is a page of structure, and a phone-width column
          on a 27" monitor makes it four screens of scrolling. */}
      {open && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 flex max-h-[86vh] flex-col rounded-t-[20px] border border-brand-line bg-brand-canvas shadow-2xl sm:inset-x-auto sm:bottom-24 sm:right-6 sm:max-h-[min(720px,80vh)] sm:w-[min(32rem,calc(100vw-3rem))] sm:rounded-[20px] lg:max-h-[min(820px,82vh)] lg:w-[38rem]"
          role="dialog"
          aria-label={`${AI_NAME} chat`}
        >
          <div className="flex items-center gap-2.5 border-b border-brand-line px-4 py-3">
            <FanMark size={20} />
            <div className="min-w-0 flex-1">
              <div className="font-display text-[15px] font-bold leading-tight">{AI_NAME}</div>
              <div className="text-[11.5px] text-brand-ink4">
                Knows your cards and decks
              </div>
            </div>
            {msgs.length > 0 && (
              <button
                className="shrink-0 text-[11.5px] text-brand-ink5 hover:text-brand-ink hover:underline"
                onClick={clearHistory}
              >
                Clear
              </button>
            )}
            <button
              aria-label="Close"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-brand-ink4 hover:bg-brand-sunken sm:hidden"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {!migrated && (
              <div className="rounded-[14px] border border-[#F0DFA8] bg-[#FFF8E1] px-3.5 py-3 text-[12.5px] leading-[1.55] text-[#7A5A12]">
                The chat needs a one-time database update — ask the admin to run{" "}
                <code className="font-mono">supabase/migrations/029_assistant_chat.sql</code>.
              </div>
            )}

            {migrated && msgs.length === 0 && (
              <div className="py-2">
                <p className="mb-3 text-[13.5px] leading-[1.6] text-brand-ink3">
                  Ask me anything about Pokémon — the cards, the rules, your decks, what&apos;s
                  worth grading. I can see your collection, so &ldquo;what should I put in
                  this deck&rdquo; is a fair question.
                </p>
                <div className="flex flex-col gap-1.5">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      className="rounded-[12px] border border-brand-line bg-white px-3 py-2 text-left text-[13px] hover:border-brand-line-strong"
                      onClick={() => send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2.5">
              {msgs.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={m.id ?? i}
                    className="ml-auto max-w-[88%] whitespace-pre-wrap rounded-[14px] bg-brand-ink px-3.5 py-2.5 text-[13.5px] leading-[1.55] text-brand-canvas"
                  >
                    {m.content}
                  </div>
                ) : (
                  // Answers get the full width of the panel. They're
                  // structured — headings, buy-lists, sometimes a table — and
                  // an 88% column threw away a tenth of an already narrow
                  // measure for the sake of a chat-bubble silhouette.
                  <div
                    key={m.id ?? i}
                    className={`rounded-[14px] px-3.5 py-3 text-[13.5px] leading-[1.6] ${
                      m.refused
                        ? "max-w-[88%] bg-brand-sunken text-brand-ink3"
                        : "bg-white text-brand-ink2 ring-1 ring-brand-line"
                    }`}
                  >
                    <Markdown text={m.content} />
                  </div>
                )
              )}
              {busy && (
                <div className="flex items-center gap-2 rounded-[14px] bg-white px-3.5 py-2.5 ring-1 ring-brand-line">
                  <FanMark size={15} className="animate-spin-slow shrink-0" />
                  <span className="animate-pulse text-[13px] text-brand-ink4">Thinking…</span>
                </div>
              )}
              <div ref={endRef} />
            </div>

            {error && <p className="mt-2 text-[12.5px] text-brand-negative">{error}</p>}
          </div>

          {/* Out of credits: the composer is replaced rather than left to
              fail on send. Shown to paid plans on the same terms — a Pro who
              has spent the month's allowance is in exactly this position,
              and hiding that until they press send would be worse. */}
          {credits.empty ? (
            <div className="border-t border-brand-line px-4 py-3">
              <OutOfCreditsNote plan={credits.credits?.plan} />
            </div>
          ) : (
          <form
            className="flex items-end gap-2 border-t border-brand-line px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              ref={inputRef}
              rows={1}
              maxLength={2000}
              className="max-h-28 min-h-[38px] flex-1 resize-none rounded-[14px] border border-brand-line-strong bg-white px-3 py-2 text-[13.5px] outline-none focus:border-brand-accent"
              placeholder={`Ask about Pokémon…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — the convention
                // for a chat box rather than a form field.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            <button
              aria-label="Send"
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-brand-ink text-brand-canvas disabled:opacity-40"
              disabled={busy || !draft.trim()}
            >
              ↑
            </button>
          </form>
          )}
        </div>
      )}
    </>
  );
}
