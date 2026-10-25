---
description: Show the saved interview prep report for a company
---

# Show Saved Interview Prep

Show the interview prep report already saved for the following company:

$ARGUMENTS

Load the AIJobNinja skill:

```javascript
skill({ name: "AIJobNinja" })
```

Then read the matching `interview-prep/{company}-{role}.md` under the data root (the report the `interview-prep` mode writes) and show it. Do not research or write a new one. If no report exists for that company, say so and offer to run `/aijobninja interview-prep` for it.
