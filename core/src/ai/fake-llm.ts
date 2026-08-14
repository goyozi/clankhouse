import { BaseLanguageModel, type LanguageModelInvocation } from "./base-llm"

export class FakeLLM extends BaseLanguageModel {
    readonly client = "fake-llm"
    readonly provider = "fake"
    readonly model = "fake"
    private readonly fakeCall: (stepName: string, prompt: string) => unknown

    constructor(fakeCall: (stepName: string, prompt: string) => unknown) {
        super()
        this.fakeCall = fakeCall
    }

    protected async invoke({ stepName, prompt, session }: LanguageModelInvocation): Promise<unknown> {
        session.addMessage("user", prompt)
        const output = this.fakeCall(stepName, prompt)
        session.addMessage("assistant", JSON.stringify(output))
        return output
    }
}
