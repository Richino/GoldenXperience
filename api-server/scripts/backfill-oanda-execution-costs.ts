import { config as loadDotenv } from "dotenv";
import { backfillPracticeEntryCosts } from "../src/practice-execution.js";

loadDotenv({ path: ".env" });
loadDotenv({ path: ".env.local", override: false });

const result = await backfillPracticeEntryCosts();
console.log(`OANDA entry-cost backfill: scanned ${result.scanned}, ledger fills ${result.ledgerFills}, matched ${result.matches}, updated ${result.backfilled}.`);
