import type { ConversationOptions, Herdr } from "../src/herdr"
import type { IssueQuery, Linear, LinearIssue } from "../src/linear"

type StoredIssue = { issue: LinearIssue; state: string }

export class FakeLinear implements Linear {
    readonly queries: IssueQuery[] = []
    private readonly issues = new Map<string, StoredIssue>()

    add(issue: LinearIssue, state: string): void {
        this.issues.set(issue.id, { issue, state })
    }

    stateOf(id: string): string | undefined {
        return this.issues.get(id)?.state
    }

    async assignedIssues(query: IssueQuery): Promise<LinearIssue[]> {
        this.queries.push(query)
        return [...this.issues.values()].filter(({ state }) => state === query.state).map(({ issue }) => issue)
    }

    async moveIssue(issue: LinearIssue, stateName: string): Promise<void> {
        const stored = this.issues.get(issue.id)
        if (stored === undefined) throw new Error(`Unknown issue ${issue.identifier}`)
        stored.state = stateName
    }
}

export class FakeHerdr implements Herdr {
    readonly conversations: ConversationOptions[] = []
    failure: Error | undefined

    async openConversation(options: ConversationOptions): Promise<void> {
        if (this.failure) throw this.failure
        this.conversations.push(options)
    }
}

export function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
    return {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Fix the login form",
        description: "The submit button does nothing.",
        url: "https://linear.app/acme/issue/ENG-42",
        teamId: "team-1",
        ...overrides
    }
}
