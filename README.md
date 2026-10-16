# omp-council

`/council` convenes several models on one problem in [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`). They analyze it independently, debate through a structured ledger, and stop only when every member accepts the exact same version of one proposal and an independent verification round confirms it. The ledger (code), not a model, decides consensus, and mixing model families gives the debate real disagreement. It is a plain omp extension: the stock `omp` binary loads it, and nothing in omp is patched.

## Install

```sh
# From npm
omp plugin install omp-council

# From GitHub (append a tag such as #v0.1.0 to pin a release; a pinned install is not auto-updated)
omp plugin install github:brndnmtthws/omp-council

# From a local checkout for development (edits apply on the next omp restart)
omp plugin link /path/to/omp-council
```

Restart omp afterwards; extensions load at startup. `omp plugin list` shows `omp-council`; `omp plugin uninstall omp-council` removes it.

## Usage

```text
/council                      # setup: add/remove members, budgets, presets, start
/council <problem>            # run with the saved members
/council stop                 # cancel the running council
/councilpreset                # pick a saved preset to switch to
/councilpreset save <name>    # save the current members and budgets as a preset
/councilpreset switch <name>  # make a preset the current council
/councilpreset delete <name>  # delete a preset
/councilpreset list           # list presets; the active one is marked
```

While a council runs, a live board above the editor shows each member's activity, proposals, and spend; the editor stays usable. When it ends, the report is posted to the conversation: the agreed solution with every member's verification, or the state of play if it stopped early.

- Full transcript: `local://council/<runId>/`
- Each member's session: `history://Council<Name>`

## Setup

- **Members:** Any model you have credentials for (the picker is type-to-filter). A council needs at least two members. A model can sit twice under different names. Select a member in the setup menu to remove it.
- **Budgets:** Optional max rounds, minutes, tokens, and USD. Unlimited by default.
- **Presets:** Named councils (members plus budgets) to switch between, like omp's model presets. Save the current council from the setup menu's `★ Presets…` entry or with `/councilpreset save <name>`. Saving needs at least two members, and preset names start with a letter, then letters, digits, `-` or `_`. Switching replaces the current members and budgets wholesale; a budget the preset leaves unset becomes unlimited. `/council <problem>` then runs with them. A preset whose members and budgets match the current council shows as active. Picking a preset from the menu or from the bare `/councilpreset` picker asks first when the current council is not saved as any preset; a typed `/councilpreset switch <name>` does not ask.
- **Config:** Saved to `~/.omp/agent/council.json` (the active profile's agent dir), shared by every project. Hand edits are fine; a member may carry a `persona`, and `presets` holds the saved councils:

```json
{
	"members": [
		{ "name": "Claude", "model": "anthropic/claude-opus-4-6:high" },
		{ "name": "GPT", "model": "openai/gpt-5.2", "persona": "Challenge every assumption." }
	],
	"maxMinutes": 30,
	"presets": {
		"cheap": {
			"members": [{ "model": "anthropic/claude-haiku-4-5" }, { "model": "openai/gpt-5-mini" }],
			"maxCostUsd": 1
		}
	}
}
```

## How a council runs

1. **Independent analysis:** Members work in parallel on the problem plus recent conversation context, blind to each other, and each records one proposal.
2. **Debate:** Round-robin turns. Each member sees what changed since its last turn and acts through ledger tools: propose, revise, challenge, respond, resolve, withdraw, accept. A revision clears every acceptance of that proposal.
3. **Verification:** Once everyone accepts the same version, each member confirms or rejects it independently. All confirm: consensus. Any rejection becomes a challenge and the debate resumes.

## Safety

Members get read-only file, search, AST, and web tools (`read`, `grep`, `glob`, `ast_grep`, `web_search`), `bash` for diagnostics, and the council tools. They have no edit or write tools, and their instructions forbid modifying the project (scratch files go in `mktemp -d`). `bash` is omp's stock tool, so this boundary is an instruction, not a sandbox.

## Compatibility

omp has no stable plugin API covering what Council needs, so `omp-council` imports omp's internal modules directly, e.g. `@oh-my-pi/pi-coding-agent/config/model-resolver`, `.../registry/agent-registry`, `.../session/session-context`, `.../task/output-manager`, `.../internal-urls/local-protocol`. Any omp release may change them.

Tested with omp 18.11.1; the `@oh-my-pi/pi-coding-agent` devDependency in `package.json` pins the tested version. A newer omp can break the plugin until it is updated; when that happens, open an issue that includes your `omp --version`.

At runtime the omp binary serves its own bundled copies of these modules; the dev dependencies only provide types and test fixtures. The long-term plan is to merge Council into omp itself, which removes this coupling.

## Develop

```sh
bun install
bun run check   # type-check against the omp packages, lint, format check
bun test
```

`omp plugin link .` from the checkout runs it in your omp. To test against another omp release, set the `@oh-my-pi/pi-coding-agent` devDependency to that version.

### Releasing

Releases publish to npm from CI, never by hand. Bump `version` in `package.json`, commit and push to `main`, then create a GitHub release:

```sh
gh release create v<version> --generate-notes
```

Publishing the GitHub release runs the Release workflow (`.github/workflows/release.yml`). It fails unless the release tag is `v` plus the `package.json` version, runs `bun run check` and `bun test`, then publishes through npm trusted publishing: no npm token is stored, and npm attaches provenance. A version that is already on npm is skipped.

## License

MIT (see `LICENSE`).
