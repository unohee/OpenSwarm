---
description: PR landing (review + merge workflow)
trigger: /land <pr_number_or_url>
---

# PR Land

PR: $ARGUMENTS

## Goal

Review the PR and complete the merge.

## Process

### Phase 1: Review (same as PR_REVIEW.md)

Perform review steps 1-8, then proceed to Phase 2 if READY.

### Phase 2: Land

1. **Create temporary branch from main**
   ```sh
   git checkout main
   git pull
   git checkout -b land-pr-<number>
   ```

2. **Fetch the PR branch**
   - If clean commit history, prefer **rebase**
   - If complex, use **squash merge**
   ```sh
   gh pr checkout <PR>
   git rebase main  # or squash
   ```

3. **Apply necessary fixes**
   - Fix issues found during review
   - Verify tests pass

4. **Add changelog entry**
   - Include PR number
   - Credit external contributors
   ```
   - Fix something ([#123](url) by [@user](url))
   ```

5. **Run all gates**
   ```sh
   npm run build && npm run lint && npm run test
   ```

6. **Commit**
   - On squash, add original author as co-contributor
   ```
   Co-Authored-By: User <user@email.com>
   ```

7. **Merge into main**
   ```sh
   git checkout main
   git merge land-pr-<number>
   git branch -d land-pr-<number>
   git push
   ```

8. **Leave a PR comment**
   - Explain what was done
   - Include commit SHA

## Rules

- No merge before READY determination
- Contributors must remain in the git graph
- Always return to main branch after completion
