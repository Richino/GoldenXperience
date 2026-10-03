import fs from "node:fs"; import path from "node:path";
const ENV=path.resolve(__dirname,"../../api-server/.env");
for(const l of fs.readFileSync(ENV,"utf8").split(/\r?\n/)){const m=/^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim());if(m&&/^OANDA_/.test(m[1]!))process.env[m[1]!]=m[2]!.replace(/^["']|["']$/g,"");}
const OUT="C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/bbd27bdc-fb8b-46fd-8b2a-16a19b8f1dfe/scratchpad/majors-m1-v3";
const MAJORS=["EUR_USD","GBP_USD","USD_JPY","USD_CAD","AUD_USD","NZD_USD","USD_CHF"];
const START="2025-12-20T00:00:00.000Z", END="2026-05-11T00:00:00.000Z";
const ms=(s:string)=>Date.parse(s.replace(/\.(\d{3})\d*Z$/,".$1Z"));
(async()=>{
 fs.mkdirSync(OUT,{recursive:true});
 const {getResearchCandles}=await import("../src/lib/oanda/client");
 for(const inst of MAJORS){
  const byT=new Map<string,any>(); let cursor:string|undefined=END; let round=0;
  while(true){round++;
   const batch=await getResearchCandles(inst,"M1",5000,cursor?{to:cursor}:{});
   if(!batch.length)break;
   for(const c of batch) byT.set(c.time,c);
   const earliest=batch[0]!.time;
   if(ms(earliest)<=ms(START))break;
   if(cursor&&earliest===cursor)break;
   cursor=earliest; if(round>60)break;
  }
  const rows=[...byT.values()].filter(c=>c.complete&&ms(c.time)>=ms(START)&&ms(c.time)<ms(END))
    .sort((a,b)=>ms(a.time)-ms(b.time))
    // compact: drop volume, keep mid/bid/ask ohlc rounded
    .map(c=>({t:c.time,mo:c.mid.open,mh:c.mid.high,ml:c.mid.low,mc:c.mid.close,bc:c.bid.close,ac:c.ask.close,bh:c.bid.high,bl:c.bid.low,ah:c.ask.high,al:c.ask.low}));
  fs.writeFileSync(`${OUT}/${inst}.json`,JSON.stringify(rows));
  process.stderr.write(`${inst}: ${rows.length} candles ${rows[0]?.t} -> ${rows[rows.length-1]?.t}\n`);
 }
})().catch(e=>{console.error(e);process.exit(1)});
