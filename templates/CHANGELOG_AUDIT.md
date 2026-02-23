---
description: Pre-release changelog audit
trigger: /changelog
---

# Changelog Audit

Audit changelog entries for all commits before release.

## Process

### 1. Find the Last Release Tag

```bash
git tag --sort=-version:refname | head -1
```

### 2. List All Commits Since That Tag

```bash
git log <tag>..HEAD --oneline
```

### 3. Check the [Unreleased] Section in CHANGELOG.md

### 4. Verify Each Commit

**Skip:**
- Changelog updates
- Documentation-only changes
- Release-related housekeeping

**Check:**
- Use `git show <hash> --stat` to identify affected areas
- Whether a changelog entry exists for that area
- For external contributions (PRs), verify format: `description ([#N](url) by [@user](url))`

### 5. Write Report

- List commits with missing entries
- Directly add needed entries

## Changelog Format

### Section Order

```markdown
### Breaking Changes
API changes requiring migration

### Added
New features

### Changed
Changes to existing features

### Fixed
Bug fixes

### Removed
Removed features
```

### Attribution Format

**Internal:**
```markdown
- Fixed foo ([#123](https://github.com/owner/repo/issues/123))
```

**External:**
```markdown
- Added bar ([#456](https://github.com/owner/repo/pull/456) by [@user](https://github.com/user))
```
