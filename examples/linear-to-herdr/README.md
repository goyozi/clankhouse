# Linear to Herdr

Pick up your Linear issues in a coding agent: when an issue assigned to you is in `Todo`, open a
[Herdr](https://herdr.dev) workspace in your repository, start a coding agent there with a prompt about the issue, and
move the issue to `In Progress`. Take the conversation from there.

## Try It

You'll need Node.js 22.19 or newer, [Herdr](https://herdr.dev), the coding agent you pick (Claude Code by default)
signed in, a Linear [personal API key](https://linear.app/settings/account/security), and the `clank` CLI:

```sh
npm install --global clankhouse
```

Copy this example and install its dependencies:

```sh
npx giget@latest gh:goyozi/clankhouse/examples/linear-to-herdr linear-to-herdr
cd linear-to-herdr
npm install
```

Configure it by copying `.env.example` to `.env`, then set your API key and the repository to work in:

```sh
cp .env.example .env
```

Start the server:

```sh
npm start
```

Linear is polled every minute. Each `Todo` issue assigned to you gets a Herdr workspace labeled with its identifier
(e.g. `ENG-42`), where the agent is waiting with its first question about the scope.

Watch the runs:

```sh
clank runs list --workflow linear-to-herdr
clank runs get <run-id> --watch
```

If Herdr fails, the run fails and the issue stays in `Todo`. Fix the cause and rerun it from the failed step, e.g.
`open-conversation`, or `move-to-in-progress` if only moving the issue failed, so a conversation that's already open
isn't opened again:

```sh
clank runs rerun <run-id> --from open-conversation
```

## Play With It

The prompt lives in `src/prompts/`, and the Linear state names and poll interval are set in `src/index.ts`.

Pick another Herdr agent kind, or only pick up issues from one team, in `.env`:

```sh
AGENT=codex
LINEAR_TEAM=ENG
```

To experiment without cluttering your main Herdr session, start a separate one:

```sh
herdr session attach linear-to-herdr
```

And point the example at it in `.env`:

```sh
HERDR_SESSION_ID=linear-to-herdr
```

To pass environment variables to the agent, e.g. a separate Claude Code config, set them in `.env` and list them in
`AGENT_ENV`:

```sh
CLAUDE_CONFIG_DIR=~/.claude-work
AGENT_ENV=CLAUDE_CONFIG_DIR
```

## Test It

```sh
npm test
```

The tests swap Linear and Herdr for in-memory fakes, so they run offline and don't touch your issues or Herdr sessions.
