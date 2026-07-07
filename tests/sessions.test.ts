import * as z from "zod";
import { expect, test } from "vitest";
import { BaseLanguageModel, type LanguageModelInvocation } from "../core/ai/base-llm";
import { gate, tempLoopy, testRun } from "./helpers";

test("get returns the session with ordered messages and stream yields them in order", async () => {
    // given a session with system, user, and assistant messages that has succeeded
    const { loopy } = tempLoopy();
    const recorder = loopy.sessions.create({ kind: "llm", provider: "fake", model: "m" });
    recorder.addMessage("system", "sys");
    recorder.addMessage("user", "hi");
    recorder.addMessage("assistant", "hello");
    recorder.succeed();

    // when getting the session
    const session = await loopy.sessions.get(recorder.id);

    // then it is succeeded
    expect(session.status).toBe("succeeded");
    // and messages are returned in insertion order
    expect(session.messages.map(m => [m.role, m.content])).toEqual([
        ["system", "sys"],
        ["user", "hi"],
        ["assistant", "hello"]
    ]);
    // and streaming the session yields the same messages in order
    expect((await Array.fromAsync(loopy.sessions.stream(recorder.id))).map(m => m.content)).toEqual(["sys", "hi", "hello"]);
});

test("stream with afterMessageId replays only later messages of an ended session", async () => {
    // given a succeeded session with three messages
    const { loopy } = tempLoopy();
    const recorder = loopy.sessions.create({ kind: "llm", provider: "fake", model: "m" });
    recorder.addMessage("system", "sys");
    recorder.addMessage("user", "hi");
    recorder.addMessage("assistant", "hello");
    recorder.succeed();
    const session = await loopy.sessions.get(recorder.id);

    // when streaming after the first message's id
    const messages = await Array.fromAsync(loopy.sessions.stream(recorder.id, { afterMessageId: session.messages[0]!.id }));

    // then only the messages after it are replayed
    expect(messages.map(m => m.content)).toEqual(["hi", "hello"]);
});

test("stream tails an active session until it ends", async () => {
    // given an active session with one message
    const { loopy } = tempLoopy();
    const recorder = loopy.sessions.create({ kind: "llm", provider: "fake", model: "m" });
    recorder.addMessage("user", "one");

    // when streaming the session
    const stream = loopy.sessions.stream(recorder.id);

    // then it yields the existing message first
    expect((await stream.next()).value?.content).toBe("one");

    // when a new message is added while a read is pending
    const pending = stream.next();
    recorder.addMessage("assistant", "two");

    // then the pending read resolves with the new message
    expect((await pending).value?.content).toBe("two");

    // when the session succeeds
    recorder.succeed();

    // then the stream ends
    expect((await stream.next()).done).toBe(true);
});

test("stream with afterMessageId on an active session yields only new messages", async () => {
    // given an active session with two messages
    const { loopy } = tempLoopy();
    const recorder = loopy.sessions.create({ kind: "llm", provider: "fake", model: "m" });
    recorder.addMessage("user", "one");
    recorder.addMessage("assistant", "two");
    const session = await loopy.sessions.get(recorder.id);
    const lastId = session.messages.at(-1)!.id;

    // when streaming after the last existing message's id
    const stream = loopy.sessions.stream(recorder.id, { afterMessageId: lastId });
    const pending = stream.next();

    // and a new message is added
    recorder.addMessage("assistant", "three");

    // then only the new message is yielded
    expect((await pending).value?.content).toBe("three");

    // when the session succeeds
    recorder.succeed();

    // then the stream ends
    expect((await stream.next()).done).toBe(true);
});

test("stream on a missing session throws", async () => {
    // given no session with the given id
    const { loopy } = tempLoopy();

    // when streaming an unknown session id
    // then it throws a not found error
    await expect(loopy.sessions.stream("nope").next()).rejects.toThrow(/not found/);
});

test("stream with an unknown or foreign afterMessageId throws", async () => {
    // given a succeeded session and a message belonging to another session
    const { loopy } = tempLoopy();
    const recorder = loopy.sessions.create({ kind: "llm", provider: "fake", model: "m" });
    recorder.addMessage("user", "hi");
    recorder.succeed();
    const other = loopy.sessions.create({ kind: "llm", provider: "fake", model: "m" });
    other.addMessage("user", "elsewhere");
    other.succeed();
    const foreignId = (await loopy.sessions.get(other.id)).messages[0]!.id;

    // when streaming with an unknown afterMessageId
    // then it throws a message not found error
    await expect(loopy.sessions.stream(recorder.id, { afterMessageId: "nope" }).next()).rejects.toThrow(/Message not found/);
    // and when streaming with another session's message id
    // then it also throws a message not found error
    await expect(loopy.sessions.stream(recorder.id, { afterMessageId: foreignId }).next()).rejects.toThrow(/Message not found/);
});

test("breaking out of a stream deregisters the listener without breaking the recorder", async () => {
    // given an active session with one message
    const { loopy } = tempLoopy();
    const recorder = loopy.sessions.create({ kind: "llm", provider: "fake", model: "m" });
    recorder.addMessage("user", "one");

    // when breaking out of the stream after the first message
    for await (const message of loopy.sessions.stream(recorder.id)) {
        expect(message.content).toBe("one");
        break;
    }

    // then the recorder still accepts further messages and can succeed
    recorder.addMessage("assistant", "two");
    recorder.succeed();
    // and the session ends up with both messages
    expect((await loopy.sessions.get(recorder.id)).messages).toHaveLength(2);
});

test("get on a missing session throws", async () => {
    // given no session with the given id
    const { loopy } = tempLoopy();

    // when getting an unknown session id
    // then it throws a not found error
    await expect(loopy.sessions.get("nope")).rejects.toThrow(/not found/);
});

class ParkingLLM extends BaseLanguageModel {
    readonly provider = "fake"
    readonly model = "parking"

    constructor(private readonly reached: () => void, private readonly parked: Promise<void>) {
        super();
    }

    protected async invoke({ prompt, session }: LanguageModelInvocation): Promise<unknown> {
        session.addMessage("user", prompt);
        session.addMessage("assistant", "thinking...");
        this.reached();
        await this.parked;
        return { summary: "s" };
    }
}

test("an active session is observed as running, and as interrupted after a crash", async () => {
    // given an llm call that parks after emitting one message
    const { loopy, reopen } = tempLoopy();
    const parked = gate();
    const reached = gate();
    const llm = new ParkingLLM(reached.release, parked.released);
    testRun(loopy, async () =>
        llm.call("summarize", { prompt: "p", output: z.object({ summary: z.string() }) })
    ).catch(() => { });
    await reached.released;
    const sessionId = (loopy.db.prepare("SELECT id FROM sessions").get() as { id: string }).id;

    // then the session is observed as running while parked
    expect((await loopy.sessions.get(sessionId)).status).toBe("running");

    // when reopening loopy to simulate a crash and restart
    const second = reopen();
    const observed = await second.sessions.get(sessionId);

    // then the session is observed as interrupted
    expect(observed.status).toBe("interrupted");
    // and its messages up to the crash are preserved
    expect(observed.messages.map(m => m.content)).toEqual(["p", "thinking..."]);
    // and streaming the session replays the same messages
    expect((await Array.fromAsync(second.sessions.stream(sessionId))).map(m => m.content)).toEqual(["p", "thinking..."]);
});
