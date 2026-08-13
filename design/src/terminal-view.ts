import type { TerminalLine } from "./terminal"

export type TerminalView = {
    reset(): void
    beginOutput(command: string, showPrompt: boolean): void
    renderLines(lines: TerminalLine[]): void
    renderEmptyPrompt(): void
    scrollToTop(): void
    setLabel(label: string): void
}

export function createTerminalView(viewport: HTMLElement, output: HTMLElement): TerminalView {
    let renderedLines: TerminalLine[] = []

    const followOutput = (): void => {
        viewport.scrollTop = viewport.scrollHeight
    }

    const body = (): HTMLElement => {
        const element = output.querySelector<HTMLElement>("#terminal-body")
        if (element === null) throw new Error("Missing element: #terminal-body")
        return element
    }

    return {
        reset() {
            renderedLines = []
            output.replaceChildren()
            viewport.scrollTop = 0
            viewport.scrollLeft = 0
        },
        beginOutput(command, showPrompt) {
            if (showPrompt) {
                const prompt = document.createElement("div")
                prompt.className = "terminal-prompt-line"
                appendPrompt(prompt, command)
                output.append(prompt)
            }

            const terminalBody = document.createElement("div")
            terminalBody.id = "terminal-body"
            output.append(terminalBody)
        },
        renderLines(lines) {
            let stableLineCount = 0
            while (stableLineCount < renderedLines.length && stableLineCount < lines.length) {
                const rendered = renderedLines[stableLineCount]!
                const next = lines[stableLineCount]!
                if (rendered.text !== next.text || rendered.depth !== next.depth) break
                stableLineCount += 1
            }

            const terminalBody = body()
            while (terminalBody.children.length > stableLineCount) terminalBody.lastElementChild?.remove()

            const fragment = document.createDocumentFragment()
            for (const item of lines.slice(stableLineCount)) {
                const element = document.createElement("div")
                element.className = item.text.length === 0 ? "terminal-line terminal-line-blank" : "terminal-line"
                element.textContent = `${"  ".repeat(item.depth ?? 0)}${item.text}`
                fragment.append(element)
            }
            terminalBody.append(fragment)
            renderedLines = lines.map((line) => ({ ...line }))
            followOutput()
        },
        renderEmptyPrompt() {
            const prompt = document.createElement("div")
            prompt.className = "terminal-prompt-line"
            appendPrompt(prompt)
            body().append(prompt)
            followOutput()
        },
        scrollToTop() {
            viewport.scrollTop = 0
        },
        setLabel(label) {
            output.setAttribute("aria-label", `Simulated Loopy output for ${label}`)
        }
    }
}

function appendPrompt(parent: HTMLElement, command?: string): void {
    const symbol = document.createElement("span")
    symbol.className = "terminal-prompt-symbol"
    symbol.textContent = "$"
    parent.append(symbol)
    if (command !== undefined) parent.append(` ${command}`)
}
