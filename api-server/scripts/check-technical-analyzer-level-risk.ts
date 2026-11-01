import assert from "node:assert/strict";
import { config } from "dotenv";
import { db } from "../src/database.js";
import { buildForecast, MODEL_VERSION } from "../../frontend/src/lib/technical-analyzer/engine.js";
import { levelRiskLabel } from "../../frontend/src/lib/technical-analyzer/levels.js";
import type { Snapshot } from "../../frontend/src/lib/technical-analyzer/types.js";

for (const path of [".env", ".env.local"]) config({ path, quiet: true });
try {
  const saved = await db().query<{ snapshot: Snapshot }>(`SELECT DISTINCT ON(instrument) snapshot FROM gx_technical_forecasts
    WHERE model_version=$1 ORDER BY instrument,created_at DESC`, ["gx-technical-1.1.0"]);
  const comparison = saved.rows.map(({ snapshot }) => {
    const original = JSON.stringify(snapshot);
    const revised = snapshot.forecasts.map(f => {
      const updated = buildForecast(snapshot, f.horizon);
      return { horizon:f.horizon, original:f.bias, revised:updated.bias, lean:updated.lean?.direction, leanEvidence:updated.lean?.evidence,
        continuationRisk:updated.continuationRisk?.severity, evidence:updated.evidence, levelRisk:levelRiskLabel(updated), reason:updated.reasons[2] };
    });
    assert.equal(JSON.stringify(snapshot), original, "Saved snapshot was mutated.");
    return { pair:snapshot.instrument, originalIssuedAt:snapshot.createdAt, comparison:revised };
  });
  console.log(JSON.stringify({ model:MODEL_VERSION, note:"Read-only rule comparison on frozen snapshots, not a backtest or evidence of predictive accuracy.", comparison },null,2));
} finally { await db().end(); }
