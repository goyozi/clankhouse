import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import { renderPrompt } from "../core/ai/prompt";
import { tempDir } from "./helpers";

test("relative prompt files resolve against the project root", async () => {
    // given a temp project with a prompts/greet.md template file
    const project = tempDir("loopy-project-");
    fs.writeFileSync(path.join(project, "package.json"), "{}");
    fs.mkdirSync(path.join(project, "prompts"));
    fs.writeFileSync(path.join(project, "prompts", "greet.md"), "Hello {{name}}!");
    // and a nested working directory inside the project
    const sub = path.join(project, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const previous = process.cwd();
    process.chdir(sub);
    try {
        // when rendering a relative prompt file with vars from the nested cwd
        // then it resolves against the project root and substitutes the variable
        expect(await renderPrompt({ file: path.join("prompts", "greet.md"), vars: { name: "World" } })).toBe("Hello World!");
        // and rendering without vars leaves the placeholder untouched
        expect(await renderPrompt({ file: path.join("prompts", "greet.md") })).toBe("Hello {{name}}!");
    } finally {
        process.chdir(previous);
    }
});

test("template variables are not HTML-escaped", async () => {
    // given a prompt template interpolating a value into text with HTML-significant characters
    const dir = tempDir("loopy-prompt-escape-");
    const file = path.join(dir, "p.md");
    fs.writeFileSync(file, "Dear {{name}}, use <tag> & \"quotes\"");
    // when rendering with a value containing &, <, >, ' and "
    const rendered = await renderPrompt({ file, vars: { name: "O'Brien & <Co>" } });
    // then both the value and the surrounding template are passed through literally, without HTML entities
    expect(rendered).toBe("Dear O'Brien & <Co>, use <tag> & \"quotes\"");
});

test("changed prompt files are re-read", async () => {
    // given a prompt file with initial content
    const dir = tempDir("loopy-prompt-cache-");
    const file = path.join(dir, "p.md");
    fs.writeFileSync(file, "one {{x}}");
    // when rendering it the first time
    // then it returns the rendered original content
    expect(await renderPrompt({ file, vars: { x: 1 } })).toBe("one 1");
    // and when the file is overwritten with a later mtime
    fs.writeFileSync(file, "two {{x}}");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    // then rendering again picks up the new content instead of a cached version
    expect(await renderPrompt({ file, vars: { x: 2 } })).toBe("two 2");
});
