import assert from "node:assert/strict";
import { getAccountSummary } from "../src/lib/oanda/client";
import { verifiedAccountSummary } from "../src/lib/account-summary";

async function main() {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = { ...process.env };

  try {
    process.env.OANDA_ACCOUNT_ID = "practice-test";
    process.env.OANDA_API_KEY = "test-only";
    process.env.OANDA_ENVIRONMENT = "practice";
    const brokerAccount = {
      id: "practice-test", currency: "USD", balance: "80000", NAV: "80125.50",
      unrealizedPL: "125.50", marginUsed: "100", marginAvailable: "80025.50",
      openTradeCount: 1, hedgingEnabled: false,
    };
    globalThis.fetch = async () => new Response(JSON.stringify({ account: brokerAccount }), { status: 200 });
    const connected = await getAccountSummary();
    assert.equal(verifiedAccountSummary(connected)?.balance, 80000);
    assert.equal(verifiedAccountSummary(connected)?.nav, 80125.5);

    globalThis.fetch = async () => new Response("Broker temporarily unavailable", { status: 503 });
    assert.equal(verifiedAccountSummary(await getAccountSummary()), null, "A 503 must not expose the demo account as real money");
    globalThis.fetch = async () => { throw new TypeError("Network error"); };
    assert.equal(verifiedAccountSummary(await getAccountSummary()), null);
    assert.equal(verifiedAccountSummary({ ...connected, status: { ...connected.status, state: "error" } }), null);
    assert.equal(verifiedAccountSummary({ data: { ...connected.data, nav: Number.NaN } }), null);

    delete process.env.OANDA_ACCOUNT_ID;
    assert.equal(verifiedAccountSummary(await getAccountSummary()), null, "Missing configuration must not expose a demo balance");
    process.env.OANDA_ACCOUNT_ID = "practice-test";
    globalThis.fetch = async () => new Response(JSON.stringify({ account: brokerAccount }), { status: 200 });
    assert.equal(verifiedAccountSummary(await getAccountSummary())?.balance, 80000, "A recovered broker connection must restore real values");
    console.log("Account summary regression checks passed: real balance/equity, 503, network failure, missing credentials, invalid snapshot, recovery.");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnvironment;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
