---
name: dive
description: Deep-dive research on a theme, sector, or comparative question. Use when Raja asks for a primer, comparative analysis, sector landscape, supply-chain walk, "research and list beneficiaries", or any multi-paragraph synthesis. Produces a WhatsApp-first answer AND files a dated vault page with full provenance.
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob, WebFetch, WebSearch, Task
---

# /dive — Theme & Sector Deep Dive

Invocation: `/dive <free-text topic>`

Examples:
- `/dive testing stocks compare onto aehr ter form keys`
- `/dive primer on power semis players TAM margins capex`
- `/dive walk the optics ecosystem and predict where Nvidia might invest next`
- `/dive Google new TPU announcement, beneficiaries by stack layer`

## PRIME DIRECTIVE

**The WhatsApp reply is the deliverable.** Raja reads WhatsApp first; the vault is for recall in future sessions. Write a substantive, self-contained chat answer — never reduce it to "I researched and saved to vault, see file X."

The vault file is the durable record alongside the chat reply, not a replacement.

## STEP 1 — Capture provenance

Run once at the start, save the values:

```bash
date "+%Y-%m-%d %H:%M"   # message time, used for trigger.time + LOG tag
```

Note the verbatim invocation text (the `<topic>` you were given). You will quote it into the vault file frontmatter.

## STEP 2 — Orient against existing coverage

Always before researching:

1. `Read /workspace/vault/shared/INDEX.md` — see what's already covered. Don't re-research a page that's already current.
2. If the topic implies specific tickers, `ls /workspace/vault/shared/tickers/` and read the ones that match. Ground new findings in existing thesis, don't restart from zero.
3. `Read /workspace/vault/shared/research/_backlog.md` — if this `/dive` matches an open backlog row, you'll need to remove the row after writing.

## STEP 3 — Pick the vault home

`shared/research/{topic-subfolder}/{slug}-YYYY-MM.md` where:

- `topic-subfolder`: run `ls /workspace/vault/shared/research/` to see what exists; pick the closest match. Only create a new subfolder if no existing one fits. Don't write to vault root.
- `slug` is lowercased, hyphen-joined, max 50 chars: `power-semis-primer`, `optics-stack-nvda-investments`, `testing-stocks-onto-aehr-ter-form-keys`.
- `YYYY-MM` is the current year-month from STEP 1.

If a near-identical file already exists (same slug, same month), **update it** instead of creating a duplicate.

## STEP 4 — Do the research

Use whatever tools fit — `WebSearch`, `WebFetch`, `mcp__nanoclaw__x_feed_query`, `mcp__nanoclaw__x_thread`, `mcp__nanoclaw__x_read`, `finviz` MCP, `agent-browser`.

For very broad asks (3+ subtopics, 5+ tickers, or comparative across a sector), spawn sub-agents via the `Task` tool to parallelize. Each sub-agent gets one slice. Reconcile findings before writing.

**Cite every claim.** No unsourced statements.

## STEP 5 — Write the vault file

Frontmatter required:

```yaml
---
title: <Title>
date: <YYYY-MM-DD>
type: research
tags: [topic, sector]
sources: [Source1, Source2]
tickers: [TICK1, TICK2]
trigger:
  source: raja
  time: <YYYY-MM-DD HH:MM>
  prompt: "<verbatim invocation, truncated to ~100 chars>"
---
```

Body structure:
- `## TL;DR` — 3-6 bullets, the answer first.
- `## Findings` — detailed sections per subtopic / per ticker.
- `## Sources` — every URL/source you cited.
- `## Related` — wikilinks to ticker pages and prior research.

## STEP 6 — Update cross-references

For every ticker materially discussed:

1. Open `shared/tickers/TICK.md`.
2. Under `## Rot — Research Notes`, append a dated entry that wikilinks to the new research file: `- <YYYY-MM-DD>: <one-line takeaway> — [[<slug>-YYYY-MM|<short title>]]`
3. If the ticker page doesn't exist and the ticker is material (not a passing mention), invoke `/coverage <TICKER>` after `/dive` completes — or note "ticker page needed" in your WhatsApp reply.

## STEP 7 — Update INDEX.md

Add or update a row under the matching `## Research — {Topic}` section in `shared/INDEX.md`. Format:

`| [[<slug>-YYYY-MM]] | <one-line description, the same TL;DR sentence works> |`

## STEP 8 — Append to LOG.md

ONE line at the top of `shared/LOG.md`:

`## YYYY-MM-DD (req YYYY-MM-DD HH:MM) — <Title> | <2-sentence summary> — TICK1, TICK2`

The `(req YYYY-MM-DD HH:MM)` tag uses the message time from STEP 1. This is mandatory — no untagged LOG entries.

## STEP 9 — If you cleared a backlog row

If this `/dive` completed a row in `shared/research/_backlog.md`:
1. Delete the row from the `## Open` table.
2. Add a row to the `## Completed (moved out, kept for audit)` section: `| <orig date> | "<quote>" | <topic> | → moved to <path> |`

## STEP 10 — Send the WhatsApp reply (THE DELIVERABLE)

Format for the chat reply:
- Lead with the answer (TL;DR), not the process.
- Use WhatsApp formatting (single `*asterisks*` for bold, `•` for bullets, no `##` headings, no markdown links).
- 8-20 lines is the sweet spot; longer is fine if the question warrants it, but break with `mcp__nanoclaw__send_message` into 2-3 chunks rather than one wall.
- Include sources inline or at the bottom (paste URLs).
- Last line: `📁 vault: research/<topic>/<slug>-YYYY-MM.md` — single-line pointer for later recall, not a "see vault for details" redirect.

**Bad chat reply:** "I've completed the research and saved it to the vault. See `shared/research/...`"
**Good chat reply:** the actual findings, with the vault path as a one-line footer.

## ERROR HANDLING

- If you can't decide a topic subfolder, create a new one — don't dump to vault root.
- If a sub-agent fails, fall back to inline research. Don't block on Task tool errors.
- If INDEX.md grows past 250 lines, ask Raja whether to split or compress (don't auto-decide).
- If LOG.md tops 600 lines, note it in the WhatsApp reply — Raja will rotate it.
