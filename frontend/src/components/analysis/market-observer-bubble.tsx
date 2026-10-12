"use client";

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { BarChart3, X } from "lucide-react";
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
import { ObserverConversation, compactObserverChatMessage, observerPairLabel, observerSnapshotCanReplace, type ObserverChatMessage } from "@/lib/observer-conversation";
import { observerMascotExpression, observerMascotReaction, type ObserverMascotReaction } from "@/lib/observer-mascot";
import { ObserverMascot } from "./observer-mascot";
import { appendObserverPairMessages, markObserverPairRead, type ObserverPairChats } from "@/lib/observer-pair-chats";

const NO_MESSAGES: ObserverChatMessage[] = [];

export interface MarketObserverControl {
  analyze: (instrument: string, mode?: "NORMAL" | "SWING") => Promise<void>;
  stop: (instrument: string) => Promise<void>;
}
export interface MarketObserverMonitoring { tracked: string[]; busyPairs: Record<string, boolean> }
/** Dedicated chats per pair; Analyze explicitly adds pairs to server monitoring. */
/**
 * The speech bubble's message. A new message fades and slides in, and the
 * bubble eases to its new height instead of jumping (it grows upward, since
 * it is anchored to the mascot's bottom edge).
 */
function CloudText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previousHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const cloud = ref.current?.parentElement;
    if (!cloud) return;
    const height = cloud.getBoundingClientRect().height;
    const previous = previousHeight.current;
    previousHeight.current = height;
    if (previous === null || Math.abs(previous - height) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    cloud.animate([{ height: `${previous}px` }, { height: `${height}px` }], { duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)" });
  }, [text]);
  return <span ref={ref} key={text} className={`${styles.cloudText} ${styles.cloudTextEnter}`}>{text}</span>;
}

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
    ? selected : tracked.includes(chartInstrument) ? chartInstrument : tracked[0] ?? checkingPairs[0] ?? chartInstrument;
  const messages = chats[instrument]?.messages ?? NO_MESSAGES;
  const unread = chats[instrument]?.unread ?? 0;
  const totalUnread = [...new Set([...tracked, ...checkingPairs])].reduce((count, pair) => count + (chats[pair]?.unread ?? 0), 0);
  useEffect(() => { onMonitoringChange?.({ tracked, busyPairs }); }, [tracked, busyPairs, onMonitoringChange]);
  const mutations = useRef(new Set<string>());
  const membershipRevision = useRef(0);
  const conversation = useRef(new ObserverConversation());
  const nextMessage = useRef(0);
  const mounted = useRef(true);
  const actionRefs = useRef(new Map<string, AbortController>());
  const chatLog = useRef<HTMLDivElement | null>(null);
  const resultsDialog = useRef<HTMLDialogElement | null>(null);
  const resultsLauncher = useRef<HTMLButtonElement | null>(null);
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
  // The saved account plans own membership, not this tab's Analyze clicks.
  // Reconcile even when no pairs are tracked so starts in another tab appear.
  useEffect(() => {
    if (replayActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let running = false;
    const sync = async () => {
      if (running || controller.signal.aborted || document.visibilityState === "hidden") return;
      running = true;
      const revision = membershipRevision.current;
      try {
        const response = await fetch(apiUrl("/api/market-observer/active"), { credentials: "include", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) return;
        const result = await response.json() as { instruments?: unknown };
        if (!Array.isArray(result.instruments) || !result.instruments.every(pair => typeof pair === "string")) return;
        // A response that overlaps a local start/stop may predate its commit.
        if (controller.signal.aborted || mutations.current.size || revision !== membershipRevision.current) return;
        const next = [...new Set(result.instruments as string[])];
        if (next.length !== trackedRef.current.length || next.some(pair => !trackedRef.current.includes(pair))) {
          trackedRef.current = next;
          setTracked(next);
        }
      } catch { /* Keep the last known membership during a connection failure. */ }
      finally { running = false; }
    };
    const poll = async () => {
      await sync();
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    const onResume = () => { void sync(); };
    void poll();
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("focus", onResume); document.removeEventListener("visibilitychange", onResume); };
  }, [replayActive]);
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
    visibleChat.current = open && !detailsOpen && monitoringActive && !replayActive ? instrument : null;
    if (visibleChat.current && chatLog.current) {
      const view = chatViews.current[instrument] ?? { following: true, scrollTop: 0 };
      chatLog.current.scrollTop = view.following ? chatLog.current.scrollHeight : view.scrollTop;
    }
  }, [messages, instrument, open, detailsOpen, monitoringActive, replayActive]);
  useLayoutEffect(() => {
    const dialog = resultsDialog.current;
    const launcher = resultsLauncher.current;
    if (!dialog || !detailsOpen || !open || !monitoringActive || replayActive) return;
    // Native modal behavior keeps focus inside and returns it to the opener.
    dialog.showModal();
    return () => {
      dialog.close();
      launcher?.focus({ preventScroll: true });
    };
  }, [detailsOpen, open, monitoringActive, replayActive, instrument]);
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
  const monitorPair = useCallback(async (pair: string, mode: "NORMAL" | "SWING" = "NORMAL", showChat = false, keepResults = false) => {
    setSelected(pair); setOpen(showChat); setMinimized(false); setDetailsOpen(keepResults);
    if (!keepResults) {
      chatViews.current[pair] = { following: true, scrollTop: 0 };
      readPair(pair);
      if (chatLog.current) chatLog.current.scrollTop = 0;
    }
    if (mutations.current.has(pair)) return;
    if (!trackedRef.current.includes(pair) && new Set([...trackedRef.current, ...mutations.current]).size >= 12) {
      const text = "The chat can monitor 12 pairs at once. Stop one pair before adding another.";
      push([{ instrument: pair, at: new Date().toISOString(), role: "observer", kind: "connection", text }]);
      toast({ title: "Monitoring limit reached", description: text }); return;
    }
    push([{ instrument: pair, at: new Date().toISOString(), role: "user", kind: "request", text: `Analyze ${observerPairLabel(pair)} · ${mode === "SWING" ? "swing" : "normal"}.` }]);
    membershipRevision.current += 1;
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
  const paused = marketClosed || Boolean(error) || !read || read.state === "paused";
  const warming = !paused && read?.state === "warming";
  const collectingData = !paused && (warming || Boolean(read && !read.pressure.covered));
  const latest = [...messages].reverse().find(m => m.role === "observer");
  const expression = observerMascotExpression({ busy, monitored: tracked.includes(instrument), snapshot, error: marketClosed ? "Market closed" : error, reaction: reactions[instrument], now: clock });
  const headline = busy ? `Updating ${observerPairLabel(instrument)}` : marketClosed ? "Market closed" : error ? "Chat updates paused" : tracked.length > 1 ? `Watching ${tracked.length} pairs` : read?.headline ?? "Analysis chat";
  const price = (n: number | null | undefined) => n === null || n === undefined ? "—" : n.toFixed(precisionFor(instrument));
  const plainReason = (text: string) => text
    .replace(/M15: overlapping movement across the last (\d+) closed candles \([^)]*\)\.?/g, "15-minute chart: price moved back and forth over the last $1 completed periods, without a clear direction.")
    .replace(/H1: overlapping movement across the last (\d+) closed candles \([^)]*\)\.?/g, "1-hour chart: price moved back and forth over the last $1 completed periods, without a clear direction.")
    .replace("The latest quote is stale. Entry monitoring waits for fresh prices.", "The latest price is too old to use. Waiting for a fresh price before checking an entry.")
    .replace("The 30-second pressure window is still warming. Entry monitoring resumes when it is covered.", "Collecting 30 seconds of recent price movement before checking an entry.")
    .replace("Execution candle context is not current.", "Waiting for the latest completed price period.");
  const levelStateLabel = (role: "support" | "resistance", state: string) => state === "holding" ? "not crossed yet"
    : state === "testing" ? "price is touching this area" : state === "broken" ? `price passed ${role === "support" ? "below" : "above"}`
    : `price moved back ${role === "support" ? "above" : "below"}`;
  const pullbackPhaseLabel = (phase: string) => phase === "approaching" ? "waiting for price to reach the area" : phase === "testing" ? "price is in the area"
    : phase === "rebounding" ? "price is moving away from the area" : phase === "confirmed" ? "entry conditions met" : "waiting for fresh prices";
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
  const monitor = (mode: "NORMAL" | "SWING") => monitorPair(instrument, mode, true, true);
  const planMode = plan?.mode ?? "NORMAL";
  const modeLabel = planMode === "NORMAL" ? "Intraday" : "Swing";
  const entryStatusLabel = active ? busy ? "checking" : marketClosed ? "market closed" : paused || plan?.pullback?.phase === "unavailable" ? "paused"
    : collectingData ? "collecting data"
    : plan?.status === "PAUSED" ? "entry checks blocked" : plan?.status.toLowerCase() : plan?.status.toLowerCase();
  const currentSetup = active && plan?.status !== "PAUSED" && !paused && !warming;
  const decisionLabel = plan?.pullback && !plan.triggeredAt && active ? "Entry condition pending" : paused ? "No live decision" : currentSetup && plan?.direction === "long" ? "Long setup" : currentSetup && plan?.direction === "short" ? "Short setup"
    : read?.story ? "No confirmed entry"
    : read?.lean === "up" ? "Leaning up" : read?.lean === "down" ? "Leaning down" : read?.lean === "range" ? "Ranging" : "No clear direction";
  const supportingReasons = (paused || currentSetup) && plan?.facts.length ? plan.facts.slice(0, 2) : read?.facts.filter(f => f.category === "structure").slice(0, 2).map(f => f.text) ?? [];
  const cancelPair = useCallback(async (pair: string) => {
    journalRef.current?.abort(); setJournalBusy(false); setArchive(null);
    if (mutations.current.has(pair)) return;
    membershipRevision.current += 1;
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
  usePageScrollLock(open && !replayActive && monitoringActive && (detailsOpen || isPhoneLayout()));
  useImperativeHandle(controlRef, () => ({ analyze: (pair, mode) => monitorPair(pair, mode), stop: cancelPair }), [monitorPair, cancelPair]);
  if (replayActive || !monitoringActive) return null;
  const statusLabel = busy ? "checking" : marketClosed ? "market closed" : paused ? "paused" : collectingData ? "collecting data" : "watching";
  const statusLine = `${observerPairLabel(instrument)} · ${statusLabel}`;
  const tone = busy || collectingData ? "collecting" : marketClosed ? "closed" : paused ? "paused" : "live";
  const cloudText = busy ? "Checking market status, quotes, candles, patterns and news…" : marketClosed ? "Forex market closed. Watching resumes after reopening with fresh prices." : error ?? latest?.text ?? "Checking quotes, candles, patterns and news…";
  // Portalled to <body>: the page wrapper keeps its own layer, so inside it
  // the phone sheet could never cover the bottom nav.
  return createPortal(<aside className={`${styles.scout} ${minimized ? styles.minimized : ""}`} style={bubblePanelStyle} data-market-observer data-state={paused ? "paused" : "live"} data-expression={expression} data-side={bubbleSide} data-positioned={bubblePositioned} data-dragging={bubbleDragging}>
    {open && <div ref={setBackdrop} className={styles.backdrop} aria-hidden="true" onClick={requestClose} />}
    {open && <section ref={setSheet} {...dragHandlers} className={styles.panel} aria-label={`${observerPairLabel(instrument)} analysis chat`}>
      <div className={styles.grip} aria-hidden="true" />
      <header className={styles.panelHead}>
        <span className={styles.headIcon} aria-hidden="true"><ObserverMascot expression={expression} /></span>
        <div><h3>{observerPairLabel(instrument)} chat</h3><small><i className={styles.dot} data-tone={tone} />{statusLine}</small></div>
        <button aria-label="Close analysis chat" onClick={requestClose}><X size={18} /></button>
      </header>
      <div key={`chat-${instrument}`} ref={chatLog} className={styles.panelBody} onScroll={event => {
        const element = event.currentTarget;
        const following = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        chatViews.current[instrument] = { following, scrollTop: element.scrollTop };
        if (following) readPair(instrument);
      }}>
      <div className={styles.pairTabs} aria-label="Pair chats">{[...new Set([...tracked, ...checkingPairs, instrument])].map(pair => <button key={pair} aria-pressed={pair === instrument} onClick={() => selectChat(pair)}>{observerPairLabel(pair)}{busyPairs[pair] ? " · checking" : !tracked.includes(pair) ? " · stopped" : marketClosed ? " · closed" : failures[pair] || snapshots[pair]?.read?.state === "paused" ? " · paused" : snapshots[pair]?.read?.state === "warming" ? " · warming" : " · watching"}{chats[pair]?.unread > 0 && <span className={styles.unreadCount} aria-label={`${chats[pair].unread} unread updates`}>{chats[pair].unread}</span>}</button>)}</div>
      <p className={styles.caption}>Updates on meaningful changes · latest 120 messages for {observerPairLabel(instrument)}.</p>
      <div className={styles.conversationLog} role="log" aria-label={`${observerPairLabel(instrument)} messages`} aria-live="polite" aria-relevant="additions">{messages.map(message => {
        const time = new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        if (message.role !== "observer") return <article className={styles.chatMessage} data-role={message.role} key={message.id}>
          <p>{message.text}</p>
          <time dateTime={message.at}>{time}</time>
        </article>;
        // The first sentence is the headline; the rest reads under it.
        const [lead, ...rest] = compactObserverChatMessage(message.text).split(/(?<=[.!?])\s+/);
        return <article className={styles.chatMessage} data-role="observer" key={message.id}>
          <span className={styles.chatAvatar} aria-hidden="true"><ObserverMascot expression={expression} /></span>
          <div className={styles.chatBody}>
            <p className={styles.chatLead}>{lead}</p>
            {rest.length ? <p className={styles.chatRest}>{rest.join(" ")}</p> : null}
            {message.evidence?.length ? <details className={styles.chatEvidence}><summary>Evidence<span>{message.evidence.length}</span></summary><ul>{message.evidence.map(f => <li key={f.id}>{f.text}</li>)}</ul></details> : null}
            <div className={styles.chatMeta}><span className={styles.chatSource} data-source={message.source === "model" ? "ai" : "measured"}>{message.source === "model" ? "AI" : "Measured"}</span><time dateTime={message.at}>{time}</time></div>
          </div>
        </article>;
      })}{busy && <p className={styles.checking} role="status">{observerPairLabel(instrument)}: updating analysis and monitoring…</p>}</div>
      {unread > 0 && <button className={styles.newMessages} onClick={() => { setDetailsOpen(false); chatViews.current[instrument] = { following: true, scrollTop: 0 }; readPair(instrument); if (chatLog.current) chatLog.current.scrollTop = chatLog.current.scrollHeight; }}>{unread} new updates ↓</button>}
      {error && <p className={styles.notice} role="status">{error}</p>}
      {actionError && <p className={styles.notice} role="status">{actionError}</p>}

      </div>
      {/* Pinned under the chat: the pair's plan & results beside Stop / Analyze. */}
      <div className={`${styles.actions} ${styles.panelFooter}`}>
        <button disabled={busy} onClick={() => void (tracked.includes(instrument) ? cancel() : monitorPair(instrument, "NORMAL", true))}>{tracked.includes(instrument) ? "Stop" : "Analyze"} {observerPairLabel(instrument)}</button>
        <button ref={resultsLauncher} type="button" className={styles.resultsLauncher} aria-haspopup="dialog" aria-label={`Patterns, plan and results for ${observerPairLabel(instrument)}`} onClick={() => {
          if (chatLog.current) chatViews.current[instrument] = { following: false, scrollTop: chatLog.current.scrollTop };
          setDetailsOpen(true);
        }}><BarChart3 aria-hidden="true" />Plan &amp; results</button>
      </div>
    </section>}
    {open && detailsOpen && <dialog ref={resultsDialog} className={styles.resultsModal} aria-labelledby="observer-results-title" onCancel={event => { event.preventDefault(); setDetailsOpen(false); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setDetailsOpen(false);
    }}>
      <header className={styles.resultsHead}>
        <div><h3 id="observer-results-title">{observerPairLabel(instrument)} analysis</h3><p>{statusLine} · paper</p></div>
        <button type="button" aria-label="Close patterns, plan and results" onClick={() => setDetailsOpen(false)}><X size={18} /></button>
      </header>
      <div className={styles.resultsBody}>
      <div className={styles.modeSummary}>
        <span className={styles.modeBadge}>{modeLabel} · {planMode === "NORMAL" ? "5m" : "1h"} confirmation</span>
        <button type="button" disabled={busy || snapshot?.storage !== "ready"} onClick={() => void monitor(planMode === "NORMAL" ? "SWING" : "NORMAL")}>Switch to {planMode === "NORMAL" ? "Swing" : "Intraday"} and replace plan</button>
      </div>
      {(marketClosed || paused) && <div className={styles.statusNotice} role="status"><strong>{marketClosed ? "Market closed" : "Live analysis paused"}</strong><p>{marketClosed ? "Live analysis resumes after reopening with fresh prices. The saved context below is historical." : error ?? "Fresh price, candle and news checks are needed. Saved context is not a current entry signal."}</p></div>}
      {busy && <p className={styles.notice} role="status">Updating this pair’s plan…</p>}
      {actionError && <p className={styles.notice} role="status">{actionError}</p>}
      {read?.story && <section className={styles.decisionCard} aria-label="Three-part chart read">
        <h4>1. Bigger picture</h4><p>{read.story.broader.summary}</p>
        <p className={styles.caption}>Based on {read.story.broader.bars} completed 4-hour price periods{read.story.broader.from && read.story.broader.to ? ` · ${new Date(read.story.broader.from).toLocaleDateString()} to ${new Date(read.story.broader.to).toLocaleDateString()}` : " · history unavailable"}</p>
        <h4>2. Recent movement</h4><p>{read.story.recent.summary}</p>
        <p className={styles.caption}>Based on {read.story.recent.bars} completed 1-hour price periods · turning points checked against later completed periods</p>
        <h4>3. What is happening now</h4><p>{read.story.current.summary}</p>
        {read.story.current.levels.map(level => <div key={`${level.role}-${level.time}`}><h5>{level.role === "support" ? "Possible price floor" : "Possible price ceiling"} · {levelStateLabel(level.role, level.state)}</h5><p>{price(level.low)} – {price(level.high)}. {level.role === "support" ? "An area where a fall may slow or turn upward." : "An area where a rise may slow or turn downward."}</p><p>{level.condition}</p><p className={styles.caption}>Turning point: {new Date(level.time).toLocaleString()} · enough evidence to identify it after {new Date(level.knownAt).toLocaleString()}</p></div>)}
        <p>{read.story.current.watch}</p>
        <p className={styles.caption}>This describes what price has done. It does not guarantee what happens next.</p>
      </section>}
      <section className={styles.decisionCard} aria-label="Current decision">
        <div className={styles.decisionHead}><span>{paused ? "Saved entry checks" : read?.story ? "Checks before entering" : "Current direction"}</span><small>{modeLabel}{entryStatusLabel ? ` · ${entryStatusLabel}` : ""}</small></div>
        <h4>{decisionLabel === "Entry condition pending" ? "Not ready to enter yet" : decisionLabel}</h4>
        <p>{plan && !plan.direction ? plainReason(plan.thesis) : plan?.pullback && read?.blockers.length ? `Your plan is saved. ${plainReason(read.blockers[0])}` : paused ? "Wait for fresh prices and checks before considering an entry." : currentSetup ? plainReason(plan?.thesis ?? "") : read?.headline ?? "Analysis is being prepared."}</p>
        {plan && !plan.direction && <p className={styles.caption}>{plan.consolidation ? "The consolidation comparison watches developing breaks separately from the trend-pullback entry model." : "Analyze did not find sufficient trend, pullback-zone and target evidence for a priced plan."} {read?.blockers.length ? `Live entry checks also report: ${read.blockers[0]}` : "A fresh analysis is needed after the structure changes."}</p>}
        {supportingReasons.length > 0 && <><h5>{paused ? "What the saved data showed" : "What the data shows"}</h5><ul>{supportingReasons.map((reason, index) => <li key={`${index}-${reason}`}>{plainReason(reason)}</li>)}</ul></>}
        {active && plan?.pullback && <div className={styles.planBlock}>
          <h4>Possible {plan.direction === "long" ? "buy" : "sell"} · {pullbackPhaseLabel(plan.pullback.phase)}</h4>
          <p>{plan.direction === "long" ? "Watch for a small drop into the area below, followed by a move upward." : "Watch for a small rise into the area below, followed by a move downward."} Reaching the area alone is not enough to enter.</p>
          <p>Area to watch: {price(plan.pullback.zone.low)} – {price(plan.pullback.zone.high)}. Planned entry {price(plan.entry)} · stop-loss {price(plan.stop)} · profit target {price(plan.target)}.</p>
          <p>{plan.pullback.phase === "unavailable" ? "Live prices are interrupted. The plan is saved; waiting for fresh prices." : plan.pullback.phase === "testing" ? "Price reached the area. Checking each new price to see whether it turns back or keeps going through." : plan.pullback.phase === "rebounding" ? "Price moved away from the area in the planned direction. It must still finish a full price period beyond the level below and pass the entry checks." : plan.pullback.phase === "confirmed" ? "Entry conditions were met. Following the paper result; no order was placed." : "Checking each new price while waiting for it to reach the area."}</p>
          <p className={`${styles.caption} ${styles.liveCaption}`}>{plan.pullback.receivedQuotes} new price updates checked · latest move {plan.pullback.move === "unknown" ? "not known" : plan.pullback.move}{plan.pullback.lastQuoteAt ? ` · ${new Date(plan.pullback.lastQuoteAt).toLocaleTimeString()}` : ""}. Refresh creates a new plan; these prices stay fixed until then.</p>
        </div>}
        {plan?.consolidation && <details className={styles.sideCheck} aria-label="Consolidation confirmation comparison">
          <summary>Sideways-price check · {plan.consolidation.state === "inside" ? "inside the range" : plan.consolidation.state === "attempt" ? "testing a move out" : plan.consolidation.state === "unavailable" ? "waiting for fresh prices" : "ended"}</summary>
          <p>Price range: {price(plan.consolidation.low)} – {price(plan.consolidation.high)}. These edges stay fixed while we watch.</p>
          <p>Comparing two checks: price stays beyond an edge for {plan.consolidation.holdSeconds} seconds, with at least three updates and some further movement; or a full new 5-minute period ends beyond the edge.</p>
          <p className={styles.caption}>To ignore tiny crossings, price must pass the edge by {price(plan.consolidation.buffer)}. The hold check also needs {price(plan.consolidation.followThrough)} of further movement. Watching until {new Date(plan.consolidation.expiresAt).toLocaleTimeString()}. This is a paper test; it does not place an order.</p>
          {(["hold", "candle"] as const).map(method => <p key={method}>{method === "hold" ? "Hold" : "M5 close"}: {plan.consolidation!.attempts.filter(a => a[method].at).length} confirmations · {plan.consolidation!.attempts.filter(a => a[method].at && a[method].outcome === "returned_inside").length} returned inside · {plan.consolidation!.attempts.filter(a => a[method].at && a[method].outcome === "extended").length} extended · {plan.consolidation!.attempts.filter(a => a[method].at && ["pending", "unknown"].includes(a[method].outcome)).length} unresolved.</p>)}
          {plan.consolidation.attempts.length ? plan.consolidation.attempts.slice(-4).reverse().map(attempt => <div key={attempt.startedAt}><h5>{attempt.side === "up" ? "Upward" : "Downward"} breakout attempt · {new Date(attempt.startedAt).toLocaleTimeString()}</h5>
            <p>Hold: {attempt.hold.at ? `observed after ${Math.round((Date.parse(attempt.hold.at) - Date.parse(attempt.startedAt)) / 1000)}s · ${attempt.hold.outcome.replaceAll("_", " ")}` : attempt.endedAt ? "not confirmed before attempt ended" : "pending"}.</p>
            <p>M5 close: {attempt.candle.at ? `observed after ${Math.round((Date.parse(attempt.candle.at) - Date.parse(attempt.startedAt)) / 1000)}s · ${attempt.candle.outcome.replaceAll("_", " ")}` : attempt.endedAt ? "not confirmed before attempt ended" : "pending"}.</p>
            {(attempt.hold.blockers.length > 0 || attempt.candle.blockers.length > 0) && <p className={styles.caption}>Rule evidence was observed with entry checks blocked. It is not permission to enter.</p>}
          </div>) : <p>{plan.consolidation.state === "unavailable" ? "Fresh price observations are unavailable. The frozen box is retained; unseen movement is unknown." : plan.consolidation.state === "expired" ? "The comparison expired without an observed breakout attempt." : "Consolidating. No breakout attempt observed since this box was frozen."}</p>}
          <p className={styles.caption}>After either check passes, we watch whether price returns inside or travels farther by half the width of the range. Missing prices leave the result unknown.</p>
        </details>}
      </section>
      <section className={styles.setupSummary} aria-label="Entry and invalidation">
        <div><h4>{paused ? "Saved rules for a possible entry" : "What must happen before entering"}</h4><p>{!active && plan ? "This plan has ended. Refresh the analysis for a new setup." : plan?.trigger ? `${plan.pullback ? "Price must first reach the area to watch. Then wait for a full new " : "Wait for a full new "}${plan.trigger.timeframe === "M5" ? "5-minute" : "1-hour"} period to end ${plan.direction === "long" ? "above" : "below"} ${price(plan.trigger.boundary)}. The available ${plan.direction === "long" ? "buy" : "sell"} price must also be inside the entry range below, and all entry checks must pass.` : "No entry rules are available yet. Run Analyze again to look for a setup."}</p></div>
        {active && plan?.entry != null && <><div className={styles.setupLevels}><span>Entry<strong>{price(plan.entry)}</strong></span><span>Stop-loss<strong>{price(plan.stop)}</strong></span><span>Profit target<strong>{price(plan.target)}</strong></span></div><p className={styles.caption}>Entry is the planned opening price. Stop-loss is the planned exit price to limit a loss. The target is the planned exit price for a profit.</p></>}
        {active && plan?.trigger && plan.zone && <p className={styles.caption}>Allowed entry price: {price(plan.zone.low)} – {price(plan.zone.high)}</p>}
        <div><h4>When to cancel this idea</h4><p>{plan?.direction && plan.stop !== null ? `Cancel before entry if the ${plan.direction === "long" ? "sell" : "buy"} price reaches ${price(plan.stop)} or moves ${plan.direction === "long" ? "below" : "above"} it. Do not enter after the deadline below.` : plan?.invalidation ?? "No plan is being watched yet."}</p></div>
        {plan && <p className={styles.caption}>Deadline for a new entry: {new Date(plan.expiresAt).toLocaleString()}</p>}
      </section>
      <div className={styles.actions}><button disabled={busy || snapshot?.storage !== "ready"} onClick={() => void monitor(planMode)}>{busy ? "Updating…" : `Refresh ${modeLabel.toLowerCase()} plan`}</button></div>
      {snapshot?.storage === "unavailable" && <p className={styles.notice}>Plan journal is unavailable. Monitoring cannot be saved.</p>}
      <details className={styles.savedVersion}><summary>Evidence & patterns{paused ? " · historical" : ""}</summary>
      {error && <p className={styles.notice} role="status">{error}</p>}
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
      </details>
      <details className={styles.savedVersion}><summary>Full plan & entry checks</summary>
      {plan ? <div className={styles.plan}>
        <div className={styles.planHead}><strong>{plan.direction?.toUpperCase() ?? "WATCH CONDITION"} · {plan.mode}</strong><span>{plan.status}</span></div>
        <p>{plan.reason}</p>
        {plan.zone && <p>Entry zone {price(plan.zone.low)} – {price(plan.zone.high)}</p>}
        {plan.trigger && <p>Trigger: {plan.pullback ? "first observe price inside the pullback area, then " : ""}a new {plan.trigger.timeframe} close {plan.direction === "long" ? "above" : "below"} {price(plan.trigger.boundary)}, with executable price in the entry zone.</p>}
        {plan.entry !== null && <p>Entry reference {price(plan.entry)} · stop {price(plan.stop)} · target {price(plan.target)}</p>}
        <p>{plan.invalidation}</p><small>Version {plan.version} · entry expires {new Date(plan.expiresAt).toLocaleString()}</small>
        {plan.triggeredAt && <p>Signal observed {new Date(plan.triggeredAt).toLocaleString()} at {price(plan.observedEntry)}.</p>}
        {plan.outcome && <p>Outcome: {plan.outcome.kind.replaceAll("_", " ")}{plan.outcome.price !== null ? ` at ${price(plan.outcome.price)}` : " · no inferred win or loss"}.</p>}
        {active && snapshot?.checks?.length ? <><h4>Entry conditions</h4><ul className={styles.checks}>{snapshot.checks.map(check => <li key={check.id} data-check-state={error ? "unknown" : check.state}><div><strong>{check.label}</strong><span>{error ? "unknown" : check.state}</span></div><small>{error ? "Connection interrupted. Check cannot be verified." : check.detail}</small></li>)}</ul></> : null}
        <p className={styles.caption}>Monitoring a hypothesis. Triggered means the condition was observed; no order was placed.</p>
      </div> : <p>Analyze creates a versioned plan. Missing checks produce a watch condition with no entry signal.</p>}
      </details>
      <details className={styles.savedVersion}><summary>History & results</summary>
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
      </div>
    </dialog>}
    <div ref={setBubbleRow} style={bubbleRowStyle} {...bubbleDragHandlers} className={styles.bubbleRow}>
      {!open && !minimized && <div className={styles.cloudWrap}>
        <button className={styles.cloud} aria-label={`${headline}. ${cloudText}. Open the analysis chat`} onClick={openChat}>
          <span className={styles.cloudTag}><i className={styles.dot} data-tone={tone} />{statusLine}</span>
          <CloudText text={cloudText} />
        </button>
        <button data-no-observer-drag className={styles.minimize} aria-label="Hide the message, keep the icon" onClick={() => setMinimized(true)}><X size={12} /></button>
      </div>}
      <button data-observer-drag-icon className={styles.icon} title="Drag to move. Use arrow keys when focused." aria-expanded={open} aria-label={open ? "Close analysis chat" : `${headline}. Open the analysis chat`} onClick={() => { if (open) requestClose(); else openChat(); }}>
        <ObserverMascot expression={expression} reactionKey={expression === reactions[instrument]?.expression ? reactions[instrument].key : undefined} />
        <i className={styles.badge} data-tone={tone} role="img" aria-label={`Monitoring status: ${statusLabel}${totalUnread > 0 ? `; ${totalUnread} unread updates` : ""}`} />
      </button>
    </div>
  </aside>, document.body);
}
