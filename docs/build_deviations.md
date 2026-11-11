# Build deviations

| Phase | File | What the plan said | What was done | Why |
| --- | --- | --- | --- | --- |
| 8 | `docs/designs/chat_agent_dated_memory_design.md` (file 38) | The local-path check is `grep -rn "/Users/" docs README.md DESIGN.md` and must print nothing | Reworded that line of the design doc to `grep -rn "<local home path>" ...` | The design doc quoted the command itself, so the check matched its own text. No behaviour changed |
