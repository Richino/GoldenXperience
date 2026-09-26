import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Search } from 'lucide-react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/AppText';
import { DockFade } from '@/components/ui/DockFade';
import { HomeCard } from '@/components/home/HomeCard';
import { NotificationDrawer } from '@/components/home/NotificationDrawer';
import { theme } from '@/constants/theme';
import { apiGet } from '@/lib/api/client';
import { formatShortDay } from '@/lib/time';
import { dedupeClosedTrades, dedupeTrades, resolvedPaperPl } from '@/lib/trades/merge-duplicates';
import { usePreferences } from '@/lib/preferences/PreferencesContext';
import type { JournalTrade } from '@/types/api';

type TradeTab = 'open' | 'closed' | 'all';
type ClosedFilter = 'all' | 'wins' | 'losses';
type JournalSummary = { total: number; winRate: number | null; today?: { wins: number; losses: number; realizedPL: number | null }; openTrades?: JournalTrade[] };
type JournalPayload = { trades: JournalTrade[]; hasMore: boolean; summary?: JournalSummary };

const PAGE_SIZE = 50;
const DOCK_CLEARANCE = 98;

function money(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Math.abs(value))}`;
}
const tradePnl = resolvedPaperPl;
function price(value: number | null | undefined, pair: string) { return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(pair.includes('JPY') ? 3 : 5); }
function rValue(value: number | null | undefined) { return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`; }
function duration(from: string, to: string | null) {
  const minutes = Math.max(0, Math.floor(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function outcome(trade: JournalTrade) {
  if (trade.brokerExecutionStatus === 'rejected') return 'BROKER REJECTED';
  if (trade.outcome === 'target_first') return 'TARGET FIRST';
  if (trade.outcome === 'stop_first') return 'STOP FIRST';
  if (trade.outcome === 'forced_close') return 'FORCED CLOSED';
  return 'CLOSED';
}

function ResultBadge({ trade }: { trade: JournalTrade }) {
  const tone = trade.result === 'win' ? styles.positive : trade.result === 'loss' ? styles.negative : styles.muted;
  const label = trade.brokerExecutionStatus === 'rejected' ? 'NOT EXECUTED' : trade.result === 'win' ? 'WIN' : trade.result === 'loss' ? 'LOSS' : trade.result === 'open' ? 'OPEN' : 'BE';
  return <Text style={[styles.resultBadge, tone]}>{label}</Text>;
}

function Level({ label, value, tone }: { label: string; value: string; tone?: object }) {
  return <View style={styles.level}><Text style={styles.levelLabel}>{label}</Text><Text style={[styles.levelValue, tone]}>{value}</Text></View>;
}

function TradeCard({ trade }: { trade: JournalTrade }) {
  const { themeMode } = usePreferences();
  const isOpen = trade.status === 'open';
  const pnl = tradePnl(trade);
  const positive = isOpen ? pnl === null || pnl >= 0 : trade.result === 'win';
  const rTone = trade.resultR === null ? styles.muted : trade.resultR >= 0 ? styles.positive : styles.negative;
  const pnlTone = pnl === null ? styles.muted : pnl >= 0 ? styles.positive : styles.negative;
  const openChart = () => { if (trade.instrument) router.push(`/chart?instrument=${encodeURIComponent(trade.instrument)}&trade=${trade.chartTradeId ?? trade.id}` as never); };

  return <Pressable disabled={!trade.instrument} onPress={openChart} style={({ pressed }) => [styles.tradeCard, themeMode === 'light' ? styles.lightTradeShadow : null, pressed && trade.instrument ? styles.pressed : null]} accessibilityRole={trade.instrument ? 'link' : undefined} accessibilityLabel={trade.instrument ? `Open ${trade.pair} trade on chart` : `${trade.pair} trade`}>
    <View style={[styles.tradeAccent, positive ? styles.accentPositive : styles.accentNegative]} />
    <View style={styles.tradeTop}><Text style={styles.pair}>{trade.pair}</Text><Text style={[styles.tradeR, rTone]}>{rValue(trade.resultR)}</Text></View>
    <View style={styles.tradeSub}>
      {isOpen ? <Text style={[styles.side, trade.direction === 'long' ? styles.positive : styles.negative]}>{trade.direction.toUpperCase()}</Text> : <Text style={styles.meta}><Text style={[styles.side, trade.direction === 'long' ? styles.positive : styles.negative]}>{trade.direction.toUpperCase()}</Text>{`  ·  ${outcome(trade)}`}</Text>}
      {isOpen ? <Text style={[styles.tradeMoney, pnlTone]}>{money(pnl)}</Text> : <ResultBadge trade={trade} />}
    </View>
    {isOpen ? <View style={styles.levels}><Level label="Entry" value={price(trade.entry, trade.pair)} /><Level label="Current" value="—" /><Level label="SL" value={price(trade.stop, trade.pair)} tone={styles.negative} /><Level label="TP" value={price(trade.target, trade.pair)} tone={styles.positive} /></View> : <Text style={styles.flow}>{price(trade.entry, trade.pair)}  →  {price(trade.exit, trade.pair)}</Text>}
    <View style={styles.tradeFoot}><Text style={styles.footText}>{isOpen ? (trade.strategyFamily ?? '') : `${trade.closedAt ? formatShortDay(trade.closedAt) : '—'} · ${duration(trade.openedAt, trade.closedAt)}`}</Text><Text style={[styles.tradeMoney, pnlTone]}>{isOpen ? duration(trade.openedAt, null) : money(pnl)}</Text></View>
  </Pressable>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: object }) { return <View style={styles.summaryItem}><Text style={[styles.summaryValue, tone]}>{value}</Text><Text style={styles.summaryLabel}>{label}</Text></View>; }

export default function JournalScreen() {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TradeTab>('open');
  const [closedFilter, setClosedFilter] = useState<ClosedFilter>('all');
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<JournalTrade[]>([]);
  const [summary, setSummary] = useState<JournalSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Until the first answer, the summary and tab counts would read 0 and then jump.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [showFloatingBell, setShowFloatingBell] = useState(false);
  const offset = useRef(0);
  // The starting tab is decided once, from the first answer; later refreshes never override the user's pick.
  const initialTabResolved = useRef(false);

  const load = useCallback(async (reset: boolean) => {
    if (reset) setLoading(true); else setLoadingMore(true);
    try {
      const nextOffset = reset ? 0 : offset.current;
      const payload = await apiGet<JournalPayload>(`/api/journal/trades?limit=${PAGE_SIZE}&offset=${nextOffset}&filter=all`);
      offset.current = nextOffset + payload.trades.length;
      setRecords((previous) => reset ? payload.trades : [...previous, ...payload.trades.filter((trade) => !previous.some((item) => item.id === trade.id))]);
      setHasMore(payload.hasMore);
      if (payload.summary) setSummary(payload.summary);
      if (!initialTabResolved.current) {
        initialTabResolved.current = true;
        const openCount = payload.summary?.openTrades?.length ?? payload.trades.filter((trade) => trade.status === 'open').length;
        if (openCount === 0) setTab('closed');
      }
      setError(null);
    } catch { setError('Could not load your trade journal.'); }
    finally { setLoading(false); setRefreshing(false); setLoadingMore(false); setLoadedOnce(true); }
  }, []);
  useEffect(() => { void load(true); }, [load]);

  const openTrades = summary?.openTrades ?? records.filter((trade) => trade.status === 'open');
  // The journal API can carry two rows for one real-world close (a decision
  // record and a broker reconciliation record) — dedupe before display so a
  // trade never shows up twice with half its numbers on each. See
  // lib/trades/merge-duplicates.
  const closedTrades = useMemo(() => dedupeClosedTrades(records.filter((trade) => trade.status === 'closed')), [records]);
  const allTrades = useMemo(() => dedupeTrades(records), [records]);
  const selectedRows = useMemo(() => {
    let rows = tab === 'open' ? openTrades : tab === 'closed' ? closedTrades : allTrades;
    const needle = query.trim().toLowerCase();
    if (needle) rows = rows.filter((trade) => trade.pair.toLowerCase().includes(needle));
    if (tab === 'closed' && closedFilter !== 'all') rows = rows.filter((trade) => closedFilter === 'wins' ? trade.result === 'win' : trade.result === 'loss');
    return rows;
  }, [allTrades, closedFilter, closedTrades, openTrades, query, tab]);
  const closedCount = Math.max(0, (summary?.total ?? records.length) - openTrades.length);
  // The log is paginated. Counting the loaded cards made 278 total trades
  // appear beside only the wins/losses from the first page. The API's journal
  // summary is whole-history, so its win rate must drive these aggregate
  // figures just as it does in the mobile web view.
  const closedWins = summary?.winRate === null || summary?.winRate === undefined ? 0 : Math.round(summary.winRate * closedCount);
  const closedLosses = Math.max(0, closedCount - closedWins);
  const openPnl = openTrades.reduce<number | null>((total, trade) => {
    const value = tradePnl(trade);
    return value === null ? total : (total ?? 0) + value;
  }, null);
  const todayRealized = summary?.today?.realizedPL ?? null;
  const onRefresh = () => { setRefreshing(true); void load(true); };

  return <View style={styles.root}><ScrollView contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top + 12, 30), paddingBottom: DOCK_CLEARANCE + Math.max(insets.bottom, 8) }]} showsVerticalScrollIndicator={false} scrollEventThrottle={16} onScroll={(event) => { const next = event.nativeEvent.contentOffset.y > 52; setShowFloatingBell((current) => current === next ? current : next); }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}>
    <View style={styles.header}><Text style={styles.title}>Trades</Text><Pressable onPress={() => setNotificationsOpen(true)} style={styles.headerBell} accessibilityRole="button" accessibilityLabel="Open notifications"><SymbolView name={{ ios: 'bell', android: 'notifications', web: 'notifications' }} size={21} tintColor={theme.colors.textSecondary} /></Pressable></View>
    {loadedOnce ? <>
    <HomeCard style={styles.summaryCard}>{tab === 'open' ? <View style={styles.summaryGrid}><Summary label="Open trades" value={String(openTrades.length)} /><Summary label="Unrealized P&L" value={money(openPnl)} tone={openPnl === null ? undefined : openPnl >= 0 ? styles.positive : styles.negative} /><Summary label="Realized P&L" value={money(todayRealized)} tone={todayRealized === null ? undefined : todayRealized >= 0 ? styles.positive : styles.negative} /></View> : <View style={styles.summaryGrid}><Summary label="Closed trades" value={String(closedCount)} /><Summary label="Wins" value={String(closedWins)} tone={styles.positive} /><Summary label="Losses" value={String(closedLosses)} tone={styles.negative} /><Summary label="Win rate" value={summary?.winRate === null || summary?.winRate === undefined ? '—' : `${Math.round(summary.winRate * 100)}%`} /></View>}</HomeCard>
    <View style={styles.toolbar}>
      <View style={styles.tabs}>{([['open', 'Open', openTrades.length], ['closed', 'Closed', closedCount], ['all', 'All', summary?.total ?? records.length]] as const).map(([id, label, count]) => <Pressable key={id} onPress={() => setTab(id)} style={[styles.tab, tab === id ? styles.tabActive : null]}><Text style={[styles.tabText, tab === id ? styles.tabTextActive : null]}>{label} <Text style={styles.tabCount}>{count}</Text></Text></Pressable>)}</View>
      <View style={styles.search}><Search size={17} color={theme.colors.textMuted} strokeWidth={2} /><TextInput value={query} onChangeText={setQuery} placeholder="Search trades..." placeholderTextColor={theme.colors.textMuted} style={styles.searchInput} accessibilityLabel="Search trades" /></View>
      {tab === 'closed' ? <View style={styles.filters}>{(['all', 'wins', 'losses'] as const).map((filter) => <Pressable key={filter} onPress={() => setClosedFilter(filter)} style={[styles.filter, closedFilter === filter ? styles.filterActive : null]}><Text style={[styles.filterText, closedFilter === filter ? styles.filterTextActive : null]}>{filter === 'all' ? 'All' : filter === 'wins' ? 'Wins' : 'Losses'}</Text></Pressable>)}</View> : null}
    </View>
    </> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {loading ? <View style={styles.loading}><ActivityIndicator color={theme.colors.primary} /></View> : selectedRows.length ? <View style={styles.cards}>{selectedRows.map((trade) => <TradeCard key={trade.id} trade={trade} />)}</View> : tab === 'open' ? <HomeCard style={styles.emptyCard}><Text style={styles.emptyTitle}>No trades open now</Text><Text style={styles.emptyDetail}>New paper positions will appear here as soon as they are active.</Text></HomeCard> : <Text style={styles.empty}>No trades in this view.</Text>}
    {tab !== 'open' && hasMore ? <Pressable onPress={() => void load(false)} disabled={loadingMore} style={styles.loadMore}><Text style={styles.loadMoreText}>{loadingMore ? 'Loading…' : 'Load more'}</Text></Pressable> : null}
  </ScrollView><DockFade height={96} />{showFloatingBell && !notificationsOpen ? <View style={[styles.floatingBellWrap, { top: insets.top + 8 }]}><Pressable onPress={() => setNotificationsOpen(true)} style={styles.floatingBell} accessibilityRole="button" accessibilityLabel="Open notifications"><SymbolView name={{ ios: 'bell', android: 'notifications', web: 'notifications' }} size={20} tintColor={theme.colors.textPrimary} /></Pressable></View> : null}<NotificationDrawer visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} /></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background }, content: { paddingHorizontal: 16, gap: 14 }, header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, title: { fontSize: 28, fontFamily: theme.fonts.sansBold, color: theme.colors.textPrimary, letterSpacing: -0.8 }, headerBell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, floatingBellWrap: { position: 'absolute', right: 16, zIndex: 40 }, floatingBell: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.cardBorder, ...theme.shadow.card },
  summaryCard: { paddingVertical: 16 }, summaryGrid: { flexDirection: 'row' }, summaryItem: { flex: 1, minWidth: 0, paddingHorizontal: 7 }, summaryValue: { fontSize: 16, fontFamily: theme.fonts.monoSemiBold, color: theme.colors.textPrimary }, summaryLabel: { marginTop: 4, fontSize: 8, fontFamily: theme.fonts.sansSemiBold, letterSpacing: 0.65, color: theme.colors.textMuted, textTransform: 'uppercase' },
  toolbar: { gap: 9 }, tabs: { minHeight: 45, flexDirection: 'row', padding: 4, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }, tab: { flex: 1, minHeight: 35, alignItems: 'center', justifyContent: 'center', borderRadius: 9 }, tabActive: { backgroundColor: theme.colors.primary }, tabText: { fontSize: 12, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textSecondary }, tabTextActive: { color: theme.colors.background }, tabCount: { fontFamily: theme.fonts.monoMedium, opacity: 0.78 }, search: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 13, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }, searchInput: { flex: 1, color: theme.colors.textPrimary, fontSize: 13, fontFamily: theme.fonts.sans }, filters: { flexDirection: 'row', gap: 7 }, filter: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: theme.colors.surfaceInset }, filterActive: { backgroundColor: theme.colors.primarySoft }, filterText: { fontSize: 12, fontFamily: theme.fonts.sansMedium, color: theme.colors.textSecondary }, filterTextActive: { color: theme.colors.primary },
  cards: { gap: 9 }, tradeCard: { position: 'relative', overflow: 'hidden', gap: 10, paddingVertical: 14, paddingHorizontal: 16, paddingLeft: 18, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.cardBorder, backgroundColor: theme.colors.surface, ...theme.shadow.card }, lightTradeShadow: { shadowColor: '#52616c', shadowOffset: { width: 0, height: 9 }, shadowOpacity: 0.075, shadowRadius: 22, elevation: 2 }, pressed: { opacity: 0.8 }, tradeAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 }, accentPositive: { backgroundColor: theme.colors.primary }, accentNegative: { backgroundColor: theme.colors.danger }, tradeTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }, pair: { fontSize: 16, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, tradeR: { fontSize: 15, fontFamily: theme.fonts.monoSemiBold }, tradeSub: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 17 }, side: { fontSize: 10, fontFamily: theme.fonts.sansBold, letterSpacing: 0.55 }, meta: { fontSize: 11, fontFamily: theme.fonts.sansMedium, color: theme.colors.textMuted }, resultBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, fontSize: 9, fontFamily: theme.fonts.sansBold, letterSpacing: 0.65, overflow: 'hidden' }, levels: { flexDirection: 'row', gap: 5 }, level: { flex: 1, minWidth: 0 }, levelLabel: { fontSize: 8, fontFamily: theme.fonts.sansSemiBold, letterSpacing: 0.55, textTransform: 'uppercase', color: theme.colors.textMuted }, levelValue: { marginTop: 3, fontSize: 11, fontFamily: theme.fonts.monoMedium, color: theme.colors.textPrimary }, flow: { fontSize: 13, fontFamily: theme.fonts.monoMedium, color: theme.colors.textPrimary }, tradeFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, footText: { flex: 1, fontSize: 11, fontFamily: theme.fonts.sans, color: theme.colors.textMuted }, tradeMoney: { fontSize: 12, fontFamily: theme.fonts.monoSemiBold }, positive: { color: theme.colors.primary }, negative: { color: theme.colors.danger }, muted: { color: theme.colors.textMuted }, error: { fontSize: 12, fontFamily: theme.fonts.sansMedium, color: theme.colors.danger }, empty: { paddingVertical: 30, textAlign: 'center', fontSize: 13, fontFamily: theme.fonts.sans, color: theme.colors.textMuted }, emptyCard: { paddingVertical: 24, alignItems: 'center' }, emptyTitle: { fontSize: 15, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, emptyDetail: { maxWidth: 250, marginTop: 5, textAlign: 'center', fontSize: 12, lineHeight: 17, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, loading: { minHeight: 260, alignItems: 'center', justifyContent: 'center' }, loadMore: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }, loadMoreText: { fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textSecondary },
});
