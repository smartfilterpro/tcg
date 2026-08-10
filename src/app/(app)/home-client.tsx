"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import CardPickerModal from "@/components/CardPickerModal";
import CardText, { useCardText } from "@/components/CardText";
import CardZoom from "@/components/CardZoom";
import CreditsMeter, { BulkScanNudge } from "@/components/CreditsMeter";
import { uploadCardPhoto } from "@/lib/photos";
import { artSrc } from "@/lib/art";
import SealedTab from "@/components/SealedTab";
import { matchesSearch } from "@/lib/text";
import { matchesPrintedNumber } from "@/lib/cardQuery";

import {
  availableVariants,
  canonicalRarity,
  defaultVariantFor,
  itemPrice,
  variantPrice,
  variantLabel,
  manualVariantsFor,
  PATTERN_VARIANTS,
  type CardSummary,
  type CollectionItem,
} from "@/lib/types";

type SortKey = "newest" | "name" | "price" | "set";

export default function CollectionPage({
  isAdmin = false,
}: {
  /** Accepted and unread: the page no longer varies by plan now that export
   *  is for everyone. Kept in the signature so the server component that
   *  renders this doesn't have to change, and so re-gating something later
   *  is a one-line decision rather than a plumbing job. */
  plan?: string;
  isAdmin?: boolean;
}) {
  // EXPORT IS FOR EVERYONE.
  //
  // It was Pro-only, which was never a security boundary — the file is built
  // in the browser from data the page already holds, and anyone who wanted
  // the same rows could read them from /api/collection. So it defended no
  // revenue; it just made the door out narrower.
  //
  // And it made the privacy policy untrue. That page tells people the way to
  // get a copy of their data is to export the collection from this page,
  // which was a promise a free account couldn't keep — at exactly the moment
  // somebody cancelling most wants to take their cards with them. "You can
  // leave with your data" is worth more as a promise than as an upsell.
  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whose cards are on screen. Null means yours.
  //
  // A family plan is one household, so "show me hers" should be the same
  // page with the same search, the same filters and the same card reader —
  // not a cut-down list somewhere else. Everything that WRITES is gated on
  // `readOnly` below; the browsing half is shared wholesale, which is the
  // entire point.
  const [member, setMember] = useState<{ id: string; name: string } | null>(null);
  const [household, setHousehold] = useState<Array<{ id: string; name: string }>>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [amParent, setAmParent] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [setFilter, setSetFilter] = useState("");
  const [rarityFilter, setRarityFilter] = useState("");
  const [supertypeFilter, setSupertypeFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [selected, setSelected] = useState<CollectionItem | null>(null);
  /** The picture being looked at full-screen, if any. */
  const [zoom, setZoom] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [changingCard, setChangingCard] = useState(false);
  const [addVariant, setAddVariant] = useState("auto");
  const [variantFilter, setVariantFilter] = useState("");
  /** Show only the cards nothing has priced yet. Driven from the count in
   *  the header rather than the filter row, because it is that number the
   *  question is always about. */
  const [unpricedOnly, setUnpricedOnly] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const [valueDraft, setValueDraft] = useState("");
  const [valueSaved, setValueSaved] = useState(false);
  const [cardRefreshing, setCardRefreshing] = useState(false);
  // Cards and sealed product are different things with different rules, so
  // they get different tabs rather than one blended list. Sealed lives in
  // its own tables and never reaches anything card-shaped.
  const [tab, setTab] = useState<"cards" | "sealed">("cards");
  // What the sealed side is worth, so the Cards tab can answer "what is the
  // whole collection worth?" without making anyone add two numbers up.
  const [sealedValue, setSealedValue] = useState<number | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  /** Re-fetch one card's price and picture on demand.
   *
   *  The background jobs reach every card eventually, but "wait until
   *  tonight" is a poor answer to a card that just came out of a scan with
   *  no value on it. Updates the row in place so the collection total and
   *  the card both move without a reload. */
  async function refreshCardData(item: CollectionItem) {
    if (cardRefreshing) return;
    setCardRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(item.card.id)}/refresh`, {
        method: "POST",
      });
      const json = await res.json();
      // `message` first. The server's explanation of what happened is
      // always more useful than the generic word this used to fall back
      // to, and it is present on failures as well as successes.
      if (!res.ok) throw new Error(json.message || json.error || "Refresh failed");
      setRefreshNote(json.message ?? json.error ?? "Refreshed.");
      // Merge the row even when the outcome was bad — it is the card's
      // real current state either way, and showing stale data next to an
      // error message is how the last confusion started.
      if (json.card) {
        const card = json.card as CollectionItem["card"];
        setItems((prev) =>
          prev?.map((i) => (i.card.id === card.id ? { ...i, card: { ...i.card, ...card } } : i)) ?? null
        );
        setSelected((sel) =>
          sel && sel.card.id === card.id ? { ...sel, card: { ...sel.card, ...card } } : sel
        );
      }
    } catch (e) {
      setRefreshNote(e instanceof Error ? e.message : "Refresh failed");
    }
    setCardRefreshing(false);
  }
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cards whose image URL failed to load (broken fallback-database links) —
  // treated exactly like having no image, so the photo button appears.
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const detailPhotoRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [findBusy, setFindBusy] = useState(false);

  function markBroken(cardId: string) {
    setBrokenImages((prev) => new Set(prev).add(cardId));
  }

  function hasImage(item: CollectionItem) {
    return !!item.card.image_small && !brokenImages.has(item.card.id);
  }

  function applyCardImage(cardId: string, url: string) {
    const patchCard = (i: CollectionItem) =>
      i.card_id === cardId
        ? { ...i, card: { ...i.card, image_small: url, image_large: url } }
        : i;
    setItems((prev) => prev?.map(patchCard) ?? null);
    setSelected((s) => (s && s.card_id === cardId ? patchCard(s) : s));
    setBrokenImages((prev) => {
      const next = new Set(prev);
      next.delete(cardId);
      return next;
    });
  }

  async function setCardPhoto(item: CollectionItem, file: File) {
    setPhotoBusy(true);
    try {
      const url = await uploadCardPhoto(file);
      if (!url) {
        alert("Photo upload failed — has the card-photos storage migration (005) been run?");
        return;
      }
      const res = await fetch(`/api/cards/${encodeURIComponent(item.card_id)}/image`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: url }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        alert(json.error ?? "Couldn't save the photo");
        return;
      }
      applyCardImage(item.card_id, url);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function findImageOnline(item: CollectionItem) {
    setFindBusy(true);
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(item.card_id)}/find-image`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(json.error ?? "Couldn't find an image online — try your own photo.");
        return;
      }
      applyCardImage(item.card_id, json.imageUrl as string);
    } finally {
      setFindBusy(false);
    }
  }

  /** Hand copies of a card to someone else in the household. */
  async function moveCard(item: CollectionItem, toUserId: string, quantity: number) {
    setMoving(toUserId);
    setError(null);
    try {
      const res = await fetch("/api/family/collection/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, toUserId, quantity }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't move that card.");
      // Close the sheet when the last copy leaves — it would be describing a
      // row that no longer exists.
      if (json.left <= 0) setSelected(null);
      else setSelected((s) => (s?.id === item.id ? { ...s, quantity: json.left } : s));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move that card.");
    }
    setMoving(null);
  }

  async function load() {
    try {
      const res = await fetch(
        member ? `/api/family/collection/${member.id}` : "/api/collection"
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setItems(json.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load collection");
    }
  }

  // Sealed totals, read once. Its own request rather than folded into the
  // collection response: the two are separate tables on purpose, and a
  // member with no sealed product should not pay for a join that answers
  // zero. Silent on failure — a missing grand total is a smaller problem
  // than an error banner over a collection that loaded fine.
  useEffect(() => {
    let live = true;
    fetch("/api/sealed")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j?.items) return;
        const value = (j.items as Array<{ quantity: number; price_override: number | null; product?: { market_price?: number | null } | null }>).reduce(
          (sum, i) => sum + ((i.price_override ?? i.product?.market_price ?? 0) || 0) * i.quantity,
          0
        );
        setSealedValue(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setItems(null);
    setSelected(null);
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member]);

  // Who else is in the house, if anyone. Silent on failure and on a solo
  // account: no family means no switcher, and the page looks exactly as it
  // always did.
  useEffect(() => {
    let live = true;
    fetch("/api/family")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live || !j?.group) return;
        setMeId(j.group.meId);
        setAmParent(j.group.myRole === "parent");
        setHousehold(
          (j.group.members ?? [])
            .filter((m: { userId: string }) => m.userId !== j.group.meId)
            .map((m: { userId: string; name: string }) => ({ id: m.userId, name: m.name }))
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const facets = useMemo(() => {
    // Keyed by set NAME, not id: the same set can exist under two ids when
    // cards came from different databases (pokemontcg.io vs TCGdex), which
    // showed as duplicate entries in the dropdown.
    const sets = new Set<string>();
    const types = new Set<string>();
    const rarities = new Set<string>();
    const supertypes = new Set<string>();
    const variants = new Set<string>();
    for (const item of items ?? []) {
      const c = item.card;
      if (!c) continue;
      if (c.set_name) sets.add(c.set_name);
      for (const t of c.types ?? []) types.add(t);
      // Canonicalised, not raw: cards saved before rarities were normalised
      // still carry the other database's capitalisation, and listing both
      // showed the same rarity twice with the cards split between them.
      const rarity = canonicalRarity(c.rarity);
      if (rarity) rarities.add(rarity);
      if (c.supertype) supertypes.add(c.supertype);
      variants.add(item.variant ?? "normal");
    }
    return {
      sets: [...sets].sort((a, b) => a.localeCompare(b)),
      types: [...types].sort(),
      rarities: [...rarities].sort(),
      supertypes: [...supertypes].sort(),
      variants: [...variants].sort(),
    };
  }, [items]);

  const filtered = useMemo(() => {
    let list = (items ?? []).filter((i) => i.card);
    // Punctuation/accent/space-blind matching — OCR'd or imported names can
    // carry odd characters that a strict substring match misses.
    const q = search.trim();
    if (q) {
      // …plus the number exactly as it is PRINTED on the card. "73/86" is
      // what somebody reads off the card in their hand, and the token match
      // can never find it: the number column holds "73" and the set size
      // lives in another column, so the one string that identifies the card
      // uniquely was the one string that returned nothing. An OR, so
      // everything that finds a card today still does.
      list = list.filter(
        (i) =>
          matchesSearch(q, i.card.name, i.card.set_name, i.card.number) ||
          matchesPrintedNumber(q, {
            name: i.card.name,
            number: i.card.number,
            printedTotal: i.card.set_printed_total,
          })
      );
    }
    if (typeFilter) list = list.filter((i) => (i.card.types ?? []).includes(typeFilter));
    if (setFilter) list = list.filter((i) => i.card.set_name === setFilter);
    if (rarityFilter) list = list.filter((i) => canonicalRarity(i.card.rarity) === rarityFilter);
    if (supertypeFilter) list = list.filter((i) => i.card.supertype === supertypeFilter);
    if (variantFilter) list = list.filter((i) => (i.variant ?? "normal") === variantFilter);
    if (unpricedOnly) list = list.filter((i) => itemPrice(i) == null);
    switch (sort) {
      case "name":
        list = [...list].sort((a, b) => a.card.name.localeCompare(b.card.name));
        break;
      case "price":
        list = [...list].sort((a, b) => (itemPrice(b) ?? 0) - (itemPrice(a) ?? 0));
        break;
      case "set":
        list = [...list].sort(
          (a, b) =>
            a.card.set_name.localeCompare(b.card.set_name) ||
            (parseInt(a.card.number) || 0) - (parseInt(b.card.number) || 0)
        );
        break;
    }
    return list;
  }, [items, search, typeFilter, setFilter, rarityFilter, supertypeFilter, variantFilter, unpricedOnly, sort]);

  /** One tile per card, not per finish.
   *
   *  A card owned as normal, holo and reverse holo is three collection rows
   *  — that's the right storage, since each finish has its own price, notes
   *  and count — but it made the same card appear three times in the list.
   *  The finishes are kept on the group so the detail view can break them
   *  down; only the grid collapses them. */
  const grouped = useMemo(() => {
    const byCard = new Map<string, { card: CollectionItem["card"]; items: CollectionItem[] }>();
    for (const i of filtered) {
      const g = byCard.get(i.card.id);
      if (g) g.items.push(i);
      else byCard.set(i.card.id, { card: i.card, items: [i] });
    }
    return [...byCard.values()].map((g) => {
      // Biggest stack first: it's the copy the detail view opens on, and the
      // one the owner most likely means.
      const sorted = [...g.items].sort((a, b) => b.quantity - a.quantity);
      const prices = sorted.map((i) => itemPrice(i)).filter((p): p is number => p != null);
      return {
        card: g.card,
        items: sorted,
        quantity: sorted.reduce((s, i) => s + i.quantity, 0),
        minPrice: prices.length > 0 ? Math.min(...prices) : null,
        maxPrice: prices.length > 0 ? Math.max(...prices) : null,
        overridden: sorted.some((i) => i.price_override != null),
      };
    });
  }, [filtered]);

  /** Every finish of the open card, for the breakdown in the detail view. */
  /** A collection row's price, and whether it is really THAT finish's.
   *
   *  A member's own override is exact by definition — they typed it for this
   *  row. Otherwise it is the catalogue's per-finish figure when there is
   *  one, and the card's headline price when there isn't. */
  const finishPrice = (item: CollectionItem): { value: number | null; exact: boolean } => {
    if (item.price_override != null) return { value: item.price_override, exact: true };
    return variantPrice(item.card, item.variant ?? "normal");
  };

  // The open card's printed text. Fetched by the hook when `selected`
  // changes and skipped entirely while the panel is closed, so browsing a
  // collection costs nothing extra.
  const cardText = useCardText(selected?.card.id);

  const selectedFinishes = useMemo(() => {
    if (!selected) return [];
    return (items ?? [])
      .filter((i) => i.card && i.card.id === selected.card.id)
      .sort((a, b) => b.quantity - a.quantity);
  }, [items, selected]);

  const totals = useMemo(() => {
    const all = (items ?? []).filter((i) => i.card);
    return {
      cards: all.reduce((s, i) => s + i.quantity, 0),
      unique: all.length,
      value: all.reduce((s, i) => s + (itemPrice(i) ?? 0) * i.quantity, 0),
      // Cards contributing $0 because nothing has priced them yet. Without
      // this the total silently understates a collection and looks wrong to
      // the one person who knows what their cards are worth.
      unpriced: all.filter((i) => itemPrice(i) == null).reduce((s, i) => s + i.quantity, 0),
    };
  }, [items]);

  async function updateQuantity(item: CollectionItem, quantity: number) {
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
    if (res.ok) {
      setItems(
        (prev) =>
          prev
            ?.map((i) => (i.id === item.id ? { ...i, quantity } : i))
            .filter((i) => i.quantity > 0) ?? null
      );
      if (quantity === 0) setSelected(null);
      else setSelected((s) => (s?.id === item.id ? { ...s, quantity } : s));
    }
  }

  async function changeCard(item: CollectionItem, card: CardSummary) {
    setError(null);
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Couldn't change the card");
      setChangingCard(false);
      return;
    }
    setChangingCard(false);
    setSelected(null);
    await load(); // re-fetch so the row shows the new card's data
  }

  async function addCard(card: CardSummary) {
    const variant = addVariant === "auto" ? defaultVariantFor(card) : addVariant;
    const res = await fetch("/api/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ card, quantity: 1, variant }] }),
    });
    if (res.ok) {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast(`Added ${card.name} (${variantLabel(variant)}) ×1 — click again for another copy`);
      toastTimer.current = setTimeout(() => setToast(null), 2500);
    } else {
      const json = await res.json().catch(() => ({}));
      setToast(`Couldn't add: ${json.error ?? "unknown error"}`);
    }
  }

  async function changeVariant(item: CollectionItem, variant: string) {
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(json.error ?? "Couldn't change finish");
      return;
    }
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, variant } : i)) ?? null);
    setSelected((s) => (s?.id === item.id ? { ...s, variant } : s));
  }

  async function saveNotes(item: CollectionItem) {
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notesDraft }),
    });
    if (res.ok) {
      setItems(
        (prev) =>
          prev?.map((i) => (i.id === item.id ? { ...i, notes: notesDraft || null } : i)) ?? null
      );
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    }
  }

  /** Download what's currently shown as a spreadsheet.
   *
   *  One row per finish, not per card: a spreadsheet is where you'd want the
   *  finishes separable — different prices, different counts — and anyone who
   *  wants them combined can pivot. The grid collapses them; the file
   *  doesn't. Follows the filters, so "what you see is what you get". */
  function exportCsv() {
    const cell = (v: string | number | null | undefined) => {
      const s = v == null ? "" : String(v);
      // Excel reads a leading =, +, - or @ as a formula. Prefixing an
      // apostrophe keeps a card named "-Blastoise" as text.
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const header = [
      "Name", "Set", "Number", "Rarity", "Supertype", "Types",
      "Finish", "Quantity", "Unit value USD", "Total value USD", "Custom value", "Notes", "Card ID",
    ];
    const rows = filtered.map((i) => {
      const unit = itemPrice(i);
      return [
        i.card.name,
        i.card.set_name,
        i.card.number,
        i.card.rarity ?? "",
        i.card.supertype ?? "",
        (i.card.types ?? []).join(" / "),
        variantLabel(i.variant ?? "normal"),
        i.quantity,
        unit != null ? unit.toFixed(2) : "",
        unit != null ? (unit * i.quantity).toFixed(2) : "",
        i.price_override != null ? "yes" : "",
        i.notes ?? "",
        i.card.id,
      ].map(cell).join(",");
    });
    // The BOM is what makes Excel open a UTF-8 CSV without mangling the é
    // in Pokémon and every accented card name.
    const csv = "\uFEFF" + [header.map(cell).join(","), ...rows].join("\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `trainerdeck-collection-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openDetail(item: CollectionItem) {
    setSelected(item);
    setNotesDraft(item.notes ?? "");
    setNotesSaved(false);
    setValueDraft(item.price_override != null ? String(item.price_override) : "");
    setValueSaved(false);
    // A message about the last card must not follow you to the next one.
    setRefreshNote(null);
  }

  async function saveValue(item: CollectionItem) {
    const trimmed = valueDraft.trim();
    const parsed = trimmed === "" ? null : parseFloat(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return;
    const res = await fetch(`/api/collection/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceOverride: parsed }),
    });
    if (res.ok) {
      setItems(
        (prev) =>
          prev?.map((i) => (i.id === item.id ? { ...i, price_override: parsed } : i)) ?? null
      );
      setSelected((s) => (s?.id === item.id ? { ...s, price_override: parsed } : s));
      setValueSaved(true);
      setTimeout(() => setValueSaved(false), 2000);
    }
  }

  function closeAdd() {
    setShowAdd(false);
    setToast(null);
    load(); // pull in whatever was added
  }

  async function refreshPrices() {
    setRefreshing(true);
    try {
      await fetch("/api/collection/refresh-prices", { method: "POST" });
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  /** Someone else's cards: look, don't touch. Every write below checks this,
   *  and so does the server — the collection_items write policies are still
   *  user_id = auth.uid(), so a slip here fails at the database too. */
  const readOnly = member !== null;

  /** The one thing you may do to a family member's collection: give them a
   *  card, or take one of yours back. Parents can move anyone's, which is
   *  the same authority they already have over caps and the trade board;
   *  everyone else can only move their own. */
  const canMoveFrom = (owner: string | null) => !readOnly || amParent || owner === meId;

  /** Whose cards to show. Only rendered for a household — a solo account
   *  sees the page exactly as it always was. */
  const householdSwitcher = household.length > 0 && (
    <div className="mb-3.5 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-500">Whose cards:</span>
      {[{ id: null as string | null, name: "Mine" }, ...household].map((who) => {
        const active = (member?.id ?? null) === who.id;
        return (
          <button
            key={who.id ?? "me"}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              active
                ? "border-brand-accent bg-brand-accent text-white"
                : "border-brand-line-strong text-brand-ink2 hover:border-brand-accent"
            }`}
            onClick={() => setMember(who.id ? { id: who.id, name: who.name } : null)}
          >
            {who.name}
          </button>
        );
      })}
    </div>
  );

  // Sealed product is per-account and there's no family view of it, so the
  // tab would show YOUR boxes under someone else's name.
  const tabs = (
    <div className="mb-4 flex gap-1 border-b border-slate-200">
      {(readOnly ? (["cards"] as const) : (["cards", "sealed"] as const)).map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold capitalize ${
            tab === t
              ? "border-brand-accent text-brand-accent"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
        >
          {t === "cards" ? "Cards" : "Sealed product"}
        </button>
      ))}
    </div>
  );

  if (error) return <p className="text-red-600">{error}</p>;
  if (!items)
    return (
      <p className="text-slate-500">
        Loading {member ? `${member.name}'s collection` : "your collection"}…
      </p>
    );

  // The sealed tab has to be reachable from the empty state too — somebody
  // whose first purchase was a booster box has an empty CARD collection and
  // would otherwise never see the tab that holds their box.
  if (tab === "sealed") {
    return (
      <div>
        {tabs}
        {/* The card value is handed down rather than re-fetched: this page
            already has it, and the sealed tab asking for 3,500 collection
            rows to print one number would be absurd. */}
        <SealedTab cardValue={totals.value} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div>
        {tabs}
      {householdSwitcher}
      <div className="card-panel mx-auto mt-12 max-w-md p-8 text-center">
        <div className="text-4xl">📷</div>
        <h1 className="mt-2 text-xl font-bold">
          {member ? `${member.name} hasn't added any cards yet` : "Your collection is empty"}
        </h1>
        {!readOnly && (
          <>
            <p className="mt-1 text-sm text-slate-500">
              Scan your first cards, or add them by searching the card database.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Link href="/scan" className="btn-primary">
                Scan cards
              </Link>
              <button className="btn-secondary" onClick={() => setShowAdd(true)}>
                + Add by search
              </button>
            </div>
          </>
        )}
        {showAdd && (
          <CardPickerModal
            initialQuery=""
            candidates={[]}
            onClose={closeAdd}
            onPick={addCard}
            toast={toast}
            headerExtra={
              <select
                className="input w-auto shrink-0"
                value={addVariant}
                onChange={(e) => setAddVariant(e.target.value)}
                title="Finish to add cards as"
              >
                <option value="auto">Finish: Auto</option>
                <option value="normal">Normal</option>
                <option value="holofoil">Holo</option>
                <option value="reverseHolofoil">Reverse Holo</option>
                <optgroup label="Stamped versions">
                  <option value="pcStamp">Pokémon Center Stamp</option>
                  <option value="prereleaseStamp">Prerelease Stamp</option>
                  <option value="staffStamp">Staff Stamp</option>
                </optgroup>
                {/* Ball-pattern reverse holos. The card databases hold ONE
                    entry for the whole family because the collector number
                    is the same on all of them, so a search returns a single
                    result for what TCGplayer splits into several products.
                    Which one you are holding is a thing only you can see. */}
                <optgroup label="Ball-pattern reverse holo">
                  {PATTERN_VARIANTS.map((v) => (
                    <option key={v} value={v}>
                      {variantLabel(v)}
                    </option>
                  ))}
                </optgroup>
              </select>
            }
          />
        )}
      </div>
      </div>
    );
  }

  return (
    <div>
      {tabs}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-bold tracking-[-.025em]">
            {member ? `${member.name}'s Collection` : "My Collection"}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {totals.cards.toLocaleString()} cards · {totals.unique.toLocaleString()} unique ·{" "}
            <span className="font-bold text-brand-positive">
              ~${totals.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} value
            </span>
            {totals.unpriced > 0 && (
              <>
                {" · "}
                {/* A bare count invites the obvious question — WHICH ones? —
                    and a number that goes up rather than down reads as a bug
                    when it is usually a shelf of bulk commons and promos no
                    source prices. So the number is the filter: one tap shows
                    exactly which cards are behind it. */}
                <button
                  type="button"
                  className={`underline decoration-dotted underline-offset-2 ${
                    unpricedOnly ? "font-semibold text-brand-ink2" : "text-slate-400"
                  }`}
                  onClick={() => setUnpricedOnly((v) => !v)}
                  title={
                    unpricedOnly
                      ? "Show the whole collection again"
                      : "Show only the cards with no price"
                  }
                >
                  {totals.unpriced.toLocaleString()} with no price yet
                  {unpricedOnly ? " — showing these" : ""}
                </button>
              </>
            )}
          </p>
          {/* The grand total, on its own line and only when there IS sealed
              product to add. The headline number stays the CARD value —
              "what are my cards worth?" must keep meaning that — and this
              answers the separate question underneath rather than quietly
              changing what the first number counts. */}
          {sealedValue != null && sealedValue > 0 && (
            <p className="mt-0.5 text-sm text-slate-500">
              plus{" "}
              <span className="font-semibold text-brand-positive">
                ~${sealedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>{" "}
              sealed ·{" "}
              <span className="font-bold text-brand-positive">
                ~$
                {(totals.value + sealedValue).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{" "}
                total collection
              </span>
            </p>
          )}
        </div>
        {/* Adding, scanning and refreshing all act on YOUR collection, so
            they'd be lying about what they'd do while someone else's is on
            screen. */}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={refreshPrices} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "↻ Refresh prices"}
            </button>
            <button className="btn-secondary" onClick={() => setShowAdd(true)}>
              + Add by search
            </button>
            <Link href="/scan" className="btn-primary">
              Bulk scan
            </Link>
          </div>
        )}
      </div>

      {householdSwitcher}

      {!readOnly && (
        <>
          <CreditsMeter />
          <BulkScanNudge cards={totals.cards} />
        </>
      )}

      {/* Artboard 02: one wrapping row — search pill, then chip-style selects. */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <input
          className="min-w-[150px] flex-[1_1_180px] rounded-full border border-brand-line-strong bg-white px-4 py-2.5 text-sm outline-none placeholder:text-brand-ink5 focus:border-brand-accent focus:ring-[3px] focus:ring-brand-accent/15"
          type="search"
          placeholder="🔍 Search your cards by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {[
          { value: supertypeFilter, set: setSupertypeFilter, all: "All types", opts: facets.supertypes.map((v) => ({ v, label: v })) },
          { value: typeFilter, set: setTypeFilter, all: "All energy", opts: facets.types.map((v) => ({ v, label: v })) },
          { value: setFilter, set: setSetFilter, all: "All sets", opts: facets.sets.map((v) => ({ v, label: v })) },
          { value: rarityFilter, set: setRarityFilter, all: "All rarities", opts: facets.rarities.map((v) => ({ v, label: v })) },
          { value: variantFilter, set: setVariantFilter, all: "All finishes", opts: facets.variants.map((v) => ({ v, label: variantLabel(v) })) },
        ].map((f) => (
          <select
            key={f.all}
            className={`w-[124px] shrink-0 cursor-pointer truncate rounded-full border bg-white px-3 py-2.5 text-[13px] outline-none ${
              f.value ? "border-brand-accent text-brand-accent" : "border-brand-line-strong text-brand-ink2"
            }`}
            value={f.value}
            onChange={(e) => f.set(e.target.value)}
          >
            <option value="">{f.all}</option>
            {f.opts.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
        ))}
        <select
          className="w-[124px] shrink-0 cursor-pointer truncate rounded-full border border-brand-line-strong bg-white px-3 py-2.5 text-[13px] text-brand-ink2 outline-none"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="newest">Newest first</option>
          <option value="name">Name A–Z</option>
          <option value="price">Highest value</option>
          <option value="set">By set</option>
        </select>
      </div>

      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-400">
        <span>
          {grouped.length} card{grouped.length === 1 ? "" : "s"} shown
          {filtered.length !== grouped.length && ` · ${filtered.length} finishes`}
        </span>
        {filtered.length > 0 && (
          <button className="text-brand-accent hover:underline" onClick={exportCsv}>
            ⬇ Export CSV
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {grouped.map((group) => {
          const item = group.items[0];
          return (
          <button
            key={group.card.id}
            className="group relative overflow-hidden rounded-xl border border-brand-line bg-white p-2 text-left transition-shadow hover:shadow-[0_8px_20px_-14px_rgba(22,23,27,.5)]"
            onClick={() => openDetail(item)}
          >
            {group.quantity > 1 && (
              <span className="absolute right-2 top-2 z-10 rounded-full bg-brand-ink px-[7px] py-0.5 font-mono text-[11px] font-medium text-white">
                ×{group.quantity}
              </span>
            )}
            {group.items.length > 1 ? (
              <span className="absolute left-2 top-2 z-10 rounded-full bg-brand-ink/75 px-2 py-0.5 font-mono text-[10px] text-white">
                {group.items.length} finishes
              </span>
            ) : (
              (item.variant ?? "normal") !== "normal" && (
                <span className="absolute left-2 top-2 z-10 rounded-full bg-brand-ink/75 px-2 py-0.5 font-mono text-[10px] text-white">
                  {variantLabel(item.variant)}
                </span>
              )
            )}
            {hasImage(item) ? (
              // Fixed card aspect ratio — user-taken photos (arbitrary shapes)
              // otherwise distort the grid
              <div className="aspect-[63/88] w-full overflow-hidden rounded-[7px]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={artSrc(item.card.id, item.card.image_small)!}
                  alt={item.card.name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  onError={() => markBroken(item.card.id)}
                />
              </div>
            ) : (
              <div className="flex aspect-[63/88] flex-col items-center justify-center gap-1 rounded-[7px] bg-brand-sunken text-center text-xs text-brand-ink5">
                <span className="text-xl">📷</span>
                No image — tap to add a photo
              </div>
            )}
            <div className="mt-2 truncate text-[13.5px] font-medium">{item.card.name}</div>
            <div className="truncate text-[11.5px] text-brand-ink4">
              {item.card.set_name} · #{item.card.number}
            </div>
            {group.maxPrice != null && (
              <div className="mt-[3px] font-mono text-[11.5px] font-medium text-brand-positive">
                {/* A range when the finishes differ — one number would be
                    wrong for every finish but one. */}
                ${group.minPrice!.toFixed(2)}
                {group.maxPrice !== group.minPrice ? `–$${group.maxPrice.toFixed(2)}` : ""}
                {group.overridden ? "*" : ""}
              </div>
            )}
          </button>
          );
        })}
      </div>

      {/* Detail-modal photo capture for cards without art */}
      <input
        ref={detailPhotoRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && selected) setCardPhoto(selected, f);
        }}
      />

      {showAdd && (
        <CardPickerModal
          initialQuery=""
          candidates={[]}
          onClose={closeAdd}
          onPick={addCard}
          toast={toast}
        />
      )}

      {selected && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="card-panel relative mx-auto my-6 w-full max-w-[min(46rem,94vw)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
            {/* Stacked on phones (image on top), side-by-side from sm up */}
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:pr-6">
              {hasImage(selected) ? (
                // A button, because it does something: the picture at this
                // size is enough to recognise a card and not enough to read
                // one, and "is the copy in my hand this printing?" is asked
                // while holding the card.
                <button
                  type="button"
                  className="flex aspect-[63/88] w-40 shrink-0 cursor-zoom-in items-center justify-center self-center overflow-hidden rounded-lg bg-slate-100 shadow sm:self-start"
                  onClick={() =>
                    setZoom(
                      artSrc(
                        selected.card.id,
                        selected.card.image_large ?? selected.card.image_small,
                        "large"
                      )!
                    )
                  }
                  aria-label={`See ${selected.card.name} larger`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={artSrc(
                      selected.card.id,
                      selected.card.image_large ?? selected.card.image_small,
                      "large"
                    )!}
                    alt={selected.card.name}
                    className="h-full w-full object-contain"
                    onError={() => markBroken(selected.card.id)}
                  />
                </button>
              ) : (
                <div className="flex aspect-[63/88] w-40 flex-col items-center justify-center gap-2 self-center rounded-lg bg-slate-100 p-3 text-center text-xs text-slate-400 sm:self-start">
                  <span className="text-2xl">📷</span>
                  No card art available
                  {/* Pictures come from the pipeline (import, price tracker,
                      art mirror) or the admin — the manual buttons are
                      admin-only now, and the server enforces the same. */}
                  {isAdmin ? (
                    <>
                      <button
                        className="btn-primary px-3 py-1.5 text-xs"
                        disabled={photoBusy || findBusy}
                        onClick={() => findImageOnline(selected)}
                      >
                        {findBusy ? "Searching…" : "🔍 Find image online"}
                      </button>
                      <button
                        className="btn-secondary px-3 py-1.5 text-xs"
                        disabled={photoBusy || findBusy}
                        onClick={() => detailPhotoRef.current?.click()}
                      >
                        {photoBusy ? "Uploading…" : "📷 Use your photo"}
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] leading-snug">
                      The picture arrives automatically as the card database fills in.
                    </span>
                  )}
                </div>
              )}
              <div className="w-full min-w-0 sm:flex-1">
                <h2 className="text-lg font-bold">{selected.card.name}</h2>
                <dl className="mt-2 space-y-1 text-sm text-slate-600">
                  <div>Set: <span className="font-medium">{selected.card.set_name}</span></div>
                  <div>Number: #{selected.card.number}{selected.card.set_printed_total ? `/${selected.card.set_printed_total}` : ""}</div>
                  {selected.card.rarity && <div>Rarity: {selected.card.rarity}</div>}
                  {selected.card.supertype && <div>Card type: {selected.card.supertype}</div>}
                  {(selected.card.types ?? []).length > 0 && (
                    <div>Type: {(selected.card.types ?? []).join(", ")}</div>
                  )}
                  {selected.card.hp && <div>HP: {selected.card.hp}</div>}
                  {selectedFinishes.length > 1 && (
                    <div className="rounded-lg bg-slate-50 p-2">
                      <div className="mb-1 text-[11px] font-semibold text-slate-500">
                        You own {selectedFinishes.reduce((s, i) => s + i.quantity, 0)} copies
                        across {selectedFinishes.length} finishes — tap one to edit it:
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedFinishes.map((f) => {
                          const on = f.id === selected.id;
                          const p = finishPrice(f);
                          return (
                            <button
                              key={f.id}
                              className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                                on
                                  ? "bg-poke-blue text-white"
                                  : "bg-white text-slate-600 hover:bg-slate-100"
                              }`}
                              onClick={() => openDetail(f)}
                              title={
                                p.value == null || p.exact
                                  ? undefined
                                  : "No separate price for this finish yet — showing the card's overall market price."
                              }
                            >
                              {variantLabel(f.variant ?? "normal")} ×{f.quantity}
                              {p.value != null && (
                                <span className={on ? "opacity-80" : "text-slate-400"}>
                                  {" "}
                                  {/* A tilde where the number is the card's
                                      overall price rather than this finish's.
                                      Without it two chips show the identical
                                      figure and it reads as measured — and a
                                      reverse holo can trade at several times
                                      a normal, so that is not a small lie. */}
                                  {p.exact ? "" : "~"}${p.value.toFixed(2)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="shrink-0">Finish:</span>
                    <select
                      className="input min-w-0 flex-1 py-1 text-xs sm:w-auto sm:flex-none"
                      value={selected.variant ?? "normal"}
                      disabled={readOnly}
                      onChange={(e) => changeVariant(selected, e.target.value)}
                    >
                      {[
                        ...new Set([
                          ...availableVariants(selected.card),
                          ...manualVariantsFor(selected.card),
                          selected.variant ?? "normal",
                        ]),
                      ].map((v) => (
                        <option key={v} value={v}>
                          {variantLabel(v)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {itemPrice(selected) != null ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-green-700">
                        {selected.price_override != null
                          ? `Your value (${variantLabel(selected.variant ?? "normal")})`
                          : finishPrice(selected).exact
                            ? `Market (${variantLabel(selected.variant ?? "normal")})`
                            : // Naming the finish here stated a measurement the
                              // app doesn't have: the number is the card's
                              // headline price, shown because it is the best
                              // estimate, not because anyone priced this finish.
                              "Market (all finishes)"}
                        : ${itemPrice(selected)!.toFixed(2)} each
                      </span>
                      {selected.price_override == null && (
                        <button
                          className="text-[11px] text-slate-400 underline hover:text-slate-600"
                          disabled={cardRefreshing}
                          onClick={() => refreshCardData(selected)}
                        >
                          {cardRefreshing ? "Checking…" : "Refresh"}
                        </button>
                      )}
                    </div>
                  ) : (
                    /* A card with no price used to render nothing here at
                       all — no number, no explanation and no way to fix it,
                       which reads as the app being broken rather than as a
                       gap in somebody's database. */
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-slate-500">No market price yet</span>
                      <button
                        className="btn-secondary px-2 py-1 text-xs"
                        disabled={cardRefreshing}
                        onClick={() => refreshCardData(selected)}
                      >
                        {cardRefreshing ? "Checking…" : "Check for a price"}
                      </button>
                    </div>
                  )}
                  {refreshNote && (
                    <p className="m-0 text-[11px] leading-snug text-slate-500">{refreshNote}</p>
                  )}
                  {!readOnly && (
                  <>
                  <div className="flex items-center gap-2 pt-1">
                    <span className="shrink-0 text-xs text-slate-500">Your value $</span>
                    <input
                      className="input w-full min-w-0 flex-1 py-1 text-xs sm:w-24 sm:flex-none"
                      inputMode="decimal"
                      placeholder="auto"
                      value={valueDraft}
                      onChange={(e) => setValueDraft(e.target.value)}
                    />
                    <button
                      className="btn-secondary shrink-0 px-2 py-1 text-xs"
                      onClick={() => saveValue(selected)}
                    >
                      Set
                    </button>
                    {valueSaved && <span className="text-xs text-green-600">✓</span>}
                  </div>
                  <p className="text-[11px] leading-snug text-slate-400">
                    Overrides the market price — use for Pokémon Center stamps, graded cards,
                    etc. Clear the box and Set to go back to market pricing.
                  </p>
                  </>
                  )}
                </dl>
              </div>
            </div>

            {/* WHAT THE CARD DOES.
                The picture is on screen at 160px wide, which on a phone is
                too small to read the attack text off — and this is the one
                screen where somebody is looking straight at a single card
                and asking exactly that. The text is already on the card row
                and already served, so showing it here costs a lookup the
                deck viewer has been making for months. */}
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="mb-2 text-xs font-semibold text-slate-500">What this card does</div>
              <CardText
                detail={cardText.detail}
                loading={cardText.loading}
                onRetry={cardText.retry}
                missingNote="No printed text on file for this card yet — it fills in automatically as the card databases are read."
              />
            </div>

            {/* Give it to someone in the house. Deleting from one collection
                and searching it back into another loses the finish, the
                notes and the custom value — and leaves a child with no
                record that the card was ever theirs. */}
            {household.length > 0 && canMoveFrom(selected.user_id) && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <label className="text-xs font-semibold text-slate-500">
                  Move to someone in your family
                </label>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {(member
                    ? [
                        { id: meId!, name: "me" },
                        ...household.filter((h) => h.id !== member.id),
                      ]
                    : household
                  ).map((who) => (
                    <button
                      key={who.id}
                      className="btn-secondary px-2.5 py-1 text-xs"
                      disabled={moving === who.id}
                      onClick={() => moveCard(selected, who.id, 1)}
                    >
                      {moving === who.id ? "Moving…" : `→ ${who.name}`}
                    </button>
                  ))}
                  {selected.quantity > 1 && (
                    <span className="text-[11px] text-slate-400">
                      one at a time — you have {selected.quantity}
                    </span>
                  )}
                </div>
              </div>
            )}

            {!readOnly && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <label className="text-xs font-semibold text-slate-500">
                Notes (e.g. “Pokémon Center stamp”, “graded PSA 9”)
              </label>
              <textarea
                className="input mt-1 min-h-16 text-sm"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder="Anything special about your copy…"
              />
              <div className="mt-1 flex items-center gap-2">
                <button className="btn-secondary text-xs" onClick={() => saveNotes(selected)}>
                  Save notes
                </button>
                {notesSaved && <span className="text-xs text-green-600">Saved ✓</span>}
              </div>
            </div>
            )}
            {readOnly && selected.notes && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <div className="text-xs font-semibold text-slate-500">Their note</div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{selected.notes}</p>
              </div>
            )}

            {!readOnly && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
              <div className="flex items-center gap-2">
                <button
                  className="btn-secondary h-9 w-9 p-0"
                  onClick={() => updateQuantity(selected, selected.quantity - 1)}
                >
                  −
                </button>
                <span className="w-10 text-center font-bold">{selected.quantity}</span>
                <button
                  className="btn-secondary h-9 w-9 p-0"
                  onClick={() => updateQuantity(selected, selected.quantity + 1)}
                >
                  +
                </button>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="btn text-sm text-slate-600 hover:bg-slate-100"
                  title="Wrong card, or the wrong printing? Search and swap the identification — quantity and notes are kept. Use 'Search every source' in there to find printings the free databases don't list, like the ball-pattern reverse holos."
                  onClick={() => setChangingCard(true)}
                >
                  🔁 Change card or printing
                </button>
                <button
                  className="btn text-sm text-red-600 hover:bg-red-50"
                  onClick={() => updateQuantity(selected, 0)}
                >
                  Remove all
                </button>
              </div>
            </div>
            )}
          </div>
        </div>
      )}

      {selected && changingCard && (
        <CardPickerModal
          // The NAME only. The collector number was in here too, which is
          // the one part of the query somebody pressing "Change card" is
          // most likely to be changing — they are looking at a card filed
          // under the wrong printing, so pinning the search to that
          // printing's number narrows it to the very thing they are trying
          // to get away from. It has to be deleted before the box is usable,
          // which is a box that arrives broken.
          initialQuery={selected.card.name}
          candidates={[]}
          onClose={() => setChangingCard(false)}
          onPick={(card) => changeCard(selected, card)}
        />
      )}

      {/* Outside the card panel, so it covers the whole screen rather than
          being clipped by a scrolling modal. */}
      {zoom && (
        <CardZoom src={zoom} alt={selected?.card.name ?? "Card"} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}
