# Shared CLAUDE.md fragments

Drop-in instruction modules that any group's `CLAUDE.md` can include.

**How to use:** Add a directive on any line of your group's `CLAUDE.md`:

```
<!-- fragments: whatsapp-formatting, memory-startup -->
```

Names are comma-separated, whitespace-tolerant. Each name maps to `groups/_fragments/{name}.md`. The agent-runner reads the directive at spawn and prepends each fragment's contents to the system prompt (alongside `groups/global/CLAUDE.md`).

**Conventions:**
- One concern per fragment. If a fragment grows past ~30 lines, split it.
- Fragments are *additive guidance*. They shouldn't override the per-group personality — the group's `CLAUDE.md` always wins.
- Edit in place. The next container spawn picks up changes automatically (no restart needed).
- Don't include `# heading` levels that conflict with the group's `CLAUDE.md` structure — fragments are typically `## Section` or just bullet content.
