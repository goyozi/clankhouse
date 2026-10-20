import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, onTestFinished, test } from "vitest"
import { LinearClient } from "../src/linear"
import { issue } from "./fakes"

type GraphQLRequest = { query: string; variables: Record<string, unknown> }
type GraphQLResponse = { data?: unknown; errors?: Array<{ message: string }> }

test("returns assigned issues from every page", async () => {
    // given a Linear API with two pages of assigned issues
    const pages: Record<string, GraphQLResponse> = {
        first: assignedIssuesPage([issue({ id: "issue-1", identifier: "ENG-1" })], "cursor-1"),
        "cursor-1": assignedIssuesPage([issue({ id: "issue-2", identifier: "ENG-2" })], null)
    }
    const { url, requests } = await linearApi((request) => pages[String(request.variables.after ?? "first")])

    // when assigned Todo issues of a team are requested
    const issues = await new LinearClient("lin_api_test", { url }).assignedIssues({ state: "Todo", team: "ENG" })

    // then the issues from both pages are returned
    expect(issues).toEqual([
        issue({ id: "issue-1", identifier: "ENG-1" }),
        issue({ id: "issue-2", identifier: "ENG-2" })
    ])
    // and the second page is requested after the first page's cursor with the same filter
    expect(requests.map(({ variables }) => variables)).toEqual([
        { filter: todoInEng, first: 250, after: null },
        { filter: todoInEng, first: 250, after: "cursor-1" }
    ])
})

test("fails to move an issue whose team is unavailable", async () => {
    // given a Linear API that doesn't find the issue's team
    const { url, requests } = await linearApi(() => ({ data: { team: null } }))

    // when the issue is moved
    const moving = new LinearClient("lin_api_test", { url }).moveIssue(issue(), "In Progress")

    // then it fails naming the unavailable team
    await expect(moving).rejects.toThrow("Linear team team-1 of ENG-42 doesn't exist or isn't accessible")
    // and the issue isn't updated
    expect(requests).toHaveLength(1)
})

const todoInEng = { state: { name: { eq: "Todo" } }, team: { key: { eq: "ENG" } } }

function assignedIssuesPage(issues: ReturnType<typeof issue>[], endCursor: string | null): GraphQLResponse {
    return {
        data: {
            viewer: {
                assignedIssues: {
                    nodes: issues.map(({ teamId, ...rest }) => ({ ...rest, team: { id: teamId } })),
                    pageInfo: { hasNextPage: endCursor !== null, endCursor }
                }
            }
        }
    }
}

async function linearApi(
    respond: (request: GraphQLRequest) => GraphQLResponse | undefined
): Promise<{ url: string; requests: GraphQLRequest[] }> {
    const requests: GraphQLRequest[] = []
    const server = createServer(async (incoming, outgoing) => {
        let body = ""
        for await (const chunk of incoming) body += chunk
        const request = JSON.parse(body) as GraphQLRequest
        requests.push(request)
        const response = respond(request)
        outgoing.writeHead(response === undefined ? 404 : 200, { "Content-Type": "application/json" })
        outgoing.end(JSON.stringify(response ?? { errors: [{ message: "Unexpected request" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}/graphql`, requests }
}
