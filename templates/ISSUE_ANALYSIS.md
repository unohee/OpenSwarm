---
description: GitHub issue analysis (bugs/feature requests)
trigger: /is <issue_url_or_number>
---

# GitHub Issue Analysis

Analyzing issue: $ARGUMENTS

## Process

For each issue:

1. **Read the entire issue**
   - Including body, all comments, linked issues/PRs

2. **If it's a bug:**
   - Ignore the cause analysis written in the issue (usually wrong)
   - Read all relevant code files completely (no truncation)
   - Trace the code path to identify the actual cause
   - Suggest a fix

3. **If it's a feature request:**
   - Read all relevant code files completely
   - Suggest the most concise implementation approach
   - List affected files and required changes

## Rules

- Do not implement without explicit request
- Perform analysis and suggestions only
