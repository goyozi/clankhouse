import type { ActiveEventSource } from "@clankhouse/core"
import * as z from "zod"

export const LinearIssue = z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    url: z.string(),
    teamId: z.string()
})
export type LinearIssue = z.infer<typeof LinearIssue>

export type IssueQuery = { state: string; team?: string }

export interface Linear {
    assignedIssues(query: IssueQuery): Promise<LinearIssue[]>
    moveIssue(issue: LinearIssue, stateName: string): Promise<void>
}

const LINEAR_API_URL = "https://api.linear.app/graphql"
const ASSIGNED_ISSUES_PAGE_SIZE = 250

const ASSIGNED_ISSUES = `
    query AssignedIssues($filter: IssueFilter, $first: Int!, $after: String) {
        viewer {
            assignedIssues(filter: $filter, first: $first, after: $after) {
                nodes { id identifier title description url team { id } }
                pageInfo { hasNextPage endCursor }
            }
        }
    }
`

const TEAM_STATES = `
    query TeamStates($teamId: String!, $name: String!) {
        team(id: $teamId) {
            key
            states(filter: { name: { eq: $name } }) { nodes { id } }
        }
    }
`

const UPDATE_ISSUE_STATE = `
    mutation UpdateIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }
`

type AssignedIssuesData = {
    viewer: {
        assignedIssues: {
            nodes: Array<Omit<LinearIssue, "teamId"> & { team: { id: string } }>
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
    }
}

type TeamStatesData = { team: { key: string; states: { nodes: Array<{ id: string }> } } | null }

type UpdateIssueStateData = { issueUpdate: { success: boolean } }

export class LinearClient implements Linear {
    private readonly apiKey: string
    private readonly url: string

    constructor(apiKey: string, { url = LINEAR_API_URL }: { url?: string } = {}) {
        this.apiKey = apiKey
        this.url = url
    }

    async assignedIssues({ state, team }: IssueQuery): Promise<LinearIssue[]> {
        const filter = {
            state: { name: { eq: state } },
            ...(team === undefined ? {} : { team: { key: { eq: team } } })
        }
        const issues: LinearIssue[] = []
        let after: string | null = null
        do {
            const data: AssignedIssuesData = await this.request<AssignedIssuesData>(ASSIGNED_ISSUES, {
                filter,
                first: ASSIGNED_ISSUES_PAGE_SIZE,
                after
            })
            const { nodes, pageInfo } = data.viewer.assignedIssues
            issues.push(...nodes.map(({ team, ...issue }) => ({ ...issue, teamId: team.id })))
            after = pageInfo.hasNextPage ? pageInfo.endCursor : null
        } while (after !== null)
        return issues
    }

    async moveIssue(issue: LinearIssue, stateName: string): Promise<void> {
        const { team } = await this.request<TeamStatesData>(TEAM_STATES, { teamId: issue.teamId, name: stateName })
        if (team === null) {
            throw new Error(`Linear team ${issue.teamId} of ${issue.identifier} doesn't exist or isn't accessible`)
        }
        const state = team.states.nodes[0]
        if (state === undefined) {
            throw new Error(`Linear team ${team.key} has no workflow state named "${stateName}"`)
        }
        const { issueUpdate } = await this.request<UpdateIssueStateData>(UPDATE_ISSUE_STATE, {
            id: issue.id,
            stateId: state.id
        })
        if (!issueUpdate.success) throw new Error(`Linear did not move ${issue.identifier} to "${stateName}"`)
    }

    private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const response = await fetch(this.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: this.apiKey },
            body: JSON.stringify({ query, variables })
        })
        const body = (await response.json().catch(() => undefined)) as
            { data?: T; errors?: Array<{ message: string }> } | undefined
        if (body?.errors?.length) {
            throw new Error(`Linear API error: ${body.errors.map((error) => error.message).join("; ")}`)
        }
        if (!response.ok) throw new Error(`Linear API responded with ${response.status} ${response.statusText}`)
        if (body?.data === undefined) throw new Error("Linear API response has no data")
        return body.data
    }
}

export function linearIssues(
    client: Linear,
    { state, team, intervalMs = 60_000 }: IssueQuery & { intervalMs?: number }
): ActiveEventSource<typeof LinearIssue> {
    return {
        key: `linear-issues:${state}:${team ?? "*"}`,
        schema: LinearIssue,
        start: (listener) => {
            let polling = false
            const poll = async () => {
                if (polling) return
                polling = true
                try {
                    const issues = await client.assignedIssues({ state, team })
                    for (const issue of issues) listener.emit(issue)
                } catch (error) {
                    listener.fail(error)
                } finally {
                    polling = false
                }
            }
            void poll()
            const timer = setInterval(poll, intervalMs)
            return { stop: () => clearInterval(timer) }
        }
    }
}
