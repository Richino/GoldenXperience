export type EntryFamily = 'ema'|'breakout'|'momentum'|'meanrev';
export type EntryDirection = 'long'|'short';
export interface EntryBar {time:number;open:number;high:number;low:number;close:number}
export interface EntryOpportunity {
  family:EntryFamily;time:number;direction:EntryDirection;rawDirection:EntryDirection;
  stop:number;target:number;entry:number;signal:EntryBar;rangeHigh:number;rangeLow:number;
  breakoutLevel:number|null;regimeAtEntry?:'trending'|'ranging'|'mixed';
}
export type EntryV2Result = {status:'confirmed';time:number;direction:EntryDirection;policy:string}
  | {status:'wait'|'invalidated'|'data_incomplete';reason:string};
export const FOUR_FAMILY_ENTRY_V2_VERSION='four-family-entry-sequence-v2';
export const ENTRY_CONFIRMATION_BARS=4;

/** Called incrementally with completed post-signal candles only. No outcome input. */
export function confirmEntryV2(o:EntryOpportunity,completed:EntryBar[]):EntryV2Result {
  const bars=completed.filter(b=>b.time>o.time).slice(0,ENTRY_CONFIRMATION_BARS);
  if(o.signal.time!==o.time||!Number.isFinite(o.rangeHigh)||!Number.isFinite(o.rangeLow))return {status:'data_incomplete',reason:'Missing signal or pre-signal range'};
  let retestAt:number|null=null;
  let pierced=o.direction==='long'?o.signal.low<o.rangeLow:o.signal.high>o.rangeHigh;
  const rawLevel=o.rawDirection==='long'?o.rangeHigh:o.rangeLow;
  const rawBroke=o.rawDirection==='long'?o.signal.close>rawLevel:o.signal.close<rawLevel;
  for(let i=0;i<bars.length;i++){
    const b=bars[i]!;
    if(b.time!==o.time+(i+1)*900000)return {status:'data_incomplete',reason:'Missing M15 confirmation candle'};
    if(o.family!=='momentum'&&(o.direction==='long'?b.low<=o.stop:b.high>=o.stop))return {status:'invalidated',reason:'Original stop crossed before confirmation'};
    if(o.family==='ema'&&(o.direction==='long'?b.close>o.signal.high:b.close<o.signal.low))
      return {status:'confirmed',time:b.time,direction:o.direction,policy:'ema-pullback-confirmation-v2'};
    if(o.family==='breakout'){
      if(o.breakoutLevel===null)return {status:'data_incomplete',reason:'Missing stored breakout level'};
      if(retestAt!==null&&b.time>retestAt&&(o.direction==='long'?b.close>o.breakoutLevel:b.close<o.breakoutLevel))
        return {status:'confirmed',time:b.time,direction:o.direction,policy:'breakout-retest-reclaim-v2'};
      if(o.direction==='long'?b.low<=o.breakoutLevel:b.high>=o.breakoutLevel)retestAt??=b.time;
    }
    if(o.family==='momentum'){
      if(!rawBroke)return {status:'wait',reason:'Raw momentum did not break the frozen range'};
      const failed=o.rawDirection==='long'?b.close<rawLevel:b.close>rawLevel;
      if(failed)return {status:'confirmed',time:b.time,direction:o.rawDirection==='long'?'short':'long',policy:'momentum-failed-break-v2'};
      const held=o.rawDirection==='long'?b.low<=rawLevel&&b.close>rawLevel:b.high>=rawLevel&&b.close<rawLevel;
      if(held)return {status:'confirmed',time:b.time,direction:o.rawDirection,policy:'momentum-retest-continuation-v2'};
    }
    if(o.family==='meanrev'){
      pierced ||= o.direction==='long'?b.low<o.rangeLow:b.high>o.rangeHigh;
      const inside=b.close>o.rangeLow&&b.close<o.rangeHigh;
      const directional=o.direction==='long'?b.close>b.open:b.close<b.open;
      if(pierced&&inside&&directional)return {status:'confirmed',time:b.time,direction:o.direction,policy:'meanrev-failed-range-escape-v2'};
    }
  }
  return {status:'wait',reason:bars.length===ENTRY_CONFIRMATION_BARS?'No confirmation within four bars':'Awaiting completed confirmation'};
}

export interface ExecutableMinute {time:number;bo:number;bh:number;bl:number;bc:number;ao:number;ah:number;al:number;ac:number}
export interface ReplayPlan {time:number;entryTiming?:'known_open'|'within_minute';direction:EntryDirection;entry:number;stop:number;target:number;forcedAt:number;pip:number;slippagePips:number}
export interface ReplayResult {status:'resolved'|'data_incomplete'|'invalid';r:number|null;entry:number;exit:number|null;exitTime:number|null;reason:string;ambiguous:boolean}

/** Minute timestamps are OPEN times. End-of-session exit uses the completed minute. */
export function replayEntryPlan(plan:ReplayPlan,bars:ExecutableMinute[]):ReplayResult {
  const sign=plan.direction==='long'?1:-1;
  const entry=plan.entry+sign*plan.slippagePips*plan.pip;
  const risk=sign*(entry-plan.stop),reward=sign*(plan.target-entry);
  const incomplete=(reason:string):ReplayResult=>({status:'data_incomplete',r:null,entry,exit:null,exitTime:null,reason,ambiguous:false});
  if(!(risk>0)||!(reward>0)||plan.time>=plan.forcedAt)return {...incomplete('Invalid entry/stop/target or session'),status:'invalid'};
  const firstMinute=Math.floor(plan.time/60000)*60000;
  let expected=firstMinute;
  for(const b of bars){
    if(b.time<firstMinute)continue;
    if(b.time>=plan.forcedAt)break;
    if(b.time!==expected)return incomplete(`Missing M1 at ${new Date(expected).toISOString()}`);
    expected+=60000;
    const open=sign===1?b.bo:b.ao,high=sign===1?b.bh:b.ah,low=sign===1?b.bl:b.al;
    const stopHit=sign===1?low<=plan.stop:high>=plan.stop;
    const targetHit=sign===1?high>=plan.target:low<=plan.target;
    // A recorded fill can occur after the minute open and its extrema. We cannot
    // order that minute's barrier touches relative to the fill without ticks.
    const partialEntry=b.time===firstMinute&&(plan.entryTiming==='within_minute'||plan.time!==firstMinute);
    if(partialEntry&&(stopHit||targetHit))return incomplete('ENTRY_BAR_UNRESOLVED: barrier touch may precede recorded fill');
    // Open is known to precede high/low; a target already crossed at open is not
    // ambiguous. Otherwise competing intraminute levels conservatively stop.
    const gapStop=!partialEntry&&sign*(open-plan.stop)<=0;
    const gapTarget=!partialEntry&&sign*(open-plan.target)>=0;
    let exit:number|null=null,reason='',ambiguous=false;
    if(gapStop){exit=open;reason='GAP_STOP';}
    else if(gapTarget){exit=plan.target;reason='TARGET_AT_OPEN';}
    else if(stopHit){exit=plan.stop;reason=targetHit?'AMBIGUOUS_STOP':'STOP';ambiguous=targetHit;}
    else if(targetHit){exit=plan.target;reason='TARGET';}
    else if(b.time+60000===plan.forcedAt){exit=sign===1?b.bc:b.ac;reason='SESSION_CLOSE';}
    if(exit!==null){exit-=sign*plan.slippagePips*plan.pip;return {status:'resolved',r:sign*(exit-entry)/risk,entry,exit,exitTime:b.time+60000,reason,ambiguous};}
  }
  return incomplete('Missing data through exit');
}
