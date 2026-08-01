declare module "bun:test" {
    type TestCallback = () => void | Promise<void>;

    export function describe(name: string, callback: () => void): void;
    export function test(name: string, callback: TestCallback): void;
    export function expect<T>(actual: T): {
        rejects: ReturnType<typeof expect>;
        not: ReturnType<typeof expect>;
        toBe(expected: unknown): void;
        toBeDefined(): void;
        toBeUndefined(): void;
        toContain(expected: unknown): void;
        toEqual(expected: unknown): void;
        toHaveLength(expected: number): void;
        toMatchObject(expected: object): void;
        toThrow(expected?: unknown): void;
    };
}
