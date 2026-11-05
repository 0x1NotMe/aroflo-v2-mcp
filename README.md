# aroflo-v2-mcp

An MCP server for the AroFlo API v2, built for Codex. It is read-only unless you switch writes on, and it keeps what it sends to the model small: the tool definitions cost about 500 tokens per turn, where the v1 server (`aroflo-mcp`, 51 tools) cost about 26,000.

**Unofficial.** This is an independent project. It is not made, endorsed or supported by AroFlo, and it has no affiliation with AroFlo Innovations Pty Ltd. AroFlo® is a trademark of AroFlo Innovations Pty Ltd. The server connects to AroFlo through API v2, which is in open beta and changes most weeks. You run it with your own AroFlo API credentials, under your own [API Licence Agreement](https://aroflo.com/policies/api-terms-of-use-policy) with AroFlo. It comes with no warranty: check what it reads, and above all what it writes, before you rely on it.

## Tools

| Tool | What it does |
|---|---|
| `aroflo_job` | One job in one call: details, schedule and staff, labour hours by person and work type, materials, latest notes. Takes a job number or task id. |
| `aroflo_quote` | One quote in one call: header, totals, labour hours, sections and top-level lines with each line's labour hours. `lines=true` lists every line by section. Takes a job number or quote id. |
| `aroflo_get` | Any read endpoint as a path with a query, for example `/clients?name.like=smith` or `/tasks?status=1&serviceId=<task type id>`. Returns 25 rows by default as a compact table. |
| `aroflo_api` | Finds endpoints and shows one endpoint's filters, fields and rules. The model uses it only when it doesn't know a path. |
| `aroflo_write` | Creates or changes records. It only exists when `AROFLO_V2_WRITE_OPS` is set. See [Writes](#writes). |

## Setup

You need Node 22 or later and an AroFlo API token.

1. Build the server:

   ```bash
   git clone git@github.com:0x1NotMe/aroflo-v2-mcp.git
   cd aroflo-v2-mcp
   npm ci
   npm run build
   ```

2. Create a token in AroFlo under Site Admin, AroFlo API. The token can do whatever its AroFlo user can do, including seeing every cost and sell price, so create it from a user that has only the access you need. AroFlo shows the token once, and the expiry you pick then can't be changed.

3. Put the token in a file only you can read. Don't paste it into a config file. With the token on the clipboard:

   ```bash
   (umask 077; mkdir -p ~/.config/aroflo && pbpaste > ~/.config/aroflo/token && chmod 600 ~/.config/aroflo/token)
   ```

   `umask 077` makes a new folder and file private from the moment they exist, and `chmod 600` fixes a token file that already existed. The server warns at startup if the file is readable by others.

4. Check the token works:

   ```bash
   AROFLO_V2_TOKEN_FILE=~/.config/aroflo/token node dist/index.js --check
   ```

   It prints `token: OK` and the AroFlo calls left today, or the reason it failed.

5. Add the server to Codex in `~/.codex/config.toml`:

   ```toml
   [mcp_servers.aroflo]
   command = "node"
   args = ["/full/path/to/aroflo-v2-mcp/dist/index.js"]
   env = { AROFLO_V2_TOKEN_FILE = "/Users/you/.config/aroflo/token" }
   ```

   For Claude Code:

   ```bash
   claude mcp add aroflo -e AROFLO_V2_TOKEN_FILE=/Users/you/.config/aroflo/token -- node /full/path/to/aroflo-v2-mcp/dist/index.js
   ```

### Installing from a package file (no GitHub access)

On a machine that has the repo, build a package file:

```bash
npm ci && npm run build && npm pack
```

That writes `aroflo-v2-mcp-0.1.0.tgz`. On the other Mac (Node 22 or later), install it and print the two paths Codex needs:

```bash
npm install -g ./aroflo-v2-mcp-0.1.0.tgz
which node
echo "$(npm root -g)/aroflo-v2-mcp/dist/index.js"
```

Then do steps 3 and 4 above, and in `~/.codex/config.toml` use the two printed paths. Full paths matter: Codex started from the Dock may not find `node` on its own.

```toml
[mcp_servers.aroflo]
command = "/opt/homebrew/bin/node"   # what `which node` printed
args = ["/opt/homebrew/lib/node_modules/aroflo-v2-mcp/dist/index.js"]   # the second printed line
env = { AROFLO_V2_TOKEN_FILE = "/Users/you/.config/aroflo/token" }
```

To update, install the new package file the same way. Codex uses it the next time it starts.

## Settings

All settings are environment variables in the MCP server config.

| Variable | Default | Meaning |
|---|---|---|
| `AROFLO_V2_TOKEN_FILE` | | Path to a file holding the token (chmod 600). |
| `AROFLO_V2_API_KEY` | | The token itself, if you inject it from a secret store instead of a file. |
| `AROFLO_V2_WRITE_OPS` | empty | Write operations to allow. Empty means read-only. |
| `AROFLO_V2_DEFAULT_LIMIT` | 25 | Rows a list returns when the model doesn't ask for a number. |
| `AROFLO_V2_MAX_RPM` | 60 | Calls per minute this server allows itself. AroFlo's own limit is 120 a minute and 5,000 a day per site. |
| `AROFLO_V2_BUSINESS_UNIT_ID` | first one the token sees | Business unit used where AroFlo needs one. |
| `AROFLO_V2_AUDIT_LOG` | `~/.local/state/aroflo-v2-mcp/audit.jsonl` | Where writes are logged. |

## Writes

The server never writes unless `AROFLO_V2_WRITE_OPS` lists what it may write. Entries are AroFlo tag names, exact operations, or `*`:

```toml
env = { AROFLO_V2_TOKEN_FILE = "...", AROFLO_V2_WRITE_OPS = "Notes,PATCH /clients/{clientId}" }
```

`aroflo_api` shows the tag and body fields of each endpoint.

Every write needs the user's OK:

- Codex supports MCP confirm dialogs. Each `aroflo_write` call opens a dialog showing the exact request, and nothing is sent unless you accept it there. The model can't answer the dialog.
- In clients without confirm dialogs, the first call returns a preview and a one-time code, and the model has to call again with the code. Keep the client's own approval prompt on for `aroflo_write`, because that prompt is what stops a model from confirming by itself.

Other things to know:

- AroFlo has no undo. Apart from schedules, nothing can be deleted through the API, so a mistaken record has to be removed by hand in AroFlo.
- The server checks the body against AroFlo's published schema before sending, and rejects fields AroFlo doesn't document, because AroFlo silently ignores those.
- Each write is appended to the audit log with the operation, record ids, status and a hash of the body. The log holds no personal data.

## When the token stops working

A `401`, or a `404` on a list that worked before, usually means the token was revoked or rotated. The server says so instead of retrying. Put the new token in the token file and run `--check`. Codex picks it up the next time it starts the server.

## Development

`AGENTS.md` has the commands, the layout and the rules for working on this repo. AroFlo publishes no OpenAPI file, so `npm run spec:update` rebuilds the spec from the documentation site. A weekly GitHub Action does the same and opens a pull request when AroFlo changes the API. It needs the repository setting Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests", and it reports its test result as a status on that pull request.
