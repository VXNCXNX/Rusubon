# Set up Rusubon for your user

Follow this guide when asked to install Rusubon, configure it for a product, or repair an incomplete setup. Finish with a working local dashboard and verified scout readiness. A setup request alone does not authorize a scout run, research, or publication.

## 1. Locate the product

Distinguish two directories:

- `RUSUBON_DIR`: the Rusubon source checkout, where its dependencies are installed.
- `PRODUCT_DIR`: the user's product repository, where configuration, context, and findings belong.

Infer the product from the user's request and current workspace. Read its applicable agent instructions and existing `rusubon.json` and `.rusubon/context.md`. Preserve existing settings and unrelated edits. If the target is ambiguous, ask for its absolute path before writing configuration. The Rusubon checkout is the target only when the user wants to investigate Rusubon itself.

Reuse known PostHog project ID, US or EU region, and runner preferences. Ask only for missing values; a project ID is not an API key. Claude Code and Codex support the dashboard. For a requested Cursor-only setup, follow [Use the CLI directly](README.md#use-the-cli-directly) instead.

**Done when:** the product path is resolved and each required setting is either known or explicitly pending user input. Continue installation while answers are pending.

## 2. Install the harness

Use a persistent source checkout. If one exists, reuse it; update a clean checkout with a fast-forward pull when an update is requested. Set both paths to the resolved locations and retain them for later commands:

```sh
RUSUBON_DIR='/absolute/path/to/Rusubon'
PRODUCT_DIR='/absolute/path/to/product'
```

For a new installation, clone into the unused `RUSUBON_DIR`:

```sh
git clone https://github.com/VXNCXNX/Rusubon.git "$RUSUBON_DIR"
```

Use the current checkout's `package.json` for the Node.js requirement. Install dependencies from its lockfile:

```sh
cd "$RUSUBON_DIR"
npm ci
node "$RUSUBON_DIR/bin/rusubon.mjs" help
```

The absolute CLI path works without a global install. If the user wants the shorter `rusubon` command, use the `npm link` instructions in [Start your dashboard](README.md#start-your-dashboard). The runtime requires POSIX process groups; use WSL on Windows.

**Done when:** the supported Node runtime and dependencies are present, and the help command lists `ui`, `init`, and `doctor`.

## 3. Initialize and open the dashboard

Run initialization in the product directory. It preserves existing configuration and context, creates missing workspace files, and adds the inbox and run directories to `.gitignore`.

```sh
cd "$PRODUCT_DIR"
node "$RUSUBON_DIR/bin/rusubon.mjs" init
node "$RUSUBON_DIR/bin/rusubon.mjs" ui --repo "$PRODUCT_DIR" --no-open
```

Keep the dashboard command in a persistent terminal/session. Open the exact URL it prints, including the token fragment. Keep that URL in the local user handoff, outside repository files and public messages. Reuse an existing dashboard if the repository is already locked by one.

**Done when:** the live dashboard opens and Setup shows the intended product path. A screenshot or demo workspace is not verification of the user's setup.

## 4. Connect the user's runner

In Setup, refresh connections. Reuse the selected runner's existing login. If the CLI is missing, use its current official installation instructions; if sign-in is needed, start the dashboard's sign-in action and hand the browser authorization to the user. Read the connection card's billing source and surface it if it differs from the user's intended account.

Choose **Connect PostHog** for that runner and let the user authorize their PostHog account. The dashboard reuses an official connection or adds one in the runner's user configuration. Credentials stay there; keep repository configuration and context free of tokens. Use only the official endpoint in [rusubon.mcp.example.json](rusubon.mcp.example.json), and preserve other MCP entries.

If browser automation is unavailable, give the user the exact outstanding Setup actions and continue preparing local files. For a terminal-only connection, use the CLI setup section of the README and the installed runner's help for its current MCP commands. `.mcp.json` is not an initialization output; the example JSON is documentation, not proof of a connection.

**Done when:** a fresh connection check reports the selected runner signed in and official PostHog tools connected. A configured server name alone does not satisfy this step.

## 5. Establish product context

Set the actual PostHog project ID and region in Setup. Draft `.rusubon/context.md` from the product's routes, documentation, and the user's explanation, following [the context template](templates/context.md). Replace template examples with real product paths and clearly label uncertain assumptions.

Present the proposed money paths, intentional friction, and exclusions to the user. Keep `RUSUBON_CONTEXT_PLACEHOLDER` in an unreviewed draft. Remove it, or select the dashboard confirmation checkbox, only after the user confirms those details. Existing confirmed context can be reused; confirmation of installation is not confirmation of new product assumptions. Save setup after confirmation. If the dashboard reports an external edit, reload and reconcile it before saving.

The agent-backed context-draft command is optional and consumes the selected runner's usage. When requested, follow [Use the CLI directly](README.md#use-the-cli-directly); its output still requires human review.

**Done when:** every context section describes the product, the user has confirmed money paths and intentional friction, and saved context is no longer marked as a placeholder. If confirmation is pending, report that specific blocker while preserving the draft.

## 6. Select and verify

In Runs, select an available scout model and one of its enabled effort options after refreshing the connection. Reuse the user's supported preferences or an available default when none were specified. If an explicit selection is unavailable, explain the supported alternatives. Model IDs and effort support come from the installed runner and Rusubon's role allowlist, not from this guide. For Claude, also verify the session-review model in Setup; that phase uses `low` effort.

Choose the investigation period, confirmed money paths, checks, and optional additional context. Inspect the UTC bounds and baseline shown by the form. Save setup to persist the selections, then reload and confirm they remain.

In Setup, keep **Agent permissions → Auto** unless the user specifies another mode or has an existing explicit choice. Save and reload to verify it. See [Agent permissions](README.md#agent-permissions) for how Auto, Ask, and YOLO affect the dashboard and CLI.

Research is optional. If requested, configure spec creator and implementation independently in Research, using the live options for each role, and save setup. Follow [Research-to-PR execution](docs/inbox-contract.md#research-to-pr-execution) for its additional prerequisites. Scout readiness does not establish research readiness.

Run preflight from the product directory:

```sh
cd "$PRODUCT_DIR"
node "$RUSUBON_DIR/bin/rusubon.mjs" doctor
```

Fix each reported failure and rerun. Preflight may stop at local configuration failures, so those results do not yet verify login or MCP. Use [If you get stuck](README.md#if-you-get-stuck) for launch and connection failures.

**Done when:** `doctor` exits zero with all checks passing, the reloaded dashboard retains the intended setup, and **Launch scout** is enabled for the selected scope and model. Leave launching to the user's request; preflight does not prove that the project has usable event or recording data.

## 7. Hand off

Report the product path, files changed, runner/model/effort, PostHog project and region, and actual preflight result. Include the live local URL, the terminal/session keeping it alive, and the absolute restart command from step 3. Explain that closing the browser leaves it running and Ctrl-C in that terminal stops the dashboard and active workers.

If any completion criterion is unmet, say **Setup incomplete** and name the exact next user action. Otherwise say **Ready to launch** and state whether a live scout has been run. Leave product-repository commits and publishing to the user's existing authorization.
