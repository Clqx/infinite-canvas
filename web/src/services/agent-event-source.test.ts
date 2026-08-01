import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SseParser } from "./agent-event-source";

describe("SseParser", () => {
    test("parses chunked named and multiline events", () => {
        const events: Array<{ type: string; data: string }> = [];
        const parser = new SseParser((event) => events.push(event));
        parser.push(": keepalive\r\nevent: hello\r\ndata: {\"ok\":");
        parser.push("true}\r\n\r\nevent: log\ndata: first\ndata: second\n\n");
        parser.finish();
        assert.deepEqual(events, [
            { type: "hello", data: '{"ok":true}' },
            { type: "log", data: "first\nsecond" },
        ]);
    });
});
