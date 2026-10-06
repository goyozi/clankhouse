# `clankhouse`

The `clank` command-line client for interacting with a ClankHouse server.

## Installation

Node.js 22.x or newer is required.

```sh
pnpm add --global clankhouse
```

Then run `clank --help` to see the available commands.

## Usage

`clank` talks to the ClankHouse server your workflow project starts with
[`serve()`](https://www.npmjs.com/package/@clankhouse/server).

```sh
clank workflows list
clank run <workflow> --input input.json      # start a run and print its output
clank ps                                     # running runs
clank runs watch <run-id>
clank runs get <run-id> --include sessions   # what each agent did
clank runs resume <run-id>                   # continue an interrupted or failed run
clank runs rerun <run-id> --from fix-1       # rerun from a given step on
clank events emit <key> --input -            # e.g. send a human approval
```

See the [main README](https://github.com/goyozi/clankhouse/blob/main/README.md) for a full walkthrough and concepts.
