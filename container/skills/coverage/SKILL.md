---
name: coverage
description: Initiate or update single-name coverage. Use when Raja asks to initiate coverage on a ticker, verify a tweet or article claim, react to a filing or earnings report, or take a stance on one specific name. Covers both "initiate coverage on X" (32× last month) and "verify this tweet" (28× last month) patterns. Produces a WhatsApp-first answer AND files/updates a ticker page with full provenance.
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, WebFetch, WebSearch, Task
---

# /coverage — Single-Name Ticker Work

Invocation: `/coverage <TICKER>` or `/coverage <URL>`

Examples:
- `/coverage NVTS` — initiate or refresh coverage on Navitas
- `/coverage MSTR moat tam and everything` — coverage with framing hint
- `/coverage https://x.com/i/status/2038105866977636759` — verify a tweet against existing coverage
- `/coverage https://www.semianalysis.com/p/nvidia-vera-rubin` — react to an article
- `/coverage NVDA verify Jensen China trip claim` — coverage with a specific verify task

## PRIME DIRECTIVE

**The WhatsApp reply is the deliverable.** Raja reads WhatsApp first; the vault is for recall in future sessions. The chat answer must stand alone — never reduce it to "I updated the ticker page, see file X."

The ticker page is the durable record alongside the chat reply, not a replacement.

## STEP 1 — Capture provenance

```bash
date "+%Y-%m-%d %H:%M"   # save for trigger.time + LOG tag
```

Note the verbatim invocation. You will quote it into frontmatter.

## STEP 2 — Detect mode

Look at the argument:

- **Mode TICKER**: an uppercase A-Z token, 1-12 chars, no dots or slashes (e.g., `NVTS`, `MSTR`, `COREWEAVE`). Everything after it is framing/intent.
- **Mode URL**: starts with `http://` or `https://`. Sub-type by host:
  - `x.com` / `twitter.com` → use `mcp__nanoclaw__x_read` to fetch the tweet (with images).
  - Anything else → `WebFetch` (or `agent-browser` for paywalled / JS-heavy pages).
- **Mode HYBRID**: a ticker AND a URL/claim (e.g., `NVDA verify Jensen China trip`). Treat as TICKER mode but with the URL/claim as the specific verify target.

## STEP 3 — Orient against existing coverage

Always:

1. If you have a ticker → `Read /workspace/vault/shared/tickers/<TICKER>.md`. Doesn't exist? Mark as **initiation**. Exists? Mark as **update**.
2. `Read /workspace/vault/shared/INDEX.md` — confirm the row state and look for related research pages.
3. For URL mode without a known ticker yet: read the URL content, extract subject tickers, then run the ticker lookups above for each.

If existing coverage is current (< 7 days old per `## Rot — Research Notes`), say so in the WhatsApp reply and only update if the new input materially changes the thesis.

## STEP 4 — Do the work

Branch by mode:

### TICKER mode (initiation or refresh)

- Fetch latest fundamentals via `finviz` MCP (`get_stock_fundamentals`, `get_stock_news`).
- For names with thesis hooks Raja mentions ("moat, tam, capex" etc.) — research each.
- `mcp__nanoclaw__x_feed_query` to surface what tier-1 accounts have said recently.

### URL mode (verify / react)

- Pull full content (tweet text + images via `x_read`, or full article body).
- Extract the central claim(s).
- Cross-check against existing ticker page thesis. Three outcomes per claim:
  - **Confirms** existing thesis — note as supporting evidence.
  - **Extends** thesis — new data point, new angle.
  - **Contradicts** — flag explicitly, prioritize verification.
- Verify against independent sources where possible (don't just take the tweet's word).

### HYBRID

- Do the URL work first to nail down the specific claim.
- Then do TICKER-mode update with the verified/refuted claim as the headline insight.

## STEP 5 — Write or update the ticker page

**On initiation**, use the template from `/workspace/vault/README.md`. Frontmatter MUST include the `trigger:` block:

```yaml
trigger:
  source: raja
  time: <YYYY-MM-DD HH:MM>
  prompt: "<verbatim invocation, truncated to ~100 chars>"
```

**On update**, append under `## Rot — Research Notes`:

```
- <YYYY-MM-DD>: <one-line headline insight>. <2-3 sentence detail>. Source: <URL or [[wikilink]]>.
```

Keep ticker pages atomic — if your update is a 200-line research dump, file it as a research page under `shared/research/{topic}/` instead and wikilink from the ticker page. Use the `/dive` skill template if it's truly that big.

## STEP 6 — Update INDEX.md

- **On initiation**: add a row to the `## Ticker Pages` table. One-line thesis, max ~120 chars.
- **On update**: only edit the INDEX row if the thesis line changed materially.

## STEP 7 — Append to LOG.md

ONE line at the top:

`## YYYY-MM-DD (req YYYY-MM-DD HH:MM) — <TICKER>.md <initiated|updated> | <1-2 sentence summary> — <TICKER>`

The `(req ...)` tag is mandatory. Use the message time from STEP 1.

## STEP 8 — Send the WhatsApp reply (THE DELIVERABLE)

Structure depending on mode:

### TICKER mode

- Lead with the thesis statement (1-2 lines).
- Key data points: price, market cap, key metric (ARR, capacity, % share, etc.) — only the hard-to-find numbers.
- Why it matters (1-2 lines): what's the edge?
- Risks (1-2 lines).
- Sources at bottom.
- Footer: `📁 vault: tickers/<TICKER>.md`

### URL / verify mode

- Lead with the verdict: *Confirmed*, *Partially confirmed*, *Contradicted*, *Inconclusive*.
- Quote the central claim (one line, in italics).
- Evidence (2-4 bullets).
- Implication for our coverage (1-2 lines).
- Sources at bottom.
- Footer: `📁 vault: tickers/<TICKER>.md` (or research path if a new research page was needed)

Use WhatsApp formatting throughout — `*bold*`, `•` bullets, no `##` headings, paste URLs raw.

**Bad reply:** "I've updated NVTS.md with the new findings."
**Good reply:** the actual thesis update, with the vault path as a one-line footer.

## STEP 9 — If this completes a backlog row

Check `shared/research/_backlog.md`. If this `/coverage` answered an open row, remove it and add to the completed table per the same convention as `/dive`.

## ERROR HANDLING

- Ticker doesn't exist on Finviz (private co, foreign listing): note in vault page, fall back to web research.
- URL fails to fetch: try `agent-browser open` for JS-heavy or paywalled pages.
- Two tickers in scope on a verify (e.g., a deal between A and B): update both ticker pages, file one LOG entry that lists both.
- If you're about to write more than ~200 lines to a ticker page, stop — that's a research file, not a ticker page. Use `/dive` instead or split it.
