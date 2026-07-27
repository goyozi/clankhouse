# Hello, World!

Basic workflow that sets up a temporary Git repository and asks an agent to implement a "Hello, World!" program inside.

## Try It

If you don't have `loopy` installed or want to use the source version:

```sh
alias loopy="pnpm --filter @loopy/cli exec node bin/loopy.js"
```

Start the server:

```sh
pnpm --filter @loopy/example-hello-world start
```

Start and watch a run:

```sh
RUN_ID=$(loopy runs start hello-world)
loopy runs get $RUN_ID --watch --include sessions
```
