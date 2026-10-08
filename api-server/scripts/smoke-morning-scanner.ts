/** Read-only broker smoke; never creates a job, writes snapshots, or trades. */
import { config } from "dotenv";
import { discoverSelectionInstruments, evaluateSelection } from "../src/market-selection-service.js";
config({ path: new URL("../.env",import.meta.url).pathname.replace(/^\/([A-Z]:)/,"$1"),quiet:true });
const started=Date.now();
const instruments=await discoverSelectionInstruments();
const result=await evaluateSelection(instruments,AbortSignal.timeout(180_000));
console.log(JSON.stringify({ label:"READ-ONLY CURRENT BROKER SMOKE — no jobs or recommendations persisted", instruments:instruments.length,
  evaluatedAt:result.evaluatedAt,durationMs:Date.now()-started, m15WithAtr:result.pairs.filter(p=>p.selection?.atrPips!==null).length,
  h1WithHistory:result.pairs.filter(p=>p.selection?.h1AsOf).length, executableQuotes:result.pairs.filter(p=>p.selection?.referencePrice!==null).length,
  newsKnown:result.pairs.filter(p=>p.selection?.news.state==="KNOWN").length, newsUnknown:result.pairs.filter(p=>p.selection?.news.state==="UNKNOWN").length,
  newsFetchedAt:result.newsFetchedAt,newsCoverageUntil:result.newsCoverageUntil,
  phase:result.pairs[0]?.phase,qualified:result.pairs.filter(p=>p.selection?.status==="QUALIFIED").length },null,2));
