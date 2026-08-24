import * as z from "zod"
import { ClankHouseError } from "./errors.js"
import { errorMessage } from "./util.js"

export type SchemaIo = "input" | "output"

export type JsonSchemaOptions = {
    schema: z.ZodTypeAny
    io: SchemaIo
    role: string
    allowTopLevelVoid?: boolean
}

type SchemaDef = {
    type: string
    [key: string]: any
}

type Issue = {
    path: string
    message: string
    cause?: unknown
}

type CachedResult = { schema?: z.core.JSONSchema.JSONSchema; issue?: Issue }

const cache = new WeakMap<z.ZodTypeAny, Map<string, CachedResult>>()
const scalarTypes = new Set([
    "string",
    "number",
    "int",
    "boolean",
    "null",
    "never",
    "template_literal",
    "literal",
    "enum"
])
const collectionTypes = new Set(["object", "array", "tuple", "record", "union", "intersection"])
const wrapperTypes = new Set(["optional", "nullable", "readonly", "nonoptional", "default", "prefault", "lazy", "pipe"])

const unsupportedDefinitions = new Map<string, readonly [string, string]>([
    ["any", ["z.any()", "use an explicit schema or z.json()"]],
    ["unknown", ["z.unknown()", "use an explicit schema or z.json()"]],
    ["date", ["z.date()", "use z.iso.datetime() and construct Dates in your code"]],
    ["bigint", ["z.bigint()", "use a decimal string or safe JSON number"]],
    ["map", ["z.map()", "use z.record() or an array of key/value objects"]],
    ["set", ["z.set()", "use z.array()"]],
    ["nan", ["z.nan()", "use a finite number or null sentinel"]],
    ["undefined", ["z.undefined()", "omit an optional object property or use z.null()"]],
    ["void", ["z.void()", "use it only where top-level absence is explicitly supported"]]
])
const nonJsonTypes = new Set(["symbol", "file", "function", "promise", "custom"])
const permissiveTypes = new Set(["catch", "success"])

export function jsonSchema(options: JsonSchemaOptions): z.core.JSONSchema.JSONSchema | undefined {
    const key = `${options.io}:${options.allowTopLevelVoid === true}`
    let results = cache.get(options.schema)
    if (!results) {
        results = new Map()
        cache.set(options.schema, results)
    }
    let result = results.get(key)
    if (!result) {
        result = inspect(options.schema, options.io, options.allowTopLevelVoid === true)
        results.set(key, result)
    }
    if (result.issue) throw schemaError(options.role, result.issue)
    return result.schema
}

function inspect(schema: z.ZodTypeAny, io: SchemaIo, allowTopLevelVoid: boolean): CachedResult {
    if (allowTopLevelVoid && schemaDef(schema)?.type === "void") return {}
    const issue = inspectJsonCompatibility(schema, io)
    if (issue) return { issue }
    try {
        const generated = z.toJSONSchema(schema, { io })
        const withoutMetaSchema = { ...generated }
        delete withoutMetaSchema.$schema
        return { schema: withoutMetaSchema }
    } catch (cause) {
        return {
            issue: {
                path: "",
                message: `cannot be represented as JSON Schema: ${errorMessage(cause)}`,
                cause
            }
        }
    }
}

function schemaError(role: string, issue: Issue): ClankHouseError {
    const location = issue.path.length === 0 ? "<root>" : issue.path
    return new ClankHouseError("schema_not_json_compatible", `${role}: ${location} ${issue.message}`, {
        ...(issue.cause !== undefined ? { cause: issue.cause } : {})
    })
}

function inspectJsonCompatibility(schema: z.ZodTypeAny, io: SchemaIo): Issue | undefined {
    return walk(schema, io, "", false, new Map())
}

function walk(
    schema: z.ZodTypeAny,
    io: SchemaIo,
    path: string,
    objectProperty: boolean,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    const context = `${io}:${objectProperty}`
    const contexts = active.get(schema)
    if (contexts?.has(context)) return undefined
    const def = schemaDef(schema)
    if (!def) return unsupported(path, "unknown Zod schema definition")
    const nextContexts = contexts ?? new Set<string>()
    nextContexts.add(context)
    active.set(schema, nextContexts)
    try {
        return walkDefinition(schema, def, io, path, objectProperty, active)
    } finally {
        nextContexts.delete(context)
        if (nextContexts.size === 0) active.delete(schema)
    }
}

function walkDefinition(
    schema: z.ZodTypeAny,
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    objectProperty: boolean,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    if (scalarTypes.has(def.type)) return walkScalar(def, path)
    if (collectionTypes.has(def.type)) return walkCollection(def, io, path, active)
    if (wrapperTypes.has(def.type)) return walkWrapper(schema, def, io, path, objectProperty, active)
    return unsupportedDefinition(def.type, path)
}

function walkScalar(def: SchemaDef, path: string): Issue | undefined {
    if (def.type === "literal" && !def.values.every(isJsonScalar)) {
        return unsupported(path, "a non-JSON literal", "use a string, finite number, boolean, or null literal")
    }
    if (def.type === "enum" && !Object.values(def.entries).every(isJsonScalar)) {
        return unsupported(path, "an enum with non-JSON values", "use string or finite-number enum values")
    }
    return undefined
}

function walkCollection(
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    if (def.type === "object") return walkObject(def, io, path, active)
    if (def.type === "array") return walk(def.element, io, child(path, "[]"), false, active)
    if (def.type === "tuple") return walkTuple(def, io, path, active)
    if (def.type === "record") return walkRecord(def, io, path, active)
    if (def.type === "union") return walkUnion(def, io, path, active)
    return (
        walk(def.left, io, child(path, "<left>"), false, active) ??
        walk(def.right, io, child(path, "<right>"), false, active)
    )
}

