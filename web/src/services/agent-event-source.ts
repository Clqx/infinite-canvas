const DEFAULT_RETRY_MS = 1000;

type ParsedEvent = { type: string; data: string };

export class SseParser {
    private buffer = "";
    private eventType = "message";
    private data: string[] = [];

    constructor(private readonly emit: (event: ParsedEvent) => void) {}

    push(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || "";
        lines.forEach((line) => this.readLine(line));
    }

    finish() {
        if (this.buffer) this.readLine(this.buffer);
        this.readLine("");
        this.buffer = "";
    }

    private readLine(line: string) {
        if (!line) {
            if (this.data.length) this.emit({ type: this.eventType, data: this.data.join("\n") });
            this.eventType = "message";
            this.data = [];
            return;
        }
        if (line.startsWith(":")) return;
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "event") this.eventType = value || "message";
        if (field === "data") this.data.push(value);
    }
}

export class AgentEventSource extends EventTarget {
    onerror: ((event: Event) => void) | null = null;
    private readonly controller = new AbortController();
    private closed = false;

    constructor(
        private readonly endpoint: string,
        private readonly token: string,
        private readonly clientId: string,
    ) {
        super();
        void this.run();
    }

    close() {
        this.closed = true;
        this.controller.abort();
    }

    private async run() {
        while (!this.closed) {
            try {
                const response = await fetch(`${this.endpoint}/events?clientId=${encodeURIComponent(this.clientId)}`, {
                    headers: { Accept: "text/event-stream", "x-canvas-agent-token": this.token },
                    cache: "no-store",
                    credentials: "omit",
                    referrerPolicy: "no-referrer",
                    signal: this.controller.signal,
                });
                if (!response.ok || !response.body) throw new Error(`Agent event stream failed (${response.status})`);
                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                const parser = new SseParser(({ type, data }) => this.dispatchEvent(new MessageEvent(type, { data })));
                while (!this.closed) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    parser.push(value);
                }
                parser.finish();
                if (!this.closed) throw new Error("Agent event stream closed");
            } catch (error) {
                if (this.closed || (error instanceof DOMException && error.name === "AbortError")) return;
                const event = new Event("error");
                this.dispatchEvent(event);
                this.onerror?.(event);
                await new Promise((resolve) => setTimeout(resolve, DEFAULT_RETRY_MS));
            }
        }
    }
}
