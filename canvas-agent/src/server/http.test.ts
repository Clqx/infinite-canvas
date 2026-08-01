import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CanvasAgentConfig } from "../config.js";
import { createHttpApp } from "./http.js";

async function testServer(t: test.TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "canvas-agent-http-"),
  );
  const workspacePath = path.join(directory, "workspace");
  fs.mkdirSync(workspacePath);
  const config: CanvasAgentConfig = {
    url: "http://127.0.0.1:17371",
    token: crypto.randomBytes(18).toString("hex"),
    workspace: { workspacePath },
  };
  const configFile = path.join(directory, "canvas-agent.json");
  const server = createHttpApp(config, { configFile }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    configFile,
    workspacePath,
  };
}

function auth(token: string, headers: Record<string, string> = {}) {
  return { ...headers, "x-canvas-agent-token": token };
}

test("public probes are no-store and never expose the connection token", async (t) => {
  const { baseUrl, config } = await testServer(t);
  const healthResponse = await fetch(`${baseUrl}/health`);
  const health = (await healthResponse.json()) as Record<string, unknown>;
  const response = await fetch(`${baseUrl}/config`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(healthResponse.status, 200);
  assert.deepEqual(health, { ok: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.hasToken, true);
  assert.equal(JSON.stringify(body).includes(config.token), false);
});

test("protected routes accept only the token header and reject query tokens", async (t) => {
  const { baseUrl, config } = await testServer(t);
  const request = (url: string, headers?: Record<string, string>) =>
    fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: auth(headers?.token || "", {
        "content-type": "application/json",
      }),
      body: "{}",
    });

  assert.equal((await request("/canvas/state")).status, 401);
  assert.equal(
    (await request("/canvas/state", { token: "wrong" })).status,
    401,
  );
  assert.equal(
    (await request(`/canvas/state?token=${config.token}`)).status,
    401,
  );
  assert.equal(
    (
      await request(`/canvas/state?token=${config.token}`, {
        token: config.token,
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("/canvas/state?clientId=test", { token: config.token }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${baseUrl}/events?token=${config.token}`)).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/events?token=${config.token}`, {
        method: "OPTIONS",
      })
    ).status,
    401,
  );
});

test("authentication runs before the 30MB JSON parser", async (t) => {
  const { baseUrl, config } = await testServer(t);
  const response = await fetch(`${baseUrl}/canvas/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(response.status, 401);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    "invalid token",
  );

  const authenticated = await fetch(`${baseUrl}/canvas/state`, {
    method: "POST",
    headers: auth(config.token, { "content-type": "application/json" }),
    body: "{",
  });
  assert.equal(authenticated.status, 400);
});

test("CORS permits the token header and pairs an origin only after valid authentication", async (t) => {
  const { baseUrl, config, configFile } = await testServer(t);
  const origin = "https://canvas.example";
  const preflight = await fetch(`${baseUrl}/canvas/state`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "x-canvas-agent-token,content-type",
    },
  });
  assert.equal(preflight.status, 200);
  assert.match(
    preflight.headers.get("access-control-allow-headers") || "",
    /x-canvas-agent-token/,
  );

  const denied = await fetch(`${baseUrl}/canvas/state`, {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  const paired = await fetch(`${baseUrl}/canvas/state`, {
    method: "POST",
    headers: auth(config.token, {
      Origin: origin,
      "content-type": "application/json",
    }),
    body: "{}",
  });
  assert.equal(paired.status, 200);
  assert.deepEqual(
    (JSON.parse(fs.readFileSync(configFile, "utf8")) as CanvasAgentConfig)
      .origins,
    [origin],
  );
});

test("SSE accepts the token header and is marked no-store", async (t) => {
  const { baseUrl, config } = await testServer(t);
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/events?clientId=test`, {
    headers: auth(config.token),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("cache-control"), "no-store");
  controller.abort();
});

test("local image and file routes reject traversal and symlink escapes without echoing paths", async (t) => {
  const { baseUrl, config, workspacePath } = await testServer(t);
  const parent = path.dirname(workspacePath);
  const inside = path.join(workspacePath, "inside.png");
  const outside = path.join(parent, "outside.png");
  fs.writeFileSync(
    inside,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  fs.writeFileSync(outside, "outside");
  const post = (route: string, filePath: string) =>
    fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: auth(config.token, { "content-type": "application/json" }),
      body: JSON.stringify({ path: filePath }),
    });

  assert.equal((await post("/agent/local-image", inside)).status, 200);
  const escaped = await post("/agent/local-image", outside);
  assert.equal(escaped.status, 403);
  assert.equal((await escaped.text()).includes(outside), false);
  assert.equal((await post("/agent/local-file/reveal", outside)).status, 403);

  const secret = path.join(workspacePath, ".env");
  const disguisedSecret = path.join(workspacePath, "secret.png");
  fs.writeFileSync(secret, "API_KEY=not-an-image");
  fs.linkSync(secret, disguisedSecret);
  assert.equal((await post("/agent/local-image", disguisedSecret)).status, 400);

  const oversized = path.join(workspacePath, "oversized.png");
  fs.writeFileSync(
    oversized,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  fs.truncateSync(oversized, 25 * 1024 * 1024 + 1);
  assert.equal((await post("/agent/local-image", oversized)).status, 413);

  const outsideDirectory = path.join(parent, "outside-directory");
  const linkedImage = path.join(outsideDirectory, "linked.png");
  const link = path.join(workspacePath, "linked");
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(linkedImage, "outside");
  try {
    fs.symlinkSync(
      outsideDirectory,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      (await post("/agent/local-image", path.join(link, "linked.png"))).status,
      403,
    );
  } catch (error) {
    t.diagnostic(
      `symlink route check skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});
