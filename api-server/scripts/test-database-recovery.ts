import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { once } from "node:events";

// The real pg-pool runs against fake clients; no real database or internet is used.
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
let offline = false, connections = 0, queries = 0;
const disconnect = () => Object.assign(new Error("private connection information"), { code: "ECONNRESET" });
class FakeClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  id = ++connections;
  connect(callback: (error?: Error) => void) { queueMicrotask(() => callback(offline ? disconnect() : undefined)); }
  query(_text: string, _values: unknown[], callback: (error: Error | null, result?: unknown) => void) {
    queries++;
    queueMicrotask(() => callback(offline ? disconnect() : null, { rows: [{ connection: this.id }] }));
  }
  end(callback?: () => void) { this._ending = true; this.emit("end"); callback?.(); }
  ref() {}
  unref() {}
}

const { db, query } = await import("../src/database.js");
const pool = db();
// Use the driver's existing client-constructor seam only within this isolated test process.
(pool as unknown as { Client: typeof FakeClient }).Client = FakeClient;
const logs: unknown[][] = [], originalWarn = console.warn;
console.warn = (...args: unknown[]) => { logs.push(args); };
const server = createServer((request, response) => {
  if (request.url === "/health") { response.end("ok"); return; }
  void query("SELECT 1").then(() => response.end("ready"), () => {
    response.statusCode = 503; response.end("Database temporarily unavailable");
  });
});
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const idleClient = await pool.connect();
  idleClient.release();
  assert.equal(pool.idleCount, 1);
  offline = true;
  assert.doesNotThrow(() => idleClient.emit("error", disconnect()), "an idle disconnect must not crash Node");
  assert.equal(pool.totalCount, 0, "pg discards the failed idle connection");
  assert.equal(logs.length, 1, "pool/client propagation logs a disconnect only once");
  assert.equal((await fetch(`${url}/health`)).status, 200, "the local HTTP listener survives while offline");
  assert.equal((await fetch(`${url}/data`)).status, 503, "database requests fail clearly while offline");
  offline = false;
  assert.equal((await fetch(`${url}/data`)).status, 200, "a later request reconnects without restarting HTTP or the pool");
  assert.ok(connections >= 3, "recovery uses a new connection");

  const checkedOut = await pool.connect();
  assert.doesNotThrow(() => checkedOut.emit("error", disconnect()), "checked-out disconnects between queries also remain handled");
  checkedOut.release(true);
  await query("SELECT 1");

  // A request that reaches the DB and fails is returned to its caller, never replayed.
  const before = queries;
  offline = true;
  await assert.rejects(query("INSERT INTO fixture VALUES (1)"), /private connection information/);
  assert.equal(queries, before + 1, "failed writes must not be automatically retried");
  offline = false;
  await query("SELECT 1");
  assert.equal(JSON.stringify(logs).includes("private connection information"), false);
  console.log("Database recovery passed: idle/checked-out disconnects, HTTP survival, offline failures, reconnects, safe logs and no write replay.");
} finally {
  console.warn = originalWarn;
  await pool.end();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
