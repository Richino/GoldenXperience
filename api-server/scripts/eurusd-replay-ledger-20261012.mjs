import {config} from 'dotenv';import fs from 'node:fs';for(const p of ['.env','.env.local'])config({path:p,quiet:true});
const base='https://api-fxpractice.oanda.com/v3/accounts/'+process.env.OANDA_ACCOUNT_ID;
async function get(url){const r=await fetch(url,{headers:{Authorization:'Bearer '+(process.env.OANDA_API_KEY||process.env.OANDA_API_TOKEN)}});if(!r.ok)throw new Error('OANDA '+r.status);return r.json();}
const dir='research-v2/eurusd-trend-hold-20261012/',report=JSON.parse(fs.readFileSync(dir+'RESULTS.json'));
const instrument=(await get(base+'/instruments?instruments=EUR_USD')).instruments[0];
const index=await get(base+'/transactions?from='+encodeURIComponent(report.coverage.startInclusive)+'&to='+encodeURIComponent(report.valuedAt)+'&pageSize=1000');
const transactions=[];for(const page of index.pages)transactions.push(...(await get(page)).transactions);
fs.writeFileSync(dir+'ledger.json',JSON.stringify({instrument,transactions},null,2));
console.log(JSON.stringify({instrument:{marginRate:instrument.marginRate,financing:instrument.financing,commission:instrument.commission},n:transactions.length,firstBalances:transactions.filter(t=>t.accountBalance).slice(0,3).map(t=>({time:t.time,type:t.type,balance:t.accountBalance,pl:t.pl,financing:t.financing})),financing:transactions.filter(t=>t.type==='DAILY_FINANCING').map(t=>({time:t.time,details:t.positionFinancings}))},null,2));
