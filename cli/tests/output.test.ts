import { timestampFromDate } from "@bufbuild/protobuf/wkt"
import { expect, test } from "vitest"
import { executionTiming } from "../src/output"

test("formats completed and incomplete execution timing", () => {
    // given execution timestamps on the current local day and an earlier local day
    const now = new Date(2026, 7, 14, 21, 30)
    const today = timestampFromDate(new Date(2026, 7, 14, 9, 5, 4, 800))
    const earlier = timestampFromDate(new Date(2026, 7, 13, 9, 5, 4, 800))
    const completed = timestampFromDate(new Date(2026, 7, 14, 9, 5, 6))

    // when completed, same-day, earlier-day, and missing timing values are formatted
    const values = {
        completed: executionTiming(today, completed, now),
        today: executionTiming(today, undefined, now),
        earlier: executionTiming(earlier, undefined, now),
        missing: executionTiming(undefined, undefined, now)
    }

    // then sub-minute durations retain millisecond precision and incomplete values use concise local start times
    expect(values).toEqual({
        completed: "1.2s",
        today: "from 09:05",
        earlier: "from 2026-08-13 09:05",
        missing: undefined
    })
})

test("formats minute and hour execution durations", () => {
    // given execution timings with minute and hour components
    const started = timestampFromDate(new Date(0))
    const exactMinute = timestampFromDate(new Date(60_000))
    const minutes = timestampFromDate(new Date(1_530_900))
    const exactHour = timestampFromDate(new Date(3_600_000))
    const hours = timestampFromDate(new Date(5_130_900))

    // when the durations are formatted
    const values = {
        exactMinute: executionTiming(started, exactMinute),
        minutes: executionTiming(started, minutes),
        exactHour: executionTiming(started, exactHour),
        hours: executionTiming(started, hours)
    }

    // then minutes omit second fractions and hours omit seconds
    expect(values).toEqual({
        exactMinute: "1m0s",
        minutes: "25m30s",
        exactHour: "1h0m",
        hours: "1h25m"
    })
})

test("clamps negative execution durations to zero", () => {
    // given an end timestamp before its start timestamp
    const started = timestampFromDate(new Date(1_000))
    const ended = timestampFromDate(new Date(500))

    // when the execution duration is formatted
    const value = executionTiming(started, ended)

    // then the displayed duration does not become negative
    expect(value).toBe("0s")
})