function walkTuple(
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    for (const [index, item] of def.items.entries()) {
        const issue = walk(item, io, child(path, `[${index}]`), false, active)
        if (issue) return issue
    }
    return def.rest ? walk(def.rest, io, child(path, "[...rest]"), false, active) : undefined
}

function walkRecord(
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    const keyIssue = walk(def.keyType, io, child(path, "<key>"), false, active)
    return keyIssue ?? walk(def.valueType, io, child(path, "<value>"), false, active)
}

function walkUnion(
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    for (const [index, option] of def.options.entries()) {
        const issue = walk(option, io, child(path, `<union:${index}>`), false, active)
        if (issue) return issue
    }
    return undefined
}

function walkObject(
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    for (const [key, property] of Object.entries(def.shape as Record<string, z.ZodTypeAny>)) {
        const issue = walk(property, io, propertyPath(path, key), true, active)
        if (issue) return issue
    }
    if (!def.catchall) return undefined
    const catchallDef = schemaDef(def.catchall)
    if (catchallDef?.type === "never") return undefined
    if (catchallDef?.type === "unknown" || catchallDef?.type === "any") {
        return unsupported(
            child(path, "<additionalProperty>"),
            `an open object with z.${catchallDef.type}() values`,
            "use a normal or strict object, or provide a typed catchall"
        )
    }
    return walk(def.catchall, io, child(path, "<additionalProperty>"), false, active)
}

function walkWrapper(
    schema: z.ZodTypeAny,
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    objectProperty: boolean,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    if (def.type === "optional") return walkOptional(def, io, path, objectProperty, active)
    if (def.type === "nullable" || def.type === "readonly") {
        return walk(def.innerType, io, path, objectProperty, active)
    }
    if (def.type === "nonoptional") return walk(def.innerType, io, path, true, active)
    if (def.type === "default" || def.type === "prefault") {
        return walkFallback(def, io, path, objectProperty, active)
    }
    if (def.type === "lazy") return walk(def.getter(), io, path, objectProperty, active)
    return walkPipe(schema, def, io, path, objectProperty, active)
}

function walkOptional(
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    objectProperty: boolean,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    if (!objectProperty) {
        return unsupported(
            path,
            "z.optional() outside a direct object property",
            "use z.nullable() for array, tuple, record, union, or top-level values"
        )
    }
    return walk(def.innerType, io, path, true, active)
}

function walkFallback(
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    objectProperty: boolean,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    if (io === "input" && !objectProperty) {
        return unsupported(
            path,
            `z.${def.type}() outside a direct object property`,
            "make the containing JSON object property defaulted instead"
        )
    }
    if (!isJsonValue(def.defaultValue)) {
        return unsupported(path, `z.${def.type}() with a non-JSON fallback`, "use a JSON-representable fallback")
    }
    return walk(def.innerType, io, path, objectProperty, active)
}

function walkPipe(
    schema: z.ZodTypeAny,
    def: SchemaDef,
    io: SchemaIo,
    path: string,
    objectProperty: boolean,
    active: Map<z.ZodTypeAny, Set<string>>
): Issue | undefined {
    if (io === "output" && containsTransform(schema, new Set())) {
        return unsupported(path, "an output-side transform or codec", "return JSON values directly")
    }
    return walk(io === "input" ? def.in : def.out, io, path, objectProperty, active)
}

function containsTransform(schema: z.ZodTypeAny, active: Set<z.ZodTypeAny>): boolean {
    if (active.has(schema)) return false
    active.add(schema)
    const def = schemaDef(schema)
    if (!def) return true
    if (def.type === "transform") return true
    if (def.type !== "pipe") return false
    if (typeof def.transform === "function" || typeof def.reverseTransform === "function") return true
    return containsTransform(def.in, active) || containsTransform(def.out, active)
}

function schemaDef(schema: z.ZodTypeAny): SchemaDef | undefined {
    const def = schema?.def as SchemaDef | undefined
    return def && typeof def.type === "string" ? def : undefined
}

function unsupportedDefinition(type: string, path: string): Issue {
    const known = unsupportedDefinitions.get(type)
    if (known) return unsupported(path, known[0], known[1])
    if (nonJsonTypes.has(type)) return unsupported(path, `z.${type}()`, "use a schema composed only of JSON values")
    if (permissiveTypes.has(type)) {
        return unsupported(path, `z.${type}()`, "use a schema that rejects invalid wire values")
    }
    if (type === "transform") {
        return unsupported(path, "an unconstrained transform", "start the transform from an explicit JSON schema")
    }
    return unsupported(path, `unsupported Zod definition type "${type}"`)
}

function unsupported(path: string, construct: string, fix?: string): Issue {
    return {
        path,
        message: `${construct} is not JSON-representable${fix ? ` — ${fix}` : ""}`
    }
}

function propertyPath(parent: string, key: string): string {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return parent.length === 0 ? key : `${parent}.${key}`
    return `${parent}[${JSON.stringify(key)}]`
}

function child(parent: string, segment: string): string {
    return parent.length === 0 ? segment : `${parent}${segment.startsWith("[") ? "" : "."}${segment}`
}

function isJsonValue(value: unknown, active = new Set<object>()): boolean {
    if (isJsonScalar(value)) return true
    if (typeof value !== "object" || value === null || active.has(value)) return false
    active.add(value)
    const valid = Array.isArray(value)
        ? value.every((item) => isJsonValue(item, active))
        : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
          Object.values(value).every((item) => isJsonValue(item, active))
    active.delete(value)
    return valid
}

function isJsonScalar(value: unknown): boolean {
    return (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    )
}
