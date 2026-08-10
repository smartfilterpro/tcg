"use client";

// What a card has been worth lately.
//
// A stat tile, not a chart: the reader's question is "which way is this
// going", which is one number and a shape, and a full axed line chart for a
// 40px-tall answer would be furniture around a single fact.
//
// The series is a STEP function. Migration 062 records a day only when the
// price actually moved, so a card that held £4.20 for six weeks is two
// points six weeks apart — and joining them with a diagonal would draw a
// slow slide that never happened. Every segment therefore goes across, then
// up: flat until the day it changed.

import { useEffect, useState } from "react";

interface Point {
  date: string;
  price: number;
}

const W = 132;
const H = 34;
const PAD = 3; // room for the 2px stroke and the end dot to sit inside the box

/** Turn the series into a step path in SVG user units. */
function stepPath(points: Point[]): string {
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  // A dead-flat series would divide by zero; draw it down the middle.
  const span = hi - lo || 1;
  const first = new Date(points[0].date).getTime();
  const last = new Date(points[points.length - 1].date).getTime();
  const days = last - first || 1;

  const x = (p: Point) => PAD + ((new Date(p.date).getTime() - first) / days) * (W - PAD * 2);
  const y = (p: Point) => H - PAD - ((p.price - lo) / span) * (H - PAD * 2);

  let d = `M ${x(points[0])} ${y(points[0])}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H ${x(points[i])} V ${y(points[i])}`;
  }
  return d;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function PriceHistory({ cardId }: { cardId: string }) {
  const [points, setPoints] = useState<Point[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/cards/${encodeURIComponent(cardId)}/price-history`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && setPoints(j?.points ?? []))
      .catch(() => live && setPoints([]));
    return () => {
      live = false;
    };
  }, [cardId]);

  // One point is a price, not a history. Nothing to say yet, so say nothing
  // rather than draw a dot and call it a trend.
  if (!points || points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const change = last.price - first.price;
  const pct = first.price > 0 ? (change / first.price) * 100 : 0;
  const flat = Math.abs(change) < 0.005;
  const days = Math.max(
    1,
    Math.round((new Date(last.date).getTime() - new Date(first.date).getTime()) / 86_400_000)
  );

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-500">Price history</div>
          <div className="mt-0.5 text-sm">
            {/* The arrow carries the direction as well as the colour does —
                a red number and a green number are the same number to a lot
                of people. */}
            <span
              className={
                flat
                  ? "text-slate-500"
                  : change > 0
                    ? "font-semibold text-brand-positive"
                    : "font-semibold text-brand-negative"
              }
            >
              {flat ? "No change" : `${change > 0 ? "▲" : "▼"} ${money(Math.abs(change))}`}
              {!flat && first.price > 0 && (
                <span className="font-normal"> ({pct > 0 ? "+" : "−"}{Math.abs(pct).toFixed(0)}%)</span>
              )}
            </span>{" "}
            <span className="text-slate-400">over {days === 1 ? "a day" : `${days} days`}</span>
          </div>
        </div>

        {/* De-emphasised line, current value picked out — the shape is
            context for the number beside it, not the other way round. */}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          className="shrink-0 overflow-visible"
          role="img"
          aria-label={`${money(first.price)} on ${first.date}, ${money(last.price)} on ${last.date}`}
        >
          <title>
            {points.map((p) => `${p.date}: ${money(p.price)}`).join(" · ")}
          </title>
          <path
            d={stepPath(points)}
            fill="none"
            stroke="#D8D4CB"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            cx={W - PAD}
            cy={
              (() => {
                const prices = points.map((p) => p.price);
                const lo = Math.min(...prices);
                const span = Math.max(...prices) - lo || 1;
                return H - PAD - ((last.price - lo) / span) * (H - PAD * 2);
              })()
            }
            r={3}
            fill={flat ? "#5A5C63" : change > 0 ? "#1F7A43" : "#D8452F"}
          />
        </svg>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-slate-400">
        Recorded when the market price changes, so a flat stretch is one
        point — not a gap in the data.
      </p>
    </div>
  );
}
