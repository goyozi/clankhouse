# Dual Review

Reviews uncommitted code changes with both Claude and Codex, and presents a final Act/Skip recommendation list.

**Caution:** This runs Claude hooks configured in the repository. Only use on repos you trust or modify the workflow to
pass `sdkOptions: { settingSources: [] }`.

## Try It

You'll need Node.js 22.19 or newer, Git, [Claude Code](https://claude.com/product/claude-code) and
[Codex](https://openai.com/codex/) signed in, and the `clank` CLI:

```sh
npm install --global clankhouse
```

Copy this example and install its dependencies:

```sh
npx giget@latest gh:goyozi/clankhouse/examples/dual-review dual-review
cd dual-review
npm install
```

Start the server:

```sh
npm start
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

## Test It

```sh
npm test
```

The tests swap the agents for fakes from [`@clankhouse/testing`](https://github.com/goyozi/clankhouse/tree/main/testing),
so they run offline and make no AI calls.
