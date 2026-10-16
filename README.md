# omp-council

A council for [oh-my-pi](https://github.com/can1357/oh-my-pi): several models investigate one problem independently, then debate through a structured ledger until **every member accepts the exact same version of one proposal** and an independent verification round confirms it. The ledger, not a model, decides consensus.

It is a plain omp extension. The stock `omp` binary loads it; nothing is patched.

## Install

```sh
omp plugin link /path/to/omp-council   # a local checkout; edits apply on restart
```

Restart omp. `omp plugin list` shows `omp-council`; `omp plugin uninstall omp-council` removes it. `omp plugin install` also accepts git and npm specs once the repo is published.

## Use

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

- **Members:** any model you have credentials for (type to filter). A model can sit twice under different names; mixing model families gives the debate real disagreement. Select a member in the menu to remove it.
- **Budgets:** optional max rounds, minutes, tokens, and USD. Unlimited by default.
- **Presets:** named councils (members plus budgets) to switch between, like omp's model presets. Save the current council from the setup menu's `★ Presets…` or with `/councilpreset save <name>`. Switching replaces the current members and budgets wholesale, and `/council <problem>` then runs with them. A preset whose members and budgets match the current council shows as active; names start with a letter, then letters, digits, `-` or `_`.
- **Config:** saved to `~/.omp/agent/council.json` (your active profile's agent dir). Hand edits are fine; a member may carry a `persona`, and `presets` holds the saved councils:

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

While it runs, a live board above the editor shows each member's activity, proposals, and spend; the editor stays usable. When it ends, the report (agreed solution with every member's verification, or the state of play if it stopped early) is posted to the conversation. The full transcript is under `local://council/<runId>/`, and each member's session is at `history://Council<Name>`.

## How a council runs

1. **Independent analysis.** Members work in parallel on the problem plus recent conversation context, blind to each other, and each records one proposal.
2. **Debate.** Round-robin turns. Each member sees what changed since its last turn and acts through ledger tools: propose, revise, challenge, respond, resolve, withdraw, accept. A revision clears every acceptance of that proposal.
3. **Verification.** Once everyone accepts the same version, each member confirms or rejects it independently. All confirm: consensus. Any rejection becomes a challenge and the debate resumes.

## Safety

Members get read-only file, search, AST, and web tools, `bash` for diagnostics, and the council tools. They have no edit or write tools, and their instructions forbid modifying the project (scratch files go in `mktemp -d`). `bash` is the stock tool, so this boundary is an instruction, not a sandbox.

## Develop

```sh
bun install
bun run check   # type-check against the omp packages
bun test
```

The extension imports omp's own modules (`@oh-my-pi/*`); the omp binary serves its bundled copies at runtime, so the dev dependencies only provide types and test fixtures. Pin them to the omp release you run.
