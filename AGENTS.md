# aroflo-v2-mcp

Stdio MCP server for the AroFlo API v2 (`https://api.aroflo.com/v2`). The API is an open beta and AroFlo ships breaking changes most weeks. The main client is Codex, used on a limited subscription, so every token the server adds to a model's context counts.

## Commands

- `npm run check` runs typecheck and tests. Run it before every commit.
- `npm run build` compiles to `dist/`, which is what MCP clients run.
- `npm run spec:update` re-extracts the spec from docs.api.aroflo.com, rebuilds `spec/catalog.json` and prints the diff.
- `npm run spec:used` regenerates `spec/used.json` from `src/defaults.ts`. Every file in `spec/` is generated: never hand-edit one.
- `npm run smoke:live` runs the tools read-only against live AroFlo (needs `AROFLO_V2_API_KEY`) and prints tokens, calls and the first line of each result. `--show` prints full results: real data, keep it out of the repo.
- `npm run measure` prints token counts for tools/list and sample outputs.

Debugging: `AROFLO_V2_DEBUG=1` logs one line per request (operation template, status, ms) to stderr. `AROFLO_V2_DEBUG_FILE=<path>` records the connecting client's name and declared capabilities, which is how to check whether a client supports confirm dialogs.

## Layout

- `src/tools/` has one file per MCP tool. `src/format.ts` renders compact output. `src/http.ts` is the API client. `src/jobs.ts` finds tasks and quotes by job number.
- `src/defaults.ts` holds the default columns and the fields the composite tools read. Tune output for a use case there first.
- `spec/aroflo-v2.ops.json` is the extracted spec (AroFlo publishes none). `spec/catalog.json` is the runtime catalog built from it.
- `spec/used.json` lists the operations and fields the code depends on. `test/spec-contract.test.ts` fails when AroFlo removes one, so the weekly spec PR shows what broke.

## Token budget

- `test/budget.test.ts` caps the size of tools/list. A new tool means merging or removing one, or raising the cap with the reason in the commit message.
- Tool descriptions are short and concrete, with one example. Details belong in `aroflo_api` output, which the model fetches only when needed.
- Output is compact text: tab-separated tables for lists, `key: value` lines for records. No raw JSON, no `_links`, no nulls or empty values. Lists default to 25 rows. Long text is cut with a marker saying how much was left out.
- One composite call beats several round trips for a common question.

## Safety

- The server is read-only unless `AROFLO_V2_WRITE_OPS` names operations. Every write is a preview first, then a confirm with the code from the preview.
- AroFlo has no API delete except for schedules. A test record has to be removed by hand in the AroFlo UI, so live writes happen only when Gerd asks, on records named `ZZ ... (delete me)`.
- Never print, log or commit a token. Tests and fixtures use synthetic data only, with no real AroFlo records, ids, names or counts.
- A 401, or a 404 on a collection path that worked before, usually means the token was revoked or rotated. Report it and stop calling. Don't retry in a loop.

## Review

Each increment gets a read-only Codex review (default model) before it is merged:

```bash
codex exec -s read-only -C . -o <review-file> "$(cat <prompt-file>)" < /dev/null
```
