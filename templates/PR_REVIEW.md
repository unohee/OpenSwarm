---
description: PR review (review only, no merge)
trigger: /review <pr_number_or_url>
---

# PR Review

PR: $ARGUMENTS

## Goal

Thorough review with a clear recommendation (READY / NEEDS WORK).
**No merge, push, or code changes** — review only.

## Process

### 1. Check PR Metadata

```sh
gh pr view <PR> --json number,title,state,isDraft,author,baseRefName,headRefName,url,body,files,additions,deletions --jq '{number,title,url,state,isDraft,author:.author.login,base:.baseRefName,head:.headRefName,additions,deletions,files:.files|length}'
```

### 2. Analyze PR Description
- Summarize the goal, scope, and "why now?" rationale
- Flag missing context: motivation, alternatives considered, rollout/compatibility, risks

### 3. Read the Diff Thoroughly

```sh
gh pr diff <PR>
```

### 4. Validate Necessity/Value of Changes
- What problem does it solve?
- Is this the smallest reasonable fix?
- Does it introduce complexity for marginal benefit?
- Is this a behavioral change requiring docs or release notes?

### 5. Evaluate Implementation Quality
- **Correctness**: edge cases, error handling, null/undefined, concurrency
- **Design**: appropriate abstraction? over/under-engineered?
- **Performance**: hot paths, allocations, N+1, caching
- **Security**: authz/authn, input validation, secrets, PII logging
- **Backward compatibility**: public API, config, migrations
- **Style consistency**: formatting, naming, existing patterns

### 6. Tests & Verification
- What tests cover this?
- Are there regression tests for the bug fix/scenario?
- Flag missing test cases
- Do tests actually assert critical behavior? (not just snapshot/happy path)

### 7. Suggest Follow-up Refactoring/Cleanup
- Code that can be simplified before merge?
- TODOs to resolve now vs. defer to tickets?
- Deprecation, docs, types, lint rule adjustments?

### 8. Key Questions
- Can we fix this as a follow-up, or does the contributor need to update?
- Blocking concerns (must fix before merge)?
- Is the PR ready to land?

## Output Format

### A) TL;DR Recommendation
- `READY FOR MERGE` | `NEEDS WORK` | `NEEDS DISCUSSION`
- 1-3 sentence rationale

### B) Changes
- Bullet summary of diff/behavioral changes

### C) Good Things
- Correctness, simplicity, tests, docs, ergonomics, etc.

### D) Concerns/Questions (actionable)
- Numbered list
- Each item labeled:
  - **BLOCKER** (must fix before merge)
  - **IMPORTANT** (recommended before merge)
  - **NIT** (optional)
- Point to specific file/area + provide concrete fix suggestion

### E) Tests
- What exists
- What's missing (specific scenarios)

### F) Follow-ups (optional)
- Non-blocking refactoring/tickets

### G) PR Comment Draft (optional)
- "Should I draft a PR comment?"
- On request, provide a copy-paste-ready comment

## Rules

- **Review only**: no `gh pr merge`, no branch push, no code edits
- If unclear, ask rather than guess
