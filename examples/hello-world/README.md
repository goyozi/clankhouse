# Hello, World!

Basic workflow that sets up a temporary Git repository and asks an agent to implement a "Hello, World!" program inside.

## Try It

If you don't have `clank` installed or want to use the source version:

```sh
alias clank="pnpm --filter @clankhouse/cli exec node bin/clank.js"
```

Start the server:

```sh
pnpm --filter @clankhouse/example-hello-world start
```

Start and watch a run:

```sh
RUN_ID=$(clank runs start hello-world)
clank runs get $RUN_ID --watch --include sessions
```
