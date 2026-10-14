import fs from 'node:fs';
import assert from 'node:assert/strict';
import {config} from 'dotenv';
for(const p of ['.env','.env.local'])config({path:p,quiet:true});
const dir='research-v2/eurusd-trend-hold-20261012/';
const r=JSON.parse(fs.readFileSync(dir+'RESULTS.json'));
const m=JSON.parse(fs.readFileSync(dir+'market.json'));
const s=JSON.parse(fs.readFileSync(dir+'source.json'));
const ledger=JSON.parse(fs.readFileSync(dir+'ledger.json'));
const host=process.env.OANDA_ENVIRONMENT==='live'?'https://api-fxtrade.oanda.com':'https://api-fxpractice.oanda.com';
async function get(route){const response=await fetch(host+'/v3/'+route,{headers:{Authorization:'Bearer '+(process.env.OANDA_API_KEY||process.env.OANDA_API_TOKEN)}});if(!response.ok)throw new Error('OANDA read request failed: '+response.status);return response.json();}
const pricing=await get(`accounts/${process.env.OANDA_ACCOUNT_ID}/pricing?instruments=EUR_USD`);
const end=Date.parse(pricing.time),ask=+pricing.prices[0].asks[0].price;
const last=m.m1.at(-1).time;
const extension=await get(`instruments/EUR_USD/candles?granularity=M1&price=MBA&from=${encodeURIComponent(last)}&to=${encodeURIComponent(pricing.time)}`);
const bars=[...new Map([...m.m1,...extension.candles.filter(c=>c.complete)].map(c=>[c.time,c])).values()].map(c=>({...c,t:Date.parse(c.time)})).sort((a,b)=>a.t-b.t);
const candidates=s.trades.filter(t=>r.trades.some(x=>x.id===t.id));
const observedRates=new Map();for(const t of ledger.transactions)if(t.type==='DAILY_FINANCING')for(const p of t.positionFinancings||[])if(p.instrument==='EUR_USD')for(const f of p.openTradeFinancings||[])if(+f.financingRate>0)observedRates.set(t.time.slice(0,10),+f.financingRate);
function simulate(trade){
 const actualShort=trade.direction==='short',time=Date.parse(trade.opened_at),first=bars.find(c=>c.t>=time);
 const broker=m.broker[s.trades.findIndex(t=>t.id===trade.id)],units=Math.abs(+broker.initialUnits);
 const entry=actualShort?+broker.price:+first.bid.o;
 const entryTime=actualShort?time:first.t;
 const path=bars.filter(c=>c.t>=entryTime);
 let lowPnl=0,peakPnl=0,maxGiveback=0,lowAt=null,givebackAt=null,maxMargin=0;
 for(const c of path){const low=(entry-+c.ask.h)*units,high=(entry-+c.ask.l)*units;if(low<lowPnl){lowPnl=low;lowAt=c.time;}maxGiveback=Math.max(maxGiveback,high-low);const giveback=peakPnl-low;if(giveback>maxGiveback){maxGiveback=giveback;givebackAt=c.time;}peakPnl=Math.max(peakPnl,high);maxMargin=Math.max(maxMargin,units*(+c.mid.h)*+ledger.instrument.marginRate);}
 const finalPnl=(entry-ask)*units;maxGiveback=Math.max(maxGiveback,peakPnl-finalPnl);
 let financing=0;for(let t=Date.UTC(2026,8,28,21);t<=end;t+=86400000){if(t<=entryTime)continue;const days=[0,1,1,3,1,1,0][new Date(t).getUTCDay()];if(!days)continue;const rate=observedRates.get(new Date(t).toISOString().slice(0,10))??+ledger.instrument.financing.shortRate;const mark=bars.findLast(c=>c.t+60000<=t);if(mark)financing+=units*rate/365*days*(+mark.mid.c)*.99;}
 assert.ok(Number.isFinite(finalPnl));assert.ok(lowPnl<=0);assert.ok(maxGiveback>=0);
 return {tradeId:trade.id,originalDirection:trade.direction,openedAt:trade.opened_at,entryTime:new Date(entryTime).toISOString(),entry,units,lots:units/100000,closingAsk:ask,valuedAt:pricing.time,profitPips:(entry-ask)*10000,pricePnl:finalPnl,estimatedFinancing:financing,estimatedPnlIncludingFinancing:finalPnl+financing,worstFloatingPricePnl:lowPnl,worstFloatingAt:lowAt,largestProfitGivebackPricePnl:maxGiveback,givebackAt,peakFloatingProfit:peakPnl,maxEstimatedMargin:maxMargin,entryMethod:actualShort?'Actual broker short fill; first fully subsequent M1 candle onward':'Original long flipped to short at next full M1 bid open'};
}
const primary=simulate(candidates.find(t=>t.direction==='short'));
const firstTradeFlipped=simulate(candidates[0]);
const isolatedAlternatives=candidates.map(simulate);
const report={primary,firstTradeFlipped,isolatedAlternatives,method:'One short only. No stop, no target, no additions; liquidated at current ask. Original short entries use actual broker fills, original longs use next full M1 bid open. Drawdown uses ask highs/lows: worst floating loss excludes the unobserved first partial minute; giveback is an M1 envelope estimate with unresolved intraminute ordering. Financing estimated using recorded same-day short rates where available, otherwise prior captured current rate. No account-wide margin simulation, extra slippage or commissions. All alternatives are separate hypothetical accounts, never concurrent trades.'};
fs.writeFileSync(dir+'ONE-SHORT.json',JSON.stringify(report,null,2));
const money=x=>'$'+Math.round(x).toLocaleString('en-US');
const md=`# One EUR/USD short, no additions\n\nValued at ${pricing.time}. Primary scenario: first actual short within the original rolling two-week cohort, ${primary.openedAt}, ${primary.lots} lots at ${primary.entry}.\n\n- Price profit: ${money(primary.pricePnl)} (${primary.profitPips.toFixed(1)} pips).\n- Estimated financing: ${money(primary.estimatedFinancing)}.\n- Worst floating price loss: ${money(primary.worstFloatingPricePnl)}.\n- Largest estimated profit giveback: ${money(primary.largestProfitGivebackPricePnl)}.\n- Peak estimated margin: ${money(primary.maxEstimatedMargin)}.\n\nAlternative: flip the first trade in the cohort into one short; price profit ${money(firstTradeFlipped.pricePnl)}, worst floating price loss ${money(firstTradeFlipped.worstFloatingPricePnl)}.\n\n${report.method}\n\nNo trade or account setting was changed.\n`;
fs.writeFileSync(dir+'ONE-SHORT.md',md);
console.log(JSON.stringify({primary,firstTradeFlipped,alternatives:{n:isolatedAlternatives.length,winners:isolatedAlternatives.filter(x=>x.pricePnl>0).length,minPnl:Math.min(...isolatedAlternatives.map(x=>x.pricePnl)),maxPnl:Math.max(...isolatedAlternatives.map(x=>x.pricePnl))}},null,2));
