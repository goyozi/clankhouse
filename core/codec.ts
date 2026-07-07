import superjson from "superjson";

export function encode(value: unknown): string {
    return superjson.stringify(value);
}

export function decode(text: string): any {
    return superjson.parse(text);
}
