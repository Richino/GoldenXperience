import { config as loadDotenv } from "dotenv";
import { db } from "../src/database.js";
import { runGbpRiskRewardCandidate } from "../src/research.js";

for (const name of [".env", ".env.local"]) loadDotenv({ path: new URL(`../${name}`, import.meta.url), override: name === ".env.local" });

const result = await runGbpRiskRewardCandidate();
console.log(JSON.stringify(result, null, 2));
await db().end();
