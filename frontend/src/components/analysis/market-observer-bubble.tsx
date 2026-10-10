"use client";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { toast } from "@/hooks/use-toast";
import { isPhoneLayout } from "@/lib/sheet-motion";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import { usePageScrollLock } from "@/lib/use-page-scroll-lock";
import { useObserverBubbleDrag } from "@/lib/use-observer-bubble-drag";
import { precisionFor } from "@/lib/instruments/catalog";
import { getForexSessionStatus } from "@/lib/strategy/session";
import type { ObserverSnapshot, ObserverJournal } from "@/lib/market-observer-types";
import styles from "./market-observer-bubble.module.css";
import { ObserverEvaluationPanel } from "./observer-evaluation-panel";
import { ObserverConversation, observerPairLabel, observerSnapshotCanReplace, type ObserverChatMessage } from "@/lib/observer-conversation";
import { observerMascotExpression, observerMascotReaction, type ObserverMascotReaction } from "@/lib/observer-mascot";
import { ObserverMascot } from "./observer-mascot";
import { appendObserverPairMessages, markObserverPairRead, type ObserverPairChats } from "@/lib/observer-pair-chats";

const NO_MESSAGES: ObserverChatMessage[] = [];

export interface MarketObserverControl {
  analyze: (instrument: string) => Promise<void>;
  stop: (instrument: string) => Promise<void>;
}
export interface MarketObserverMonitoring { tracked: string[]; busyPairs: Record<string, boolean> }
/** Dedicated chats per pair; Analyze explicitly adds pairs to server monitoring. */
export function MarketObserverBubble({ instrument: chartInstrument, replayActive = false, controlRef, onMonitoringChange }: { instrument: string; replayActive?: boolean; controlRef?: Ref<MarketObserverControl>; onMonitoringChange?: (state: MarketObserverMonitoring) => void }) {
  const [tracked, setTracked] = useState<string[]>([]);
  const trackedRef = useRef<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ObserverSnapshot>>({});
  const [reactions, setReactions] = useState<Record<string, ObserverMascotReaction>>({});
  const snapshotsRef = useRef<Record<string, ObserverSnapshot>>({});
  const [failures, setFailures] = useState<Record<string, string | null>>({});
  const [chats, setChats] = useState<ObserverPairChats>({});
  const [clock, setClock] = useState(() => Date.now());
  const [busyPairs, setBusyPairs] = useState<Record<string, boolean>>({});
  const checkingPairs = Object.keys(busyPairs).filter(pair => busyPairs[pair]);
  const monitoringActive = tracked.length > 0 || checkingPairs.length > 0;
  const instrument = selected && (tracked.includes(selected) || busyPairs[selected])
    ? selected : tracked[0] ?? checkingPairs[0] ?? chartInstrument;
  const messages = chats[instrument]?.messages ?? NO_MESSAGES;
  const unread = chats[instrument]?.unread ?? 0;
  const totalUnread = [...new Set([...tracked, ...checkingPairs])].reduce((count, pair) => count + (chats[pair]?.unread ?? 0), 0);
  useEffect(() => { onMonitoringChange?.({ tracked, busyPairs }); }, [tracked, busyPairs, onMonitoringChange]);
  const mutations = useRef(new Set<string>());
  const conversation = useRef(new ObserverConversation());
  const nextMessage = useRef(0);
  const mounted = useRef(true);
  const actionRefs = useRef(new Map<string, AbortController>());
  const chatLog = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const chatViews = useRef<Record<string, { following: boolean; scrollTop: number }>>({});
  const visibleChat = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const { setRow: setBubbleRow, rowStyle: bubbleRowStyle, panelStyle: bubblePanelStyle, side: bubbleSide, positioned: bubblePositioned, dragging: bubbleDragging, handlers: bubbleDragHandlers } = useObserverBubbleDrag(monitoringActive && !replayActive);
  const [actionErrors, setActionErrors] = useState<Record<string, string | null>>({});
  const actionError = actionErrors[instrument];
  const journalRef = useRef<AbortController | null>(null);
  const [archive, setArchive] = useState<{ instrument: string; journal: ObserverJournal } | null>(null);
  const [journalBusy, setJournalBusy] = useState(false);
  const [journalError, setJournalError] = useState<{ instrument: string; text: string } | null>(null);
  const push = useCallback((drafts: Array<Omit<ObserverChatMessage, "id">>) => {
    if (!mounted.current || !drafts.length) return;
    const additions = drafts.map(d => ({ ...d, id: String(++nextMessage.current) }));
    const pair = visibleChat.current;
    const readingPair = pair && (chatViews.current[pair]?.following ?? true) ? pair : null;
    setChats(previous => appendObserverPairMessages(previous, additions, readingPair));
  }, []);
  const publish = useCallback((pair: string, next: ObserverSnapshot) => {
    if (!mounted.current || !observerSnapshotCanReplace(snapshotsRef.current[pair], next, pair)) return;
    const reaction = observerMascotReaction(snapshotsRef.current[pair], next, Date.now());
    if (reaction) setReactions(previous => ({ ...previous, [pair]: reaction }));
    push(conversation.current.ingest(pair, next, new Date().toISOString()).map(d => ({ ...d, role: "observer" })));
    snapshotsRef.current = { ...snapshotsRef.current, [pair]: next };
    setSnapshots(snapshotsRef.current);
    setFailures(previous => ({ ...previous, [pair]: null }));
  }, [push]);
  const getSnapshot = useCallback(async (pair: string, signal: AbortSignal) => {
    const response = await fetch(apiUrl(`/api/market-observer?instrument=${encodeURIComponent(pair)}`), { credentials: "include", cache: "no-store", signal });
    if (!response.ok) throw new Error("Live observer is unavailable.");
    const snapshot = await response.json() as ObserverSnapshot;
    if (typeof snapshot.enabled !== "boolean" || !Array.isArray(snapshot.history)) throw new Error("Live observer response is unavailable.");
    if (!signal.aborted) publish(pair, snapshot);
  }, [publish]);
  useEffect(() => {
    mounted.current = true;
    const controllers = actionRefs.current;
    return () => { mounted.current = false; for (const controller of controllers.values()) controller.abort(); journalRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (replayActive || !tracked.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let hidden = document.visibilityState === "hidden";
    const poll = async () => {
      if (document.visibilityState !== "hidden") {
        if (hidden) {
          push(tracked.map(pair => ({ instrument: pair, at: new Date().toISOString(), role: "observer", kind: "connection", source: "rules", text: "Chat resumed after the tab was hidden. Checking this pair's latest state and saved plan events." })));
          hidden = false;
        }
        await Promise.all(tracked.map(async pair => {
          if (mutations.current.has(pair)) return;
          try { await getSnapshot(pair, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])); }
          catch { if (!controller.signal.aborted) {
            setFailures(previous => ({ ...previous, [pair]: "Connection interrupted. Live observations are paused." }));
            push(conversation.current.failure(pair, new Date().toISOString()).map(d => ({ ...d, role: "observer" })));
          } }
        }));
      } else hidden = true;
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tracked, replayActive, getSnapshot, push]);
  useLayoutEffect(() => {
    visibleChat.current = open && monitoringActive && !replayActive ? instrument : null;
    if (visibleChat.current && chatLog.current) {
      const view = chatViews.current[instrument] ?? { following: true, scrollTop: 0 };
      chatLog.current.scrollTop = view.following ? chatLog.current.scrollHeight : view.scrollTop;
    }
  }, [messages, instrument, open, monitoringActive, replayActive]);
  const readPair = useCallback((pair: string) => setChats(previous => markObserverPairRead(previous, pair)), []);
  const selectChat = (pair: string) => {
    if (chatLog.current) {
      const element = chatLog.current;
      chatViews.current[instrument] = { following: element.scrollHeight - element.scrollTop - element.clientHeight < 40, scrollTop: element.scrollTop };
    }
    setSelected(pair); setDetailsOpen(false);
    if (chatViews.current[pair]?.following ?? true) readPair(pair);
  };
  const openChat = () => {
    if (chatViews.current[instrument]?.following ?? true) readPair(instrument);
    setOpen(true); setMinimized(false);
  };
  useEffect(() => {
    if (!monitoringActive) return;
    const update = () => setClock(Date.now());
    const timer = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [monitoringActive]);
  const monitorPair = useCallback(async (pair: string, mode: "NORMAL" | "SWING" = "NORMAL", showChat = false) => {
    setSelected(pair); setOpen(showChat); setMinimized(false); setDetailsOpen(false);
    chatViews.current[pair] = { following: true, scrollTop: 0 };
    readPair(pair);
    if (panelRef.current) panelRef.current.scrollTop = 0;
    if (mutations.current.has(pair)) return;
    if (!trackedRef.current.includes(pair) && new Set([...trackedRef.current, ...mutations.current]).size >= 12) {
      const text = "The chat can monitor 12 pairs at once. Stop one pair before adding another.";
      push([{ instrument: pair, at: new Date().toISOString(), role: "observer", kind: "connection", text }]);
      toast({ title: "Monitoring limit reached", description: text }); return;
    }
    push([{ instrument: pair, at: new Date().toISOString(), role: "user", kind: "request", text: `Analyze ${observerPairLabel(pair)} · ${mode === "SWING" ? "swing" : "normal"}.` }]);
    mutations.current.add(pair); setBusyPairs(previous => ({ ...previous, [pair]: true })); setActionErrors(previous => ({ ...previous, [pair]: null }));
    const controller = new AbortController(); actionRefs.current.set(pair, controller);
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let saved = false;
    try {
      const response = await fetch(apiUrl("/api/market-observer/analyze"), { method: "POST", credentials: "include", cache: "no-store", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument: pair, mode }) });
      const result = await response.json() as { error?: string; reason?: string; plan?: ObserverSnapshot["plan"] };
      if (!response.ok || result.plan?.instrument !== pair) throw new Error(result.error ?? result.reason?.replace(" Analyze still works for this pair.", "") ?? "The monitored plan could not be saved.");
      saved = true;
      if (!mounted.current || controller.signal.aborted) return;
      if (!trackedRef.current.includes(pair)) { trackedRef.current = [...trackedRef.current, pair]; setTracked(trackedRef.current); }
      await getSnapshot(pair, controller.signal);
      setArchive(null);
    } catch (e) {
      if (mounted.current) {
        const text = saved ? "The plan was saved, but its latest read could not be loaded. Checking again when the connection recovers."
          : controller.signal.aborted ? "Analysis timed out. The save may have completed on the server; check the pair status before retrying." : e instanceof Error ? e.message : "Analysis could not be saved.";
        push([{ instrument: pair, at: new Date().toISOString(), role: "observer", kind: "connection", source: "rules", text }]);
        if (!saved) toast({ title: `${observerPairLabel(pair)} analysis unavailable`, description: text });
      }
    } finally {
      clearTimeout(timeout); mutations.current.delete(pair); actionRefs.current.delete(pair);
      if (mounted.current) setBusyPairs(previous => ({ ...previous, [pair]: false }));
    }
  }, [getSnapshot, push, readPair]);
  const snapshot = !replayActive ? snapshots[instrument] ?? null : null;
  const marketClosed = !getForexSessionStatus(new Date(clock)).marketOpen;
  const error = failures[instrument] ?? (!marketClosed && snapshot?.read && clock - Date.parse(snapshot.read.asOf) > 5000 ? "Last live read is out of date. Checking the latest state." : null);
  const busy = busyPairs[instrument] ?? false;
  const read = snapshot?.read, plan = snapshot?.plan;
  const paused = marketClosed || Boolean(error) || read?.state !== "live";
  const latest = [...messages].reverse().find(m => m.role === "observer");
  const expression = observerMascotExpression({ busy, monitored: tracked.includes(instrument), snapshot, error: marketClosed ? "Market closed" : error, reaction: reactions[instrument], now: clock });
  const headline = busy ? `Updating ${observerPairLabel(instrument)}` : marketClosed ? "Market closed" : error ? "Chat updates paused" : tracked.length > 1 ? `Watching ${tracked.length} pairs` : read?.headline ?? "Analysis chat";
  const price = (n: number | null | undefined) => n === null || n === undefined ? "—" : n.toFixed(precisionFor(instrument));
  const active = plan && !["CLOSED", "EXPIRED", "INVALIDATED"].includes(plan.status);
  const journal = archive?.instrument === instrument ? archive.journal : null;
  const loadJournal = async () => {
    journalRef.current?.abort();
    const controller = new AbortController(); journalRef.current = controller; setJournalBusy(true); setJournalError(null);
    try {
      const response = await fetch(apiUrl(`/api/market-observer/journal?instrument=${encodeURIComponent(instrument)}`), { credentials: "include", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Saved plan history could not be loaded.");
      const next = await response.json() as ObserverJournal;
      if (!Array.isArray(next.plans) || !Array.isArray(next.events)) throw new Error("Saved plan history is unavailable.");
      if (!controller.signal.aborted) setArchive({ instrument, journal: next });
    } catch (e) { if (!controller.signal.aborted) setJournalError({ instrument, text: e instanceof Error ? e.message : "History unavailable." }); }
    finally { if (journalRef.current === controller) setJournalBusy(false); }
  };
  const monitor = (mode: "NORMAL" | "SWING") => monitorPair(instrument, mode, true);
  const cancelPair = useCallback(async (pair: string) => {
    journalRef.current?.abort(); setJournalBusy(false); setArchive(null);
    if (mutations.current.has(pair)) return;
    mutations.current.add(pair); setBusyPairs(previous => ({ ...previous, [pair]: true }));
    const controller = new AbortController(); actionRefs.current.set(pair, controller); setActionErrors(previous => ({ ...previous, [pair]: null }));
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(apiUrl(`/api/market-observer/plan?instrument=${encodeURIComponent(pair)}`), { method: "DELETE", credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error("Monitoring could not be stopped.");
      const next = await response.json() as ObserverSnapshot;
      if (!controller.signal.aborted) {
        publish(pair, next); setArchive(null);
        trackedRef.current = trackedRef.current.filter(trackedPair => trackedPair !== pair); setTracked(trackedRef.current);
        if (!trackedRef.current.length) setOpen(false);
        push([{ instrument: pair, at: new Date().toISOString(), role: "observer", kind: "plan", source: "rules", text: "Stopped this pair's chat updates and saved plan monitoring. Its earlier messages stay in this pair's chat." }]);
      }
    } catch (e) { if (mounted.current) setActionErrors(previous => ({ ...previous, [pair]: controller.signal.aborted ? "Stopping timed out. Checking the saved state before retrying is required." : e instanceof Error ? e.message : "Could not stop monitoring." })); }
    finally { clearTimeout(timeout); mutations.current.delete(pair); actionRefs.current.delete(pair); if (mounted.current) setBusyPairs(previous => ({ ...previous, [pair]: false })); }
  }, [publish, push]);
  const cancel = () => cancelPair(instrument);
  // Phones: the same drawer as the other sheets (slide in, drag the grip or
  // header down to dismiss, slide out, page frozen behind). Desktop: a panel.
  const { setSheet, setBackdrop, handlers: dragHandlers, requestClose } = useDragToDismiss({ open, onDismiss: () => setOpen(false), handleSelector: `.${styles.grip}, .${styles.panelHead}` });
  usePageScrollLock(open && !replayActive && monitoringActive && isPhoneLayout());
  useImperativeHandle(controlRef, () => ({ analyze: pair => monitorPair(pair), stop: cancelPair }), [monitorPair, cancelPair]);
  if (replayActive || !monitoringActive) return null;
  const statusLine = `${observerPairLabel(instrument)} · ${busy ? "checking" : marketClosed ? "market closed" : paused ? "paused" : expression === "alert" ? "update" : "watching"}`;
  const tone = busy ? "busy" : paused ? "paused" : expression === "alert" || expression === "cautious" ? "alert" : "live";
  const cloudText = busy ? "Checking market status, quotes, candles, patterns and news…" : marketClosed ? "Forex market closed. Watching resumes after reopening with fresh prices." : error ?? latest?.text ?? "Checking quotes, candles, patterns and news…";
  // Portalled to <body>: the page wrapper keeps its own layer, so inside it
  // the phone sheet could never cover the bottom nav.
  return createPortal(<aside className={`${styles.scout} ${minimized ? styles.minimized : ""}`} style={bubblePanelStyle} data-market-observer data-state={paused ? "paused" : "live"} data-expression={expression} data-side={bubbleSide} data-positioned={bubblePositioned} data-dragging={bubbleDragging}>
    {open && <div ref={setBackdrop} className={styles.backdrop} aria-hidden="true" onClick={requestClose} />}
    {open && <section ref={element => { panelRef.current = element; setSheet(element); }} {...dragHandlers} className={styles.panel} aria-label={`${observerPairLabel(instrument)} analysis chat`}>
      <div className={styles.grip} aria-hidden="true" />
      <header className={styles.panelHead}>
        <span className={styles.headIcon} aria-hidden="true"><ObserverMascot expression={expression} /></span>
        <div><h3>{observerPairLabel(instrument)} chat</h3><small><i className={styles.dot} data-tone={tone} />{statusLine} · paper</small></div>
        <button aria-label="Close analysis chat" onClick={requestClose}><X size={18} /></button>
      </header>
      <div className={styles.pairTabs} aria-label="Pair chats">{[...new Set([...tracked, ...checkingPairs, instrument])].map(pair => <button key={pair} aria-pressed={pair === instrument} onClick={() => selectChat(pair)}>{observerPairLabel(pair)}{busyPairs[pair] ? " · checking" : !tracked.includes(pair) ? " · stopped" : marketClosed ? " · closed" : failures[pair] || snapshots[pair]?.read?.state === "paused" ? " · paused" : snapshots[pair]?.read?.state === "warming" ? " · warming" : " · watching"}{chats[pair]?.unread > 0 && <span className={styles.unreadCount} aria-label={`${chats[pair].unread} unread updates`}>{chats[pair].unread}</span>}</button>)}</div>
      <p className={styles.caption}>Updates on meaningful changes · latest 120 messages for {observerPairLabel(instrument)}.</p>
      <div key={`chat-${instrument}`} ref={chatLog} className={styles.conversationLog} role="log" aria-label={`${observerPairLabel(instrument)} messages`} aria-live="polite" aria-relevant="additions" onScroll={event => {
        const element = event.currentTarget;
        const following = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        chatViews.current[instrument] = { following, scrollTop: element.scrollTop };
        if (following) readPair(instrument);
      }}>{messages.map(message => <article className={styles.chatMessage} data-role={message.role} key={message.id}>
        <div className={styles.messageHead}><strong>{observerPairLabel(message.instrument)}</strong><time dateTime={message.at}>{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>
        <p>{message.text}</p>
        {message.role === "observer" && <small>{message.source === "model" ? "AI interpretation" : "Measured update"}</small>}
        {message.evidence?.length ? <details><summary>Evidence at this update</summary><ul>{message.evidence.map(f => <li key={f.id}>{f.text}</li>)}</ul></details> : null}
      </article>)}{busy && <p className={styles.checking} role="status">{observerPairLabel(instrument)}: updating analysis and monitoring…</p>}</div>
      {unread > 0 && <button className={styles.newMessages} onClick={() => { chatViews.current[instrument] = { following: true, scrollTop: 0 }; readPair(instrument); if (chatLog.current) chatLog.current.scrollTop = chatLog.current.scrollHeight; }}>{unread} new updates ↓</button>}
      <div className={styles.actions}><button disabled={busy} onClick={() => void (tracked.includes(instrument) ? cancel() : monitorPair(instrument, "NORMAL", true))}>{tracked.includes(instrument) ? "Stop" : "Analyze"} {observerPairLabel(instrument)}</button></div>
      {error && <p className={styles.notice} role="status">{error}</p>}
      {actionError && <p className={styles.notice} role="status">{actionError}</p>}
      <details className={styles.savedVersion} key={instrument} open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}><summary>Patterns, plan & results · {observerPairLabel(instrument)}</summary>
      {!error && read && <>
        <p className={styles.timestamp}>Read {new Date(read.asOf).toLocaleTimeString()} · {read.state}</p>
        {read.movement.length > 0 && <div className={styles.metrics}>{read.movement.map(w => <div key={w.seconds}><small>{w.seconds}s net</small><strong>{w.netPips > 0 ? "+" : ""}{w.netPips.toFixed(2)}p</strong><span>{w.ready ? `${Math.round(w.efficiency * 100)}% retained` : "warming"}</span></div>)}</div>}
        <h4>What the market is doing</h4>
        <ul>{read.facts.filter(f => f.id === "quote-pressure" || f.category === "structure" || f.category === "risk").map(f => <li key={f.id}>{f.text}</li>)}</ul>
        <h4>Detected patterns</h4>
        {read.patterns.length ? <ul>{read.patterns.map(p => <li key={p.id}><strong>{p.timeframe} {p.kind.replaceAll("_", " ")}</strong> · {p.state}{p.historical ? " · historical" : ""}{p.contextState === "paused" ? " · context paused" : ""}</li>)}</ul> : <p>No active shape meets the defined rules.</p>}
        <p className={styles.caption}>Forming shapes can change. A pattern alone is not an entry.</p>
        {read.ai.text && <>
          <h4>{read.ai.source === "model" ? "AI interpretation" : "Live measured read"}</h4>
          <p>{read.ai.text}</p>
          {read.ai.watch && <p>Watch: {read.ai.watch}</p>}
          <p className={styles.caption}>{read.ai.source === "model" ? "AI explanation" : "Rule-based explanation"} · evidence as of {read.ai.at ? new Date(read.ai.at).toLocaleTimeString() : "this read"}.</p>
          {read.ai.evidence?.length ? <details><summary>Evidence behind this explanation</summary><ul>{read.ai.evidence.map(f => <li key={f.id}>{f.text}</li>)}</ul></details> : null}
        </>}
        {read.ai.state !== "ready" && <p className={styles.caption}>{read.ai.state === "limited" ? "AI explanation budget reached. The measured read continues." : read.ai.state === "error" ? "AI explanation unavailable. The measured read continues." : read.ai.state === "pending" ? "AI interpretation is being prepared. The measured read is shown above." : "Measured evidence continues without an AI explanation."}</p>}
        <h4>What would change the read</h4><ul>{read.changeConditions.map(c => <li key={c}>{c}</li>)}</ul>
      </>}
      <h4>Monitored Analyze plan</h4>
      {plan ? <div className={styles.plan}>
        <div className={styles.planHead}><strong>{plan.direction?.toUpperCase() ?? "WATCH CONDITION"} · {plan.mode}</strong><span>{plan.status}</span></div>
        <p>{plan.reason}</p>
        {plan.zone && <p>Entry zone {price(plan.zone.low)} – {price(plan.zone.high)}</p>}
        {plan.trigger && <p>Trigger: a new {plan.trigger.timeframe} close {plan.direction === "long" ? "above" : "below"} {price(plan.trigger.boundary)}, with executable price in the zone.</p>}
        {plan.entry !== null && <p>Entry reference {price(plan.entry)} · stop {price(plan.stop)} · target {price(plan.target)}</p>}
        <p>{plan.invalidation}</p><small>Version {plan.version} · entry expires {new Date(plan.expiresAt).toLocaleString()}</small>
        {plan.triggeredAt && <p>Signal observed {new Date(plan.triggeredAt).toLocaleString()} at {price(plan.observedEntry)}.</p>}
        {plan.outcome && <p>Outcome: {plan.outcome.kind.replaceAll("_", " ")}{plan.outcome.price !== null ? ` at ${price(plan.outcome.price)}` : " · no inferred win or loss"}.</p>}
        {active && snapshot?.checks?.length ? <><h4>Entry conditions</h4><ul className={styles.checks}>{snapshot.checks.map(check => <li key={check.id} data-check-state={error ? "unknown" : check.state}><div><strong>{check.label}</strong><span>{error ? "unknown" : check.state}</span></div><small>{error ? "Connection interrupted. Check cannot be verified." : check.detail}</small></li>)}</ul></> : null}
        <p className={styles.caption}>Monitoring a hypothesis. Triggered means the condition was observed; no order was placed.</p>
      </div> : <p>Analyze creates a versioned plan. Missing checks produce a watch condition with no entry signal.</p>}
      {snapshot?.storage === "unavailable" && <p className={styles.notice}>Plan journal is unavailable. Monitoring cannot be saved.</p>}
      <div className={styles.actions}><button disabled={busy || snapshot?.storage !== "ready"} onClick={() => void monitor("NORMAL")}>{busy ? "Saving…" : "Analyze & monitor"}</button><button disabled={busy || snapshot?.storage !== "ready"} onClick={() => void monitor("SWING")}>Swing plan</button></div>
      {snapshot?.history.length ? <><h4>Plan history</h4><ul>{snapshot.history.slice(0, 8).map(e => <li key={e.id}><strong>{e.status}</strong> · {new Date(e.at).toLocaleTimeString()}<br />{e.reason}</li>)}</ul></> : null}
      <div className={styles.actions}><button disabled={journalBusy} onClick={() => void loadJournal()}>{journalBusy ? "Loading history…" : journal ? "Refresh saved versions" : "View saved versions"}</button></div>
      <ObserverEvaluationPanel key={instrument} instrument={instrument} />
      {journalError?.instrument === instrument && <p className={styles.notice} role="status">{journalError.text}</p>}
      {journal && <section aria-label="Saved plan versions"><h4>Saved versions · latest 10</h4>{journal.plans.length ? journal.plans.map(saved => <details className={styles.savedVersion} key={saved.id}><summary>Version {saved.version} · {saved.mode} · {saved.status}</summary>
        <p>{saved.thesis}</p><p>{saved.reason}</p><small>Created {new Date(saved.createdAt).toLocaleString()}</small>
        {saved.entry !== null && <p>Frozen entry {price(saved.entry)} · stop {price(saved.stop)} · target {price(saved.target)}</p>}
        {saved.outcome && <p>Outcome: {saved.outcome.kind.replaceAll("_", " ")}</p>}
        <ul>{journal.events.filter(event => event.planId === saved.id).map(event => <li key={event.id}><strong>{event.status}</strong> · {new Date(event.at).toLocaleString()}<br />{event.reason}
          {event.snapshot && <small className={styles.eventEvidence}>Entry {price(event.snapshot.entry)} · confirmation {event.snapshot.confirmationCandle ? new Date(event.snapshot.confirmationCandle).toLocaleString() : "none"} · signal {event.snapshot.triggeredAt ? new Date(event.snapshot.triggeredAt).toLocaleString() : "none"}</small>}
        </li>)}</ul>
      </details>) : <p>No saved versions for this pair.</p>}<p className={styles.caption}>Latest 60 saved events across this pair. Hypothetical signals are separate from broker trades.</p></section>}
      </details>
    </section>}
    <div ref={setBubbleRow} style={bubbleRowStyle} {...bubbleDragHandlers} className={styles.bubbleRow}>
      {!open && !minimized && <div className={styles.cloudWrap}>
        <button className={styles.cloud} aria-label={`${headline}. ${cloudText}. Open the analysis chat`} onClick={openChat}>
          <span className={styles.cloudTag}><i className={styles.dot} data-tone={tone} />{statusLine}</span>
          <span className={styles.cloudText}>{cloudText}</span>
        </button>
        <button data-no-observer-drag className={styles.minimize} aria-label="Hide the message, keep the icon" onClick={() => setMinimized(true)}><X size={12} /></button>
      </div>}
      <button data-observer-drag-icon className={styles.icon} title="Drag to move. Use arrow keys when focused." aria-expanded={open} aria-label={open ? "Close analysis chat" : `${headline}. Open the analysis chat`} onClick={() => { if (open) requestClose(); else openChat(); }}>
        <ObserverMascot expression={expression} reactionKey={expression === reactions[instrument]?.expression ? reactions[instrument].key : undefined} />
        {(totalUnread > 0 || tone !== "live") && <i className={styles.badge} data-tone={totalUnread > 0 ? "alert" : tone} aria-hidden="true" />}
      </button>
    </div>
  </aside>, document.body);
}
