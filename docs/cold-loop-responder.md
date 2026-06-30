# Cold-loop responder (template)

The library is **AI-free**: it only computes a structural signature and (via `GitHubIssueReporter`)
files a deduplicated issue carrying a hidden `parse-signature: <hash>` marker. The *responder* that
fixes the library is **out-of-band and swappable** — a human, or an AI routine triggered by the issue.
Wire it in the public `mailkite/mail-parse` repo (not in the MailKite monorepo). Design: `mime-parser.md` §8.2.

## Flow

```
parse failure → FailureAggregator (threshold/distinctSources) → GitHubIssueReporter
  → ONE idempotent issue (search-then-create on the parse-signature marker)
  → responder triggered BY the issue (Action / Claude Code / human)
      → reproduces from the scrubbed repro, fixes CORE, opens a PR
      → CI gate: golden corpus + benign corpus must stay green
      → merge → publish → close issue
```

The responder fixes **core** (this is the root-cause cure for failures seen across many sources —
high `distinctSources`). A tenant-concentrated failure (low `distinctSources`) is the hot loop's job
(a sandboxed middleware), not this.

## Example trigger (GitHub Actions)

```yaml
# .github/workflows/parse-failure-triage.yml  (in mailkite/mail-parse)
on:
  issues:
    types: [opened, labeled]
jobs:
  triage:
    if: contains(github.event.issue.labels.*.name, 'parse-failure')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Hand the issue body (structural signature + scrubbed repro) to a responder that:
      #  1. reconstructs a failing fixture, 2. proposes a core fix, 3. opens a PR.
      # The PR is gated by the normal `npm test` (golden + benign corpus) before any merge.
      - run: echo "responder runs here (human review or an AI routine)"
```

## CI gate (the cold-loop equivalent of the hot-loop canary)

A responder's PR must keep `npm test` green — the gold-standard corpus **and** a benign corpus of
normal mail that must keep parsing unchanged. That zero-regression gate is what makes an
auto-proposed fix safe to merge.
