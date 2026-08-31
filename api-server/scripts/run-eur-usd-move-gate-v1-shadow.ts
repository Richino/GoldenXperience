import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const { runEurUsdMoveGateV1Shadow } = await import("../src/eur-usd-move-gate-v1-shadow.js");
const { db } = await import("../src/database.js");
try { console.log(JSON.stringify(await runEurUsdMoveGateV1Shadow(await getResearchCandles("EUR_USD", "M15", 500)), null, 2)); }
finally { await db().end(); }
