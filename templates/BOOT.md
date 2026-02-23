---
description: Startup execution checklist
usage: Short instructions to run automatically at service startup
---

# BOOT.md

Add short, explicit instructions to execute at service startup.

## Example

```markdown
# Boot Checklist

1. Sync latest code with git pull
2. Verify dependencies with npm install
3. Confirm environment variables are loaded
4. Report service status to Discord
```

## Rules

- Keep it short (save tokens)
- If you need to send a message, use the message tool then reply with NO_REPLY
- Only approved external actions
