# Dual Review

Reviews uncommitted code changes with both Claude and Codex, and presents a final Act/Skip recommendation list.

**Caution:** This runs Claude hooks configured in the repository. Only use on repos you trust or modify the workflow to
pass `settingSources: []`.

## Try It

If you don't have `loopy` installed or want to use the source version:

```sh
export LOOPY_SOURCE=/absolute/path/to/loopy
alias loopy='pnpm --dir "$LOOPY_SOURCE" --filter @loopy/cli exec node bin/loopy.js'
```

Start the server:

```sh
pnpm --dir "$LOOPY_SOURCE" --filter @loopy/example-dual-review start
```

Trigger a review:

```sh
jq -n --arg repositoryPath "$PWD" '{ repositoryPath: $repositoryPath }' |
    loopy run dual-review --input - |
    jq -r .
```

Or create a reusable shell function:

```sh
dualreview() {
    (
        set -o pipefail
        jq -n --arg repositoryPath "$PWD" '{ repositoryPath: $repositoryPath }' |
            loopy run dual-review --input - |
            jq -r .
    )
}
```

And then:

```sh
dualreview
```
