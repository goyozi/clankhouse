import fc from "fast-check"
import * as z from "zod"
import { expect, test } from "vitest"
import { ClankHouseError } from "../src/errors"
import { jsonSchema, type SchemaIo } from "../src/json-schema"

test("accepts representative JSON schemas in their supported directions", () => {
    // given schemas composed from supported JSON contracts, wrappers, defaults, transforms, coercion, and recursion
    type Node = { value: string; children: Node[] }
    const node: z.ZodType<Node> = z.lazy(() => z.object({ value: z.string(), children: z.array(node) }))
    const input = z.object({
        id: z.string().transform((value) => value.trim()),
        count: z.coerce.number(),
        label: z.string().optional(),
        mode: z.enum(["fast", "safe"]).default("safe"),
        prefix: z.string().prefault("item"),
        reference: z.templateLiteral(["item-", z.number()]),
        requiredLabel: z.string().optional().nonoptional(),
        values: z.array(z.union([z.number(), z.null()])),
        tuple: z.tuple([z.literal("item"), z.number()]),
        selection: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("one"), value: z.string() }),
            z.object({ kind: z.literal("two"), value: z.number() })
        ]),
        flags: z.record(z.string(), z.boolean()),
        extra: z.object({}).catchall(z.string()),
        recursive: node.nullable()
    })
    const output = z.intersection(
        z.object({ id: z.string().readonly(), value: z.number().optional() }),
        z.object({ kind: z.literal("result") })
    )

    // when generating input and output JSON schemas
    const inputJsonSchema = jsonSchema({ schema: input, io: "input", role: "Input" })
    const outputJsonSchema = jsonSchema({ schema: output, io: "output", role: "Output" })

    // then both are accepted and the shared helper removes the meta-schema declaration
    expect(inputJsonSchema).toMatchObject({ type: "object" })
    expect(outputJsonSchema).toMatchObject({ allOf: expect.any(Array) })
    expect(inputJsonSchema).not.toHaveProperty("$schema")
    expect(outputJsonSchema).not.toHaveProperty("$schema")
})

test("allows input transforms and rejects output transforms", () => {
    // given the same explicit JSON schema followed by a transform
    const transformed = z.object({ value: z.number() }).transform(({ value }) => ({ value: value + 1 }))

    // when generating its input contract
    const inputJsonSchema = jsonSchema({ schema: transformed, io: "input", role: "Reply" })

    // then the pre-transform wire branch is accepted
    expect(inputJsonSchema).toMatchObject({ type: "object" })
    // and using the transform as an output contract fails with the common diagnostic
    expect(() => jsonSchema({ schema: transformed, io: "output", role: "Step output" })).toThrow(
        expect.objectContaining({
            code: "schema_not_json_compatible",
            message: expect.stringMatching(/Step output.*<root>.*output-side transform.*return JSON values directly/)
        })
    )
})

test("accepts the wire side of input codecs and rejects output codecs", () => {
    // given a codec from an ISO JSON string to a runtime Date
    const codec = z.codec(z.iso.datetime(), z.date(), {
        decode: (value) => new Date(value),
        encode: (value) => value.toISOString()
    })

    // when it is inspected as an input-position contract
    const inputJsonSchema = jsonSchema({ schema: codec, io: "input", role: "Codec input" })

    // then only its JSON wire branch is used
    expect(inputJsonSchema).toMatchObject({ type: "string" })
    // and using its transformed runtime branch as an output contract is rejected
    expect(() => jsonSchema({ schema: codec, io: "output", role: "Codec output" })).toThrow(
        /Codec output.*output-side transform or codec/
    )
})

