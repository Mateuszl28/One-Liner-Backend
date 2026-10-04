# AI_WORKFLOW

## Tools used

| Tool | Version / model | Used for |
|---|---|---|
| Claude Code (CLI, Windows) | Claude Opus 5.5 (`claude-opus-5-5`) | Architecture, writing this repository (core TS, tests, demo, ArkTS modules, specs), debugging |
| MCP servers / Agent Skills | none used for code | — |

## Main prompts

1. `"Hackathon2026-4.pdf" zrób backend` ("build the backend"), with the Gather concept document attached.
2. The hackathon challenge PDF, added mid-task (requirements: API 20+, tests, error handling, AI_WORKFLOW.md).

No reusable instruction files or custom configuration were used.

## Workflow

1. **Ideation → architecture.** The concept says there is no cloud server, so the agent read "backend" as the on-device logic and sync layer. It proposed an op-log design: single-writer keys, HLC ordering, and deterministic replay. This design maps onto `distributedKVStore` without relying on the store's own last-write-wins conflict handling.
2. **Implementation.** Pure TypeScript core first (money → state reducer → split → settle → receipt → sync), then the in-memory multi-device network, then the RN codegen specs and ArkTS modules.
3. **Testing.** Vitest suites for each module, plus a demo script that replays the planned hackathon demo on two simulated phones.
4. **Debugging.** See "Validation" below.

## Validation of generated output

- `npm run typecheck` (strict TS, `noUncheckedIndexedAccess`) and `npm test`: 33 tests passing.
- The minimum-payments algorithm is checked against an exhaustive brute-force optimum on 60 random cases. A brute-force search also found a concrete case where a greedy approach needs 7 payments and the optimum is 5; it is now a regression test.
- Convergence: a test replays the same ops in 20 random orders and requires identical state. Offline-edit and concurrent-claim scenarios are tested with one phone disconnected.
- Mistakes found during review: two of the agent's own test expectations were wrong (a hand-computed settle case and a missing sync step) and were corrected. The demo run exposed a real bug: a tip added at the table triggered a false "total mismatch" warning. The fix compares the receipt total without the tip.

## Known limitations

- The ArkTS modules were written from API documentation and have **not been compiled or run** on an emulator yet.
- The receipt parser is rule-based (the on-device OCR/MindSpore model is not integrated yet). It flags uncertainty instead of guessing.
- Membership trust relies on OpenHarmony device pairing. Ops are not cryptographically signed.

## Privacy

No accounts, no server, no `INTERNET` permission in the native module. Data stays on the participating devices in an encrypted KV store at security level S1. No API keys or personal data are in the repository.
