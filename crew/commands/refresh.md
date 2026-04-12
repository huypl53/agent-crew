---
description: Re-register your agent after resuming a session
---

Parse the user's arguments and run via Bash:

```
Arguments: --name <name>

Run: crew refresh --name <name>
```

On success, confirm: "Refreshed <name> — rooms: <rooms>, pane: <target>"

On error, show the error message. If agent not found, suggest using `/crew:join-room` instead.
