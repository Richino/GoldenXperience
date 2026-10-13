import assert from "node:assert/strict";
import { unsubscribeThisDeviceFromPush } from "../src/lib/notifications/push";

async function main() {
  const calls: string[] = [];
  let subscribed = true, serverOk = true;
  const subscription = { endpoint: "https://example.test/device", unsubscribe: async () => { calls.push("unsubscribe"); subscribed = false; return true; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscribed ? subscription : null } }) } } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { PushManager: {}, location: { hostname: "localhost", protocol: "http:" } } });
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "granted" } });
  globalThis.fetch = async (_input, init) => {
    calls.push("delete");
    assert.equal(init?.method, "DELETE");
    assert.equal(init?.credentials, "include");
    assert.equal(JSON.parse(String(init?.body)).endpoint, subscription.endpoint);
    return new Response(null, { status: serverOk ? 200 : 503 });
  };
  assert.equal((await unsubscribeThisDeviceFromPush()).status, "available");
  assert.deepEqual(calls, ["delete", "unsubscribe"], "Remove the server record before the local subscription");
  calls.length = 0;
  await unsubscribeThisDeviceFromPush();
  assert.deepEqual(calls, [], "Disabling an already-disabled device is harmless");
  subscribed = true; serverOk = false;
  await assert.rejects(unsubscribeThisDeviceFromPush(), /could not be disabled on the server/);
  assert.deepEqual(calls, ["delete"], "Failed server deletion must not claim success or remove the retry endpoint");
  assert.equal(subscribed, true);
  console.log("Push disable checks passed: device-scoped authenticated deletion, browser unsubscribe, repeat disable and failed-server handling.");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