test("rejects unsupported schemas fail-closed with actionable paths", () => {
    // given schemas covering unsupported or ambiguous JSON constructs
    const cases: Array<{ name: string; schema: z.ZodTypeAny; io?: SchemaIo; match: RegExp }> = [
        { name: "any", schema: z.any(), match: /z\.any\(\)/ },
        { name: "unknown", schema: z.unknown(), match: /z\.unknown\(\)/ },
        { name: "loose object", schema: z.looseObject({}), match: /<additionalProperty>.*open object/ },
        {
            name: "any catchall",
            schema: z.object({}).catchall(z.any()),
            match: /<additionalProperty>.*z\.any\(\)/
        },
        {
            name: "unknown record values",
            schema: z.record(z.string(), z.unknown()),
            match: /<value>.*z\.unknown\(\)/
        },
        {
            name: "any record values",
            schema: z.record(z.string(), z.any()),
            match: /<value>.*z\.any\(\)/
        },
        { name: "top-level optional", schema: z.string().optional(), match: /<root>.*optional.*direct object/ },
        {
            name: "array optional",
            schema: z.array(z.string().optional()),
            match: /\[\].*optional.*direct object/
        },
        { name: "undefined property", schema: z.object({ value: z.undefined() }), match: /value.*z\.undefined/ },
        { name: "void property", schema: z.object({ value: z.void() }), match: /value.*z\.void/ },
        {
            name: "undefined union",
            schema: z.union([z.string(), z.undefined()]),
            match: /<union:1>.*z\.undefined/
        },
        { name: "date", schema: z.object({ nested: z.object({ when: z.date() }) }), match: /nested\.when.*datetime/ },
        { name: "bigint", schema: z.bigint(), match: /z\.bigint/ },
        { name: "map", schema: z.map(z.string(), z.number()), match: /z\.map/ },
        { name: "set", schema: z.set(z.string()), match: /z\.set/ },
        { name: "NaN", schema: z.nan(), match: /z\.nan/ },
        { name: "symbol", schema: z.symbol(), match: /z\.symbol/ },
        { name: "file", schema: z.file(), match: /z\.file/ },
        { name: "promise", schema: z.promise(z.string()), match: /z\.promise/ },
        { name: "function", schema: z.function(), match: /z\.function/ },
        { name: "custom", schema: z.custom<string>(), match: /z\.custom/ },
        { name: "catch", schema: z.string().catch("fallback"), match: /z\.catch/ },
        { name: "success", schema: z.success(z.string()), match: /z\.success/ },
        {
            name: "preprocessor",
            schema: z.preprocess((value) => value, z.string()),
            io: "input",
            match: /unconstrained transform/
        }
    ]

    // when each schema is checked at a wire boundary
    for (const testCase of cases) {
        let error: unknown
        try {
            jsonSchema({ schema: testCase.schema, io: testCase.io ?? "output", role: `Case ${testCase.name}` })
        } catch (cause) {
            error = cause
        }

        // then it fails under the shared code with its role, path, and remediation
        expect(error, testCase.name).toBeInstanceOf(ClankHouseError)
        expect(error, testCase.name).toMatchObject({ code: "schema_not_json_compatible" })
        expect((error as Error).message, testCase.name).toMatch(testCase.match)
        expect((error as Error).message, testCase.name).toContain(`Case ${testCase.name}`)
    }
})

test("rejects unknown future Zod definitions", () => {
    // given a schema-shaped object carrying an unrecognized future definition type
    const futureSchema = { def: { type: "future_jsonish" } } as unknown as z.ZodTypeAny

    // when the guard inspects it
    const action = () => jsonSchema({ schema: futureSchema, io: "input", role: "Future input" })

    // then it fails closed instead of delegating unknown behavior to Zod
    expect(action).toThrow(
        expect.objectContaining({
            code: "schema_not_json_compatible",
            message: expect.stringMatching(/Future input.*future_jsonish/)
        })
    )
})

test("caches role-independent schemas and issues per schema and direction", () => {
    // given a lazy schema whose getter exposes how often inspection occurs
    let resolutions = 0
    const lazy = z.lazy(() => {
        resolutions++
        return z.object({ value: z.string() })
    })

    // when the same schema and direction are requested twice with different roles
    const first = jsonSchema({ schema: lazy, io: "input", role: "First role" })
    const afterFirst = resolutions
    const second = jsonSchema({ schema: lazy, io: "input", role: "Second role" })
    const invalid = z.object({ value: z.date() })

    // then the generated result is reused without resolving the lazy schema again
    expect(second).toBe(first)
    expect(resolutions).toBe(afterFirst)
    // and cached issues are decorated with the role of each call rather than the first role
    expect(() => jsonSchema({ schema: invalid, io: "output", role: "First issue" })).toThrow(/First issue/)
    expect(() => jsonSchema({ schema: invalid, io: "output", role: "Second issue" })).toThrow(/Second issue/)
})

