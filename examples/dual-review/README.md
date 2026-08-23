# Dual Review

Reviews uncommitted code changes with both Claude and Codex, and presents a final Act/Skip recommendation list.

**Caution:** This runs Claude hooks configured in the repository. Only use on repos you trust or modify the workflow to
pass `settingSources: []`.

## Try It

If you don't have `clank` installed or want to use the source version:

```sh
export CLANKHOUSE_SOURCE=/absolute/path/to/clankhouse
alias clank='pnpm --dir "$CLANKHOUSE_SOURCE" --filter @clankhouse/cli exec node bin/clank.js'
```

Start the server:

```sh
pnpm --dir "$CLANKHOUSE_SOURCE" --filter @clankhouse/example-dual-review start
```

Trigger a review:

```sh
jq -n --arg repositoryPath "$PWD" '{ repositoryPath: $repositoryPath }' |
    clank run dual-review --input - |
    jq -r .
```

Or create a reusable shell function:

```sh
dualreview() {
    (
        set -o pipefail
        jq -n --arg repositoryPath "$PWD" '{ repositoryPath: $repositoryPath }' |
            clank run dual-review --input - |
            jq -r .
    )
}
```

And then:

```sh
dualreview
```
