import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type SyncTombstone = {
    id: string;
    deletedAt: string;
    eventId: string;
};

export function addTombstones(current: SyncTombstone[], ids: Iterable<string>, deletedAt: string, createEventId: () => string) {
    const merged = new Map(current.map((item) => [item.id, item]));
    for (const id of new Set(ids)) {
        if (!id) continue;
        const next = { id, deletedAt, eventId: createEventId() };
        const existing = merged.get(id);
        if (!existing || compareTombstones(next, existing) > 0) merged.set(id, next);
    }
    return Array.from(merged.values());
}

export function compareTombstones(left: SyncTombstone, right: SyncTombstone) {
    const time = Date.parse(left.deletedAt) - Date.parse(right.deletedAt);
    return time || left.eventId.localeCompare(right.eventId);
}

export function migrateCanvasData(state: unknown, version: number) {
    const record = strictRecord(state, "canvas state");
    if (version !== 0 && version !== 1 && version !== 2) throw new Error(`Unsupported canvas state version: ${version}`);
    return {
        projects: strictArray(record.projects, "canvas projects").map(parseCanvasProject),
        projectTombstones: version >= 2 ? strictArray(record.projectTombstones, "canvas tombstones").map(parseTombstone) : [],
    };
}

export function migrateAssetData(state: unknown, version: number) {
    const record = strictRecord(state, "asset state");
    if (version !== 0 && version !== 1 && version !== 2) throw new Error(`Unsupported asset state version: ${version}`);
    return {
        assets: strictArray(record.assets, "assets").map(parseAsset),
        assetTombstones: version >= 2 ? strictArray(record.assetTombstones, "asset tombstones").map(parseTombstone) : [],
    };
}

export function parseTombstone(value: unknown): SyncTombstone {
    const record = strictRecord(value, "tombstone");
    return {
        id: nonEmptyString(record.id, "tombstone id"),
        deletedAt: isoDate(record.deletedAt, "tombstone deletedAt"),
        eventId: nonEmptyString(record.eventId, "tombstone eventId"),
    };
}

function parseCanvasProject(value: unknown): CanvasProject {
    const record = strictRecord(value, "canvas project");
    const viewport = record.viewport === undefined ? { x: 0, y: 0, k: 1 } : parseViewport(record.viewport);
    const backgroundMode = record.backgroundMode === undefined ? "lines" : record.backgroundMode;
    if (backgroundMode !== "blank" && backgroundMode !== "dots" && backgroundMode !== "lines") throw new Error("Invalid canvas background mode");
    return {
        id: nonEmptyString(record.id, "project id"),
        title: stringValue(record.title, "project title"),
        createdAt: isoDate(record.createdAt, "project createdAt"),
        updatedAt: isoDate(record.updatedAt, "project updatedAt"),
        nodes: strictArray(record.nodes, "project nodes").map((node) => parseCanvasNode(node)),
        connections: strictArray(record.connections, "project connections").map((connection) => parseConnection(connection)),
        chatSessions: record.chatSessions === undefined ? [] : strictArray(record.chatSessions, "project chat sessions").map((session) => parseChatSession(session)),
        activeChatId: record.activeChatId === undefined || record.activeChatId === null ? null : stringValue(record.activeChatId, "active chat id"),
        backgroundMode,
        showImageInfo: record.showImageInfo === undefined ? false : booleanValue(record.showImageInfo, "showImageInfo"),
        viewport,
    };
}

function parseCanvasNode(value: unknown): CanvasProject["nodes"][number] {
    const record = strictRecord(value, "canvas node");
    const position = strictRecord(record.position, "canvas node position");
    if (record.metadata !== undefined) strictRecord(record.metadata, "canvas node metadata");
    return {
        ...(record as CanvasProject["nodes"][number]),
        id: nonEmptyString(record.id, "node id"),
        type: nonEmptyString(record.type, "node type"),
        title: stringValue(record.title, "node title"),
        position: { x: finiteNumber(position.x, "node x"), y: finiteNumber(position.y, "node y") },
        width: positiveNumber(record.width, "node width"),
        height: positiveNumber(record.height, "node height"),
    };
}

