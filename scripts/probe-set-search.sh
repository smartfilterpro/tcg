#!/usr/bin/env bash
#
# What the card sources actually say about a set.
#
# Written because "set:trick or trade" kept returning the wrong cards and I
# could not test the upstream queries from where the code is edited — the
# sandbox's network policy blocks api.pokemontcg.io, so every diagnosis was
# reasoning rather than evidence. Run this from a machine that can reach the
# internet and it answers the questions directly.
#
#   ./scripts/probe-set-search.sh "trick or trade"
#   ./scripts/probe-set-search.sh "trick or trade" Haunter
#
# POKEMONTCG_API_KEY is optional; without one you get a smaller quota.
#
# Requires: curl. Uses jq when present and falls back to raw JSON when not.

set -uo pipefail

SET_QUERY="${1:-trick or trade}"
CARD="${2:-Haunter}"
PT="https://api.pokemontcg.io/v2"
DEX="https://api.tcgdex.net/v2/en"

KEY_HEADER=()
if [ -n "${POKEMONTCG_API_KEY:-}" ]; then
  KEY_HEADER=(-H "X-Api-Key: ${POKEMONTCG_API_KEY}")
fi

if command -v jq >/dev/null 2>&1; then
  HAVE_JQ=1
else
  HAVE_JQ=0
  echo "note: jq not installed — printing raw JSON (install jq for readable output)"
fi

show() { # show <jq-filter> ; pretty when jq exists, raw otherwise
  if [ "$HAVE_JQ" = "1" ]; then jq -r "$1"; else head -c 1200; echo; fi
}

rule() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
rule "1. Which pokemontcg.io SETS match \"$SET_QUERY\"?"
echo "   (if this is empty, their catalogue has no such set and nothing else matters)"
curl -sS -G "${KEY_HEADER[@]}" "$PT/sets" \
  --data-urlencode "q=name:\"$SET_QUERY\"" \
  | show '.data[]? | "\(.id)\t\(.name)\t\(.total) cards\t\(.releaseDate)"'

# ---------------------------------------------------------------------------
rule "2. The EXACT-PHRASE card query the app now sends"
echo "   q=set.name:\"$SET_QUERY\""
curl -sS -G "${KEY_HEADER[@]}" "$PT/cards" \
  --data-urlencode "q=set.name:\"$SET_QUERY\"" \
  --data-urlencode "pageSize=250" \
  | show 'if (.data|length) == 0 then "NO RESULTS" else "\(.totalCount) total; first 15:", (.data[0:15][] | "  \(.number)\t\(.name)\t[\(.set.name)]") end'

# ---------------------------------------------------------------------------
rule "3. The OLD query — quoted phrase WITH a wildcard"
echo "   q=set.name:\"$SET_QUERY*\"   ← expected to return nothing; wildcards"
echo "   are not expanded inside quotes, which is the bug this replaced."
curl -sS -G "${KEY_HEADER[@]}" "$PT/cards" \
  --data-urlencode "q=set.name:\"$SET_QUERY*\"" \
  --data-urlencode "pageSize=5" \
  | show 'if (.data|length) == 0 then "NO RESULTS (as expected)" else "\(.totalCount) total — then the wildcard DID expand and my diagnosis was wrong" end'

# ---------------------------------------------------------------------------
rule "4. The LOOSE fallback — one prefix term per word"
LOOSE=""
for w in $SET_QUERY; do LOOSE="$LOOSE set.name:${w}*"; done
echo "   q=$(echo "$LOOSE" | sed 's/^ //')"
echo "   Watch the set names: if unrelated sets appear, the engine is ORing"
echo "   these terms and the loose form is too broad to use unfiltered."
curl -sS -G "${KEY_HEADER[@]}" "$PT/cards" \
  --data-urlencode "q=$(echo "$LOOSE" | sed 's/^ //')" \
  --data-urlencode "pageSize=40" \
  | show 'if (.data|length) == 0 then "NO RESULTS" else "\(.totalCount) total; distinct sets returned:", ([.data[].set.name] | unique | .[] | "  \(.)") end'

# ---------------------------------------------------------------------------
rule "5. Is \"$CARD\" in that set, according to pokemontcg.io?"
curl -sS -G "${KEY_HEADER[@]}" "$PT/cards" \
  --data-urlencode "q=name:$CARD set.name:\"$SET_QUERY\"" \
  --data-urlencode "pageSize=25" \
  | show 'if (.data|length) == 0 then "NOT FOUND in this set" else (.data[] | "  \(.number)\t\(.name)\t[\(.set.name)]\tid=\(.id)") end'

# ---------------------------------------------------------------------------
rule "6. Every printing of \"$CARD\" they have, newest first"
echo "   If the bundle printing is here, the card exists and our SET query is"
echo "   the problem. If it is absent entirely, their catalogue lacks it."
curl -sS -G "${KEY_HEADER[@]}" "$PT/cards" \
  --data-urlencode "q=name:$CARD" \
  --data-urlencode "orderBy=-set.releaseDate" \
  --data-urlencode "pageSize=25" \
  | show 'if (.data|length) == 0 then "NO RESULTS" else "\(.totalCount) printings; newest 25:", (.data[] | "  \(.set.releaseDate)\t\(.number)\t[\(.set.name)]") end'

# ---------------------------------------------------------------------------
rule "7. TCGdex — which sets match, and does it have $CARD?"
echo "   TCGdex usually catalogues promo bundles months earlier."
curl -sS "$DEX/sets" \
  | show --arg q "$SET_QUERY" '[.[] | select((.name // "" | ascii_downcase) | contains($q | ascii_downcase))] | if length == 0 then "NO MATCHING SETS" else (.[] | "  \(.id)\t\(.name)\t\(.cardCount.total // "?") cards") end' 2>/dev/null \
  || curl -sS "$DEX/sets" | head -c 800

echo
echo "   Card list for the first matching set:"
SET_ID=$(curl -sS "$DEX/sets" 2>/dev/null \
  | { if [ "$HAVE_JQ" = "1" ]; then jq -r --arg q "$SET_QUERY" 'first(.[] | select((.name // "" | ascii_downcase) | contains($q | ascii_downcase)) | .id) // empty'; else echo ""; fi; })
if [ -n "$SET_ID" ]; then
  curl -sS "$DEX/sets/$SET_ID" \
    | show '"  set: \(.name) (\(.cards|length) cards)", (.cards[] | "  \(.localId)\t\(.name)")'
else
  echo "   (could not resolve a set id — jq missing, or no set matched)"
fi

rule "Done"
cat <<'EOF'
What to send back:

  * Section 2 empty but 4 populated  → the phrase query is wrong for this set
  * Section 4 listing unrelated sets → the engine ORs terms; loose is unusable
  * Section 5 empty but 6 shows it   → their set name differs from what we type
  * Section 6 missing the printing   → pokemontcg.io simply lacks the card, and
                                       TCGdex (section 7) is the only route to it
EOF
