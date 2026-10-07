# Hello, World!

Basic workflow that sets up a temporary Git repository and asks an agent to implement a "Hello, World!" program inside.

## Try It

You'll need Node.js 22.19 or newer, Git, [Codex](https://openai.com/codex/) signed in, and the `clank` CLI:

```sh
npm install --global clankhouse
```

Copy this example and install its dependencies:

```sh
npx giget@latest gh:goyozi/clankhouse/examples/hello-world hello-world
cd hello-world
npm install
```

Start the server:

```sh
npm start
```

In another terminal, start and watch a run:

```sh
RUN_ID=$(clank runs start hello-world)
clank runs get $RUN_ID --watch --include sessions
```

## Test It

```sh
npm test
```

The tests swap the agents for fakes from [`@clankhouse/testing`](https://github.com/goyozi/clankhouse/tree/main/testing),
so they run offline and make no AI calls.