function parseConnection(value: unknown): CanvasProject["connections"][number] {
    const record = strictRecord(value, "canvas connection");
    return {
        id: nonEmptyString(record.id, "connection id"),
        fromNodeId: nonEmptyString(record.fromNodeId, "connection source"),
        toNodeId: nonEmptyString(record.toNodeId, "connection target"),
    };
}

function parseChatSession(value: unknown): CanvasProject["chatSessions"][number] {
    const record = strictRecord(value, "chat session");
    const messages = strictArray(record.messages, "chat messages").map((message) => {
        const item = strictRecord(message, "chat message");
        if (!(["user", "assistant", "system", "tool", "error"] as unknown[]).includes(item.role)) throw new Error("Invalid chat message role");
        return {
            ...item,
            id: nonEmptyString(item.id, "message id"),
            role: item.role,
            text: stringValue(item.text, "message text"),
        } as CanvasProject["chatSessions"][number]["messages"][number];
    });
    return {
        id: nonEmptyString(record.id, "chat session id"),
        title: stringValue(record.title, "chat session title"),
        messages,
        createdAt: isoDate(record.createdAt, "chat createdAt"),
        updatedAt: isoDate(record.updatedAt, "chat updatedAt"),
    };
}

function parseViewport(value: unknown): CanvasProject["viewport"] {
    const record = strictRecord(value, "viewport");
    return { x: finiteNumber(record.x, "viewport x"), y: finiteNumber(record.y, "viewport y"), k: positiveNumber(record.k, "viewport scale") };
}

function parseAsset(value: unknown): Asset {
    const record = strictRecord(value, "asset");
    const base = {
        id: nonEmptyString(record.id, "asset id"),
        title: stringValue(record.title, "asset title"),
        coverUrl: stringValue(record.coverUrl, "asset coverUrl"),
        tags: strictArray(record.tags, "asset tags").map((tag) => stringValue(tag, "asset tag")),
        createdAt: isoDate(record.createdAt, "asset createdAt"),
        updatedAt: isoDate(record.updatedAt, "asset updatedAt"),
        ...(record.source === undefined ? {} : { source: stringValue(record.source, "asset source") }),
        ...(record.note === undefined ? {} : { note: stringValue(record.note, "asset note") }),
        ...(record.metadata === undefined ? {} : { metadata: strictRecord(record.metadata, "asset metadata") }),
    };
    const data = strictRecord(record.data, "asset data");
    if (record.kind === "text") return { ...base, kind: "text", data: { content: stringValue(data.content, "text asset content") } };
    if (record.kind === "image" || record.kind === "video") {
        const media = {
            ...(record.kind === "image" ? { dataUrl: stringValue(data.dataUrl, "image dataUrl") } : { url: stringValue(data.url, "video url") }),
            ...(data.storageKey === undefined ? {} : { storageKey: nonEmptyString(data.storageKey, "asset storageKey") }),
            width: positiveNumber(data.width, "asset width"),
            height: positiveNumber(data.height, "asset height"),
            bytes: nonNegativeInteger(data.bytes, "asset bytes"),
            mimeType: stringValue(data.mimeType, "asset mimeType"),
        };
        return { ...base, kind: record.kind, data: media } as Asset;
    }
    throw new Error("Invalid asset kind");
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
    return value as Record<string, unknown>;
}

function strictArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
    return value;
}

function stringValue(value: unknown, label: string) {
    if (typeof value !== "string") throw new Error(`Invalid ${label}`);
    return value;
}

function nonEmptyString(value: unknown, label: string) {
    const text = stringValue(value, label);
    if (!text) throw new Error(`Invalid ${label}`);
    return text;
}

function isoDate(value: unknown, label: string) {
    const text = nonEmptyString(value, label);
    if (!Number.isFinite(Date.parse(text))) throw new Error(`Invalid ${label}`);
    return text;
}

function booleanValue(value: unknown, label: string) {
    if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
    return value;
}

function finiteNumber(value: unknown, label: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}`);
    return value;
}

function positiveNumber(value: unknown, label: string) {
    const number = finiteNumber(value, label);
    if (number <= 0) throw new Error(`Invalid ${label}`);
    return number;
}

function nonNegativeInteger(value: unknown, label: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
    return value as number;
}
