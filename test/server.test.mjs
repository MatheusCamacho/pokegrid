import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("local server exposes health and serves the application with security headers", async () => {
  const server = createServer();
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.cache.entries, "number");

    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(await page.text(), /POKÉGRID/);
  } finally {
    await close(server);
  }
});

test("filter endpoint rejects missing filter parameters with an English client error", async () => {
  const server = createServer();
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${origin}/api/filter`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid request."
    });
  } finally {
    await close(server);
  }
});
