import assert from "node:assert/strict";
import { test } from "node:test";

import { downloadVersionedWebdavFile, uploadWebdavFile, WebdavCapacityError, WebdavConflictError, WebdavVersionUnavailableError } from "./webdav-sync";

const config = { url: "http://127.0.0.1:9999", directory: "", username: "", password: "", lastSyncedAt: "" };

test("WebDAV versioned writes use strong conditional headers and classify failures", async (t) => {
    const originalFetch = globalThis.fetch;
    const originalWindow = (globalThis as typeof globalThis & { window?: Window }).window;
    const originalDomParser = (globalThis as typeof globalThis & { DOMParser?: typeof DOMParser }).DOMParser;
    const requests: RequestInit[] = [];
    const responses: Response[] = [
        new Response(null, { status: 201 }),
        new Response(null, { status: 204 }),
        new Response("manifest", { status: 200, headers: { ETag: '"v2"', "Content-Type": "application/json" } }),
        new Response("stale manifest", { status: 200, headers: { "Content-Type": "application/json" } }),
        new Response('<?xml version="1.0"?><multistatus xmlns="DAV:"><response><propstat><prop><getetag>"v3"</getetag></prop></propstat></response></multistatus>', { status: 207 }),
        new Response("current manifest", { status: 200, headers: { "Content-Type": "application/json" } }),
        new Response(null, { status: 412 }),
        new Response(null, { status: 507 }),
    ];
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "DOMParser", {
        configurable: true,
        value: class {
            parseFromString(input: string) {
                const etag = input.match(/<getetag>([^<]+)<\/getetag>/)?.[1] || "";
                return { querySelector: () => null, getElementsByTagNameNS: () => (etag ? [{ textContent: etag }] : []) };
            }
        },
    });
    globalThis.fetch = async (_input, init) => {
        requests.push(init || {});
        const response = responses.shift();
        if (!response) throw new Error("Unexpected fetch");
        return response;
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
        else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
        if (originalDomParser === undefined) Reflect.deleteProperty(globalThis, "DOMParser");
        else Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: originalDomParser });
    });

    await uploadWebdavFile(config, "manifest.json", new Blob(["new"]), "application/json", null);
    await uploadWebdavFile(config, "manifest.json", new Blob(["existing"]), "application/json", '"v1"');
    const downloaded = await downloadVersionedWebdavFile(config, "manifest.json");
    const fallbackDownloaded = await downloadVersionedWebdavFile(config, "manifest.json");
    await assert.rejects(uploadWebdavFile(config, "manifest.json", new Blob(["conflict"]), "application/json", '"v2"'), WebdavConflictError);
    await assert.rejects(uploadWebdavFile(config, "manifest.json", new Blob(["full"]), "application/json", '"v2"'), WebdavCapacityError);
    await assert.rejects(uploadWebdavFile(config, "manifest.json", new Blob(["weak"]), "application/json", 'W/"v2"'), WebdavVersionUnavailableError);

    assert.equal(new Headers(requests[0].headers).get("if-none-match"), "*");
    assert.equal(new Headers(requests[1].headers).get("if-match"), '"v1"');
    assert.equal(await downloaded.file?.text(), "manifest");
    assert.equal(downloaded.etag, '"v2"');
    assert.equal(await fallbackDownloaded.file?.text(), "current manifest");
    assert.equal(fallbackDownloaded.etag, '"v3"');
    assert.equal(new Headers(requests[5].headers).get("if-match"), '"v3"');
    assert.equal(responses.length, 0);
});
