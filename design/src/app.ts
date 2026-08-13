import { scenarios } from "./scenarios"
import { createTerminalView } from "./terminal-view"
import type { Scenario, SessionMode, TerminalLine } from "./terminal"

const outputDelayMs = 140

export function startApp(): void {
    const scenarioSelect = requireElement<HTMLSelectElement>("#scenario-select")
    const replayButton = requireElement<HTMLButtonElement>("#replay-button")
    const terminalViewport = requireElement<HTMLElement>("#terminal-viewport")
    const terminalOutput = requireElement<HTMLElement>("#terminal-output")
    const sessionStatus = requireElement<HTMLElement>("#session-status")
    const sessionInputs = document.querySelectorAll<HTMLInputElement>('input[name="session-mode"]')
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const terminal = createTerminalView(terminalViewport, terminalOutput)

    let playbackController: AbortController | undefined

    const selectedScenario = (): Scenario =>
        scenarios.find((scenario) => scenario.id === scenarioSelect.value) ?? scenarios[0]!

    const selectedMode = (): SessionMode => {
        const selected = Array.from(sessionInputs).find((input) => input.checked)
        return selected?.value === "redirected" ? "redirected" : "interactive"
    }

    const updateSessionStatus = (): void => {
        const scenario = selectedScenario()
        const mode = selectedMode()
        sessionStatus.textContent = mode === "redirected" ? "Redirected" : "Interactive TTY"
        terminal.setLabel(scenario.label)
    }

    const playStreamingLines = async (lines: TerminalLine[], signal: AbortSignal): Promise<void> => {
        if (reducedMotion.matches) {
            terminal.renderLines(lines)
            return
        }
        const visible: TerminalLine[] = []
        for (const item of lines) {
            await pause(260, signal)
            visible.push(item)
            terminal.renderLines(visible)
        }
    }

    const playSelectedScenario = async (): Promise<void> => {
        playbackController?.abort()
        const controller = new AbortController()
        playbackController = controller
        const scenario = selectedScenario()
        const mode = selectedMode()
        updateSessionStatus()
        terminal.reset()
        terminal.beginOutput(scenario.command, mode === "interactive")
        replayButton.classList.add("is-playing")
        replayButton.disabled = true

        try {
            await pause(outputDelayMs, controller.signal)
            if (scenario.delivery === "instant") {
                terminal.renderLines(scenario.lines)
            } else {
                await playStreamingLines(scenario.lines, controller.signal)
            }
            if (mode === "interactive") terminal.renderEmptyPrompt()
            if (scenario.startAtTop === true) terminal.scrollToTop()
        } catch (error) {
            if (!isAbortError(error)) throw error
        } finally {
            if (playbackController === controller) {
                replayButton.classList.remove("is-playing")
                replayButton.disabled = false
            }
        }
    }

    populateScenarioSelect(scenarioSelect)
    updateSessionStatus()
    void playSelectedScenario()

    scenarioSelect.addEventListener("change", () => {
        void playSelectedScenario()
    })

    replayButton.addEventListener("click", () => void playSelectedScenario())

    for (const input of sessionInputs) {
        input.addEventListener("change", () => {
            updateSessionStatus()
            void playSelectedScenario()
        })
    }

    reducedMotion.addEventListener("change", () => void playSelectedScenario())
}

function populateScenarioSelect(scenarioSelect: HTMLSelectElement): void {
    const groups = new Map<string, HTMLOptGroupElement>()
    for (const scenario of scenarios) {
        let group = groups.get(scenario.group)
        if (group === undefined) {
            group = document.createElement("optgroup")
            group.label = scenario.group
            groups.set(scenario.group, group)
            scenarioSelect.append(group)
        }
        const option = document.createElement("option")
        option.value = scenario.id
        option.textContent = scenario.label
        group.append(option)
    }
}

function pause(durationMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason)
            return
        }

        const timeout = window.setTimeout(() => {
            signal.removeEventListener("abort", abort)
            resolve()
        }, durationMs)
        const abort = () => {
            window.clearTimeout(timeout)
            reject(new DOMException("Playback aborted", "AbortError"))
        }
        signal.addEventListener("abort", abort, { once: true })
    })
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError"
}

function requireElement<ElementType extends Element>(selector: string): ElementType {
    const element = document.querySelector<ElementType>(selector)
    if (element === null) throw new Error(`Missing element: ${selector}`)
    return element
}