test("allows void only where top-level absence is explicitly permitted", () => {
    // given a top-level void schema
    const schema = z.void()

    // when it is used for allowed input and output contracts
    const inputGenerated = jsonSchema({ schema, io: "input", role: "Void input", allowTopLevelVoid: true })
    const outputGenerated = jsonSchema({ schema, io: "output", role: "Void output", allowTopLevelVoid: true })

    // then metadata is omitted
    expect(inputGenerated).toBeUndefined()
    expect(outputGenerated).toBeUndefined()
    // and the same schema is rejected without explicit permission and at nested positions
    expect(() => jsonSchema({ schema, io: "input", role: "Void input" })).toThrow(
        expect.objectContaining({ code: "schema_not_json_compatible" })
    )
    expect(() =>
        jsonSchema({
            schema: z.object({ value: schema }),
            io: "output",
            role: "Nested void",
            allowTopLevelVoid: true
        })
    ).toThrow(/Nested void.*value.*top-level absence/)
})

test("accepted input values retain their parsed meaning across JSON round trips", () => {
    // given an input-position schema with optional data and a non-idempotent transform
    const schema = z
        .object({ value: z.number(), label: z.string().optional(), flags: z.record(z.string(), z.boolean()) })
        .transform((value) => ({ ...value, value: value.value + 1 }))
    jsonSchema({ schema, io: "input", role: "Property input" })
    const arbitrary = fc.record({
        value: fc.oneof(fc.integer(), fc.constant(-0)),
        label: fc.option(fc.string(), { nil: undefined }),
        flags: fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.boolean())
    })

    // when arbitrary accepted wire values are serialized and parsed before schema parsing
    // then their parsed result is stable modulo JSON's defined normalizations
    fc.assert(
        fc.property(arbitrary, (value) => {
            const direct = schema.parse(value)
            const roundTripped = schema.parse(JSON.parse(JSON.stringify(value)))
            expect(jsonValue(roundTripped)).toEqual(jsonValue(direct))
        })
    )
})

test("accepted output values survive JSON persistence and full revalidation", () => {
    // given an output-position schema and arbitrary values including the two permitted normalizations
    const schema = z.object({
        value: z.number(),
        label: z.string().optional(),
        values: z.array(z.union([z.boolean(), z.null()])),
        flags: z.record(z.string(), z.boolean())
    })
    jsonSchema({ schema, io: "output", role: "Property output" })
    const arbitrary = fc.record({
        value: fc.oneof(fc.integer(), fc.constant(-0)),
        label: fc.option(fc.string(), { nil: undefined }),
        values: fc.array(fc.oneof(fc.boolean(), fc.constant(null))),
        flags: fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.boolean())
    })

    // when arbitrary values are parsed, persisted as JSON, and fully parsed again
    // then their JSON meaning is unchanged and the replayed value remains schema-valid
    fc.assert(
        fc.property(arbitrary, (value) => {
            const parsed = schema.parse(value)
            const replayed = schema.parse(JSON.parse(JSON.stringify(parsed)))
            expect(jsonValue(replayed)).toEqual(jsonValue(parsed))
        })
    )
})

test("values produced by JSON.parse are exact persistence fixed points", () => {
    // given arbitrary JSON values
    const arbitrary = fc.jsonValue()

    // when each value is serialized and parsed repeatedly
    // then the parsed JSON document is an exact fixed point
    fc.assert(
        fc.property(arbitrary, (value) => {
            const once = JSON.parse(JSON.stringify(value))
            const twice = JSON.parse(JSON.stringify(once))
            expect(twice).toStrictEqual(once)
        })
    )
})

function jsonValue(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value))
}
