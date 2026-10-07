# Factory

A small software factory: drop a Markdown task into a folder and get it implemented, reviewed by Claude & Codex,
and tested, with the resulting changes waiting uncommitted in your working tree.

**Caution:** This runs Claude hooks configured in the repository. Only use on repos you trust.

## Try It

You'll need Node.js 22.19 or newer, Git, [Claude Code](https://claude.com/product/claude-code) and
[Codex](https://openai.com/codex/) signed in, and the `clank` CLI:

```sh
npm install --global clankhouse
```

Copy this example and install its dependencies:

```sh
npx giget@latest gh:goyozi/clankhouse/examples/factory factory
cd factory
npm install
```

Start the server with the repositories to watch:

```sh
npm start -- ~/src/my-app
```

Each repository gets a `factory/` directory:

```
factory/
├── requirements/    draft tasks here
├── implementation/  move a task here to start a run
├── done/            finished tasks end up here
└── testing.md       optional: how to test the running application
```

Ignore the task directories in `.gitignore`:

```gitignore
factory/requirements/
factory/implementation/
factory/done/
```

Write a task and start it (the working tree must be clean by the time the changes are applied):

```sh
cd ~/src/my-app
echo "Add a --version flag to the CLI." > factory/requirements/add-version-flag.md
mv factory/requirements/add-version-flag.md factory/implementation/
```

Watch the run:

```sh
clank runs list --workflow factory
clank runs get <run-id> --watch --include sessions
```

## Play With It

Prompts live in `src/prompts/` and the agents are picked in `src/index.ts`. After tweaking a prompt, discard the applied
changes and rerun from the step you changed, reusing everything before it:

```sh
clank runs rerun <run-id> --from code-review-round-1/review-code-1
```

## Test It

```sh
npm test
```

The tests swap the agents for fakes from [`@clankhouse/testing`](https://github.com/goyozi/clankhouse/tree/main/testing),
so they run offline and make no AI calls.
