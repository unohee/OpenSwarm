# HEARTBEAT.md

> This file is the checklist that OpenSwarm agents follow during autonomous work.
> Copy it to the root of each project to use.

## Autonomous Development Flow

### 1. Check Linear Issues (Top Priority)

```
Check In Progress issues assigned to me in Linear
→ If found: Read issue description + comments and continue work
→ If none: Pick up the highest priority issue from Backlog
→ If no issues: Perform maintenance checks only (build/tests)
```

### 2. Check Build Status

```bash
pnpm build  # or the appropriate build command for the project
```

- On failure → Fix errors → Rebuild
- On success → Proceed to next step

### 3. Run Tests

```bash
pnpm test  # or the appropriate test command for the project
```

- On failure → Fix tests → Re-run
- On success → Proceed to next step

### 4. Work on Issues

- Check issue description
- Review previous comments (context)
- Proceed with implementation/fixes
- If working for more than 30 minutes → Update progress via Linear comment

### 5. Completion/Blocked Handling

**On completion:**
- Git commit the changes
- Output "DONE: <summary>"
- (OpenSwarm automatically marks the Linear issue as done)

**When blocked:**
- Output "BLOCKED: <reason>"
- (OpenSwarm automatically marks the Linear issue as Blocked + sends Discord notification)

### 6. Git Cleanup

- Meaningful changes → commit
- Commit messages: Conventional Commits format
- **Do not git push** (requires user approval)

---

## Report Format

Keywords automatically parsed by OpenSwarm:

```
DONE: <completion summary>     → Marks issue as done
BLOCKED: <reason for blocking> → Marks issue as Blocked + notification
```

---

## Prohibited Actions

- Do not git push without user approval
- Do not add package.json dependencies (record in TODO only)
- No destructive refactoring
- Do not get stuck on a single task for more than 30 minutes (declare BLOCKED if stuck)

---

## Autonomous Decision Criteria

1. **Priority**: Build errors > Test failures > Linear issues > Code cleanup
2. **Time limit**: If a task takes more than 30 minutes, record progress and move on
3. **Blocked determination**: Declare BLOCKED after repeating the same error 3+ times
4. **Commit granularity**: Commit in small units per feature/bugfix
