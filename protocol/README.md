# `@clankhouse/protocol`

The Protocol Buffers definitions and generated TypeScript descriptors shared by ClankHouse clients and servers.

## Installation

```sh
pnpm add @clankhouse/protocol
```

## Usage

Use `ClankHouseService` with [Connect](https://connectrpc.com/) to build your own client. The API key is in
`~/.clankhouse/credentials.json`.

```ts
import { createClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-node"
import { ClankHouseService } from "@clankhouse/protocol"

const client = createClient(
    ClankHouseService,
    createConnectTransport({
        httpVersion: "1.1",
        baseUrl: "http://127.0.0.1:7331",
        interceptors: [
            (next) => (request) => {
                request.header.set("authorization", `Bearer ${apiKey}`)
                return next(request)
            }
        ]
    })
)

const { workflows } = await client.listWorkflows({})
```

The `.proto` sources are published under `@clankhouse/protocol/proto/*`.

See the [main README](https://github.com/goyozi/clankhouse/blob/main/README.md) for a full walkthrough and concepts.
