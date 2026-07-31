# Bulk-scan rig — how to post photos to TrainerDeck

This document is the complete contract for the card-feeder rig (or any
client) that photographs a customer's stack and posts the photos to the
mail-in scanning service. Hand it to the person or AI writing the rig
software; nothing else is required reading.

## The service in one paragraph

An admin creates a **job** per customer stack in the TrainerDeck admin page
and gets a **device key**. The rig photographs the stack **twice**: pass 1
in feed order, then the operator flips the output pile and runs it again —
so pass 2 arrives in **reverse** order. The server reads every photo
independently and marks a card *verified* only when both passes resolve to
the same catalogue card. The rig's only jobs are: keep the cards moving,
keep the photos sharp, and keep the sequence numbers honest.

## The one endpoint

```
POST {BASE_URL}/api/bulk/photo
Header:  x-bulk-key: <device_key>          (required — the job's key)
Body:    multipart/form-data
  job    = <job_id>                        (required — uuid from the admin page)
  pass   = 1 | 2                           (required in practice; defaults to 1)
  seq    = <1-based position in THIS pass> (strongly recommended — see below)
  photo  = <image file>                    (required — JPEG preferred)
```

Example:

```bash
curl -sS -X POST "$BASE_URL/api/bulk/photo" \
  -H "x-bulk-key: $DEVICE_KEY" \
  -F job="$JOB_ID" -F pass=1 -F seq=17 \
  -F photo=@frame_0017.jpg
```

Success response (HTTP 200):

```json
{ "ok": true, "pass": 1, "seq": 17, "ordinal": 17 }
```

For pass 2 the server answers with the pass-1 position it paired to:
pass-2 card `s` of `N` pairs with pass-1 card `N+1−s`. If `seq` is echoed
back as something other than what your local counter expects, **stop and
tell the operator** — the pairing is drifting.

### Errors

| HTTP | Meaning | Rig behaviour |
|---|---|---|
| 401 | missing `x-bulk-key` | config bug — halt |
| 403 | wrong key or unknown job | config bug — halt |
| 409 | job is not `open` (finalized/uploaded/cancelled) | halt, tell operator |
| 400 | missing field / photo over 8 MB / job at 8,000-card cap | fix and retry |
| 5xx / network | transient | retry the SAME job+pass+seq (safe, see below) |

### Retries are safe — always send `seq`

Re-posting the same `job + pass + seq` **overwrites** that slot rather than
creating a duplicate. This is why the rig must send an explicit `seq` from
its own counter: on a network error you retry the same seq and nothing
shifts. If you omit `seq` the server assigns "next", and a retried request
would occupy a new slot and corrupt the order. Rule: **one physical card =
one seq, forever, retries included.**

## The two passes

1. **Pass 1**: feed the stack, `pass=1`, `seq` counting 1, 2, 3… in feed
   order. Do not reorder, do not skip.
2. Take the output pile **as it landed** and flip the whole pile once (so
   the last card fed is now on top). Do not shuffle, fan, or square-up by
   re-stacking.
3. **Pass 2**: feed again, `pass=2`, `seq` counting 1, 2, 3… again.

If a card double-feeds or jams in either pass, the pass counts won't match
and the server refuses to auto-verify anything (one slipped card would
shift every later pairing). The recovery is cheap: fix the stack and re-run
**that entire pass** with the same pass number — re-posting overwrites the
old photos slot by slot. The operator can also just let the whole job go to
human review, but on a big stack that defeats the point.

## Photo requirements

- **One card per frame**, face up, filling most of the frame. Rotation up
  to ~15° is fine; upside-down is fine. Don't crop edges off — the
  collector number lives in a bottom corner.
- **JPEG**, quality ~85. Target **1200–1600 px on the long side**. That is
  sharp enough to read the smallest collector-number print; bigger files
  upload slower and cost more to process for zero accuracy gain. Hard cap
  8 MB per photo.
- **Fixed lighting, no flash pulses**: two diffuse LED strips at ~45° kill
  glare on holos better than one bright source. Avoid overhead point
  lights — holofoil glare over the name or number is the #1 cause of
  review rows.
- Fixed camera position + fixed focus (or single autofocus lock per job).
  Consistency beats quality: the reader does better on 6,000 identical
  frames than on 6,000 individually beautiful ones.
- Let the card **settle** before capture (~150–250 ms after the feeder
  stops) — motion blur on the number is unreadable at any resolution.

## Pacing

Identification runs server-side in the background; the rig never waits for
it. Sustained **1–2 photos/second** is comfortable. Do not parallelize
uploads for one job — serial posting is what keeps `seq` honest. Multiple
jobs (different customers, different keys) may run in parallel from
different rigs.

## What the rig does NOT do

- No finalize / pairing / review calls — the operator does that in the
  admin page (Admin → Bulk scan).
- No card identification client-side.
- Never show or log the device key anywhere customer-visible; it is the
  job's only credential. A key dies with its job — new job, new key.

## Reference loop (Raspberry Pi, Python)

```python
import requests, time
from picamera2 import Picamera2

BASE = "https://YOUR-APP-DOMAIN"          # no trailing slash
KEY  = "bk_..."                            # from the admin page
JOB  = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
PASS = 1                                   # run once with 1, again with 2

cam = Picamera2()
cam.configure(cam.create_still_configuration(main={"size": (1600, 1200)}))
cam.start()

seq = 1
while feeder_has_cards():                  # your GPIO logic
    advance_one_card()                     # your GPIO logic
    time.sleep(0.25)                       # settle — kills motion blur
    path = f"/tmp/frame_{seq:05d}.jpg"
    cam.capture_file(path)
    for attempt in range(5):
        try:
            r = requests.post(
                f"{BASE}/api/bulk/photo",
                headers={"x-bulk-key": KEY},
                data={"job": JOB, "pass": str(PASS), "seq": str(seq)},
                files={"photo": open(path, "rb")},
                timeout=30,
            )
            if r.status_code == 200:
                break
            if r.status_code in (401, 403, 409):
                raise SystemExit(f"HALT: {r.status_code} {r.text}")
        except requests.RequestException:
            pass
        time.sleep(2 ** attempt)           # 1s, 2s, 4s, 8s, 16s
    else:
        raise SystemExit(f"HALT: card {seq} would not upload — fix and rerun this pass")
    seq += 1

print(f"Pass {PASS} done: {seq - 1} cards.")
```

The same contract works from anything that can POST multipart — an iOS
Shortcut for hand-shot small jobs, a laptop with a webcam, `curl` in a
shell loop. The server does not care who is holding the camera; it cares
that the key is right and the sequence is honest.
