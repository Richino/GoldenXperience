import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, type LayoutChangeEvent, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  BarChart3,
  Bell,
  CalendarRange,
  CandlestickChart,
  ChevronDown,
  Circle,
  Crosshair,
  Layers,
  LineChart,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Waves,
  type LucideIcon,
} from 'lucide-react-native';
import { SymbolView } from 'expo-symbols';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/AppText';
import { TradeDrawer } from '@/components/chart/TradeDrawer';
import { NotificationDrawer } from '@/components/home/NotificationDrawer';
import { BottomDrawer } from '@/components/ui/BottomDrawer';
import { DockFade } from '@/components/ui/DockFade';
import { rawColors, theme } from '@/constants/theme';
import { webAppUrl } from '@/lib/api/config';
import { apiFetchDelete, apiGet, apiPost } from '@/lib/api/client';
import { getMarketCondition } from '@/lib/time';
import { loadChartPreferences, saveChartPreferences, type SavedChartPreferences } from '@/lib/chart/chart-preferences';
import { usePreferences } from '@/lib/preferences/PreferencesContext';
import type { PendingEntry } from '@/types/api';

const PAIRS = ['EUR_USD', 'USD_JPY', 'GBP_USD', 'AUD_USD', 'USD_CAD', 'USD_CHF', 'NZD_USD', 'EUR_JPY', 'EUR_GBP', 'GBP_JPY'] as const;
const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H'] as const;
const RANGES = ['1D', '1W', '1M', '3M', '1Y'] as const;
const CHART_VARIANTS = [
  { value: 'candle', label: 'Candles' },
  { value: 'hollow', label: 'Hollow candles' },
  { value: 'heikin', label: 'Heikin Ashi' },
  { value: 'bar', label: 'Bars' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'baseline', label: 'Baseline' },
] as const;
const CHART_INDICATORS = [
  { value: 'support-resistance', label: 'Support & resistance', group: 'overlay' as const },
  { value: 'swing-trend-lines', label: 'Swing trend lines', group: 'overlay' as const },
  { value: 'adaptive-swing-trendlines-v1', label: 'Adaptive Swing Trendlines V1', group: 'overlay' as const },
  { value: 'ema21', label: 'EMA 21', group: 'overlay' as const },
  { value: 'ema50', label: 'EMA 50', group: 'overlay' as const },
  { value: 'ema200', label: 'EMA 200', group: 'overlay' as const },
  { value: 'atr14', label: 'ATR 14', group: 'overlay' as const },
  { value: 'rsi14', label: 'RSI 14', group: 'overlay' as const },
  { value: 'spread-filter', label: 'Spread filter', group: 'filter' as const },
  { value: 'session-filter', label: 'Session filter', group: 'filter' as const },
  { value: 'news-filter', label: 'News filter', group: 'filter' as const },
] as const;
const INDICATOR_GROUPS = [
  { title: 'Overlays', options: CHART_INDICATORS.filter((item) => item.group === 'overlay') },
  { title: 'Filters', options: CHART_INDICATORS.filter((item) => item.group === 'filter') },
] as const;
type Timeframe = typeof TIMEFRAMES[number];
type Range = typeof RANGES[number];
type Variant = typeof CHART_VARIANTS[number]['value'];
type ChartIndicator = typeof CHART_INDICATORS[number]['value'];
type ManualTradeAction = 'trade' | 'cancel' | 'close';
const ALLOWED_CHART_INDICATORS = new Set<string>(CHART_INDICATORS.map((item) => item.value));

function sanitizeIndicators(raw: string[]): ChartIndicator[] {
  return raw.filter((item): item is ChartIndicator => ALLOWED_CHART_INDICATORS.has(item));
}
type WebChartTimeframe = '1m' | '5m' | '15m' | '1h' | '4h';
type ChartState = {
  instrument?: string;
  price: number;
  priceLabel?: string;
  bid?: number | null;
  ask?: number | null;
  change: number;
  changePercent: number;
  positive: boolean;
  timeframe?: WebChartTimeframe;
  range?: Range;
  variant?: Variant;
};
type NativeTrendPullbackResult = {
  status: 'TRADE_PLAN' | 'ENTRY_AVAILABLE_NOW' | 'NO_VALID_ENTRY';
  currentMove: 'BEARISH_PULLBACK' | 'BULLISH_PULLBACK' | 'NONE';
  priceBasis: 'LIVE_QUOTE' | 'LAST_M15_CLOSE';
  action: 'LONG' | 'SHORT' | null;
  orderType: 'BUY_LIMIT' | 'SELL_LIMIT' | null;
  entry: number | null;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  distanceToEntryPips: number | null;
  stopLoss: number | null;
  stopDistancePips: number | null;
  takeProfit: number | null;
  targetDistancePips: number | null;
  riskReward: number | null;
  reasons: string[];
  // Loose V1 fields (older web builds omit them).
  warnings?: string[];
  trend?: string;
  trendSource?: string;
  currentPrice?: number;
  debug?: { pullbackLevelKind?: string | null; h1AtrPips?: number | null };
};

const VARIANT_ICONS: Record<Variant, LucideIcon> = {
  candle: CandlestickChart,
  hollow: Circle,
  heikin: Layers,
  bar: BarChart3,
  line: LineChart,
  area: TrendingUp,
  baseline: Waves,
};

function pairLabel(instrument: string) { return instrument.replace('_', '/'); }
function price(value: number | null, instrument: string) { return value === null || !Number.isFinite(value) ? '—' : value.toFixed(instrument.includes('JPY') ? 3 : 5); }

function resolveInstrumentParam(raw: string | string[] | undefined) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const upper = typeof value === 'string' ? value.toUpperCase() : 'EUR_USD';
  return PAIRS.includes(upper as typeof PAIRS[number]) ? upper : 'EUR_USD';
}

function requestedTrade(raw: string | string[] | undefined) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

const WEB_TIMEFRAME: Record<Timeframe, WebChartTimeframe> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1H': '1h',
  '4H': '4h',
};

const NATIVE_TIMEFRAME: Record<WebChartTimeframe, Timeframe> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
};

function preferencesPayload(
  timeframe: Timeframe,
  range: Range,
  variant: Variant,
  indicators: ChartIndicator[],
) {
  return JSON.stringify({
    timeframe: WEB_TIMEFRAME[timeframe],
    range,
    variant,
    indicators,
  });
}

/** Native mobile controls around the isolated live GX chart canvas. */
export default function ChartScreen() {
  const params = useLocalSearchParams<{ instrument?: string | string[]; trade?: string | string[] }>();
  const requested = resolveInstrumentParam(params.instrument);
  const [instrument, setInstrument] = useState(() => requested);
  // A past trade to show on the chart, set by links such as Recent activity.
  const [focusTradeId, setFocusTradeId] = useState<string | null>(() => requestedTrade(params.trade));
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [range, setRange] = useState<Range>('1D');
  const [variant, setVariant] = useState<Variant>('area');
  const [chartState, setChartState] = useState<ChartState | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pairsOpen, setPairsOpen] = useState(false);
  const [rangesOpen, setRangesOpen] = useState(false);
  const [positionOpen, setPositionOpen] = useState(false);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [enabledIndicators, setEnabledIndicators] = useState<ChartIndicator[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);
  const [tradeDraft, setTradeDraft] = useState<{ direction: 'long' | 'short'; entry: number; stop: number; target: number; analysisContext?: Record<string, unknown> } | null>(null);
  const [manualEntries, setManualEntries] = useState<PendingEntry[]>([]);
  const [confirmTradeAction, setConfirmTradeAction] = useState<Exclude<ManualTradeAction, 'trade'> | null>(null);
  const [tradeActionBusy, setTradeActionBusy] = useState(false);
  const [tradeActionError, setTradeActionError] = useState<string | null>(null);
  const [prefsReady, setPrefsReady] = useState(false);
  const [marketBusy, setMarketBusy] = useState(false);
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<NativeTrendPullbackResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [timeframeWidth, setTimeframeWidth] = useState(0);
  const activeTimeframeIndex = useSharedValue(TIMEFRAMES.indexOf(timeframe));
  const webView = useRef<WebView>(null);
  const webReadyRef = useRef(false);
  const insets = useSafeAreaInsets();
  const session = getMarketCondition();
  const { themeMode } = usePreferences();
  const pageBg = rawColors[themeMode].chartPage;

  useEffect(() => {
    let cancelled = false;
    void loadChartPreferences().then((saved) => {
      if (cancelled) return;
      setTimeframe(saved.timeframe as Timeframe);
      setRange(saved.range as Range);
      setVariant(saved.variant as Variant);
      setEnabledIndicators(sanitizeIndicators(saved.indicators));
      setPrefsReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const refreshManualEntries = useCallback(async () => {
    try {
      const payload = await apiGet<{ entries?: PendingEntry[] }>(`/api/pending-entries?instrument=${encodeURIComponent(instrument)}`);
      setManualEntries(payload.entries ?? []);
    } catch {
      // The order action must remain available if this supporting read is
      // temporarily unavailable; its endpoint will still report a conflict.
      setManualEntries([]);
    }
  }, [instrument]);

  useFocusEffect(
    useCallback(() => {
      const next = resolveInstrumentParam(params.instrument);
      setInstrument((current) => (current === next ? current : next));
      const trade = requestedTrade(params.trade);
      if (trade) setFocusTradeId(trade);
      setChartState(null);
      webReadyRef.current = false;
      void refreshManualEntries();
    }, [params.instrument, params.trade, refreshManualEntries]),
  );

  useEffect(() => {
    setChartState(null);
    webReadyRef.current = false;
  }, [instrument]);

  useEffect(() => {
    void refreshManualEntries();
  }, [refreshManualEntries]);

  useEffect(() => {
    activeTimeframeIndex.value = withTiming(TIMEFRAMES.indexOf(timeframe), {
      duration: 260,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
    });
  }, [activeTimeframeIndex, timeframe]);

  const source = useMemo(() => webAppUrl(`/embed/chart?instrument=${encodeURIComponent(instrument)}&native=1`), [instrument]);
  const webViewThemeBootstrap = useMemo(
    () => `(function(){var t=${JSON.stringify(themeMode)};var bg=t==='light'?'#ffffff':'#09090b';document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.style.backgroundColor=bg;if(document.body)document.body.style.backgroundColor=bg;})();true;`,
    [themeMode],
  );
  const themedScreen = useMemo(
    () => ({
      root: { backgroundColor: pageBg },
      header: { backgroundColor: pageBg },
      chartFrame: { backgroundColor: pageBg },
      webview: { backgroundColor: pageBg },
      loading: { backgroundColor: pageBg },
      toolbar: { backgroundColor: pageBg },
      errorState: { backgroundColor: pageBg },
    }),
    [pageBg],
  );
  const command = useCallback((action: string, value?: string) => {
    webView.current?.postMessage(JSON.stringify({ type: 'gx-native-chart-command', action, value }));
  }, []);

  const pushChartPreferences = useCallback(() => {
    command('preferences', preferencesPayload(timeframe, range, variant, enabledIndicators));
    command('theme', themeMode);
    command('instrument', instrument);
    command('focus-trade', focusTradeId ?? '');
  }, [command, enabledIndicators, focusTradeId, instrument, range, themeMode, timeframe, variant]);

  useEffect(() => {
    if (!prefsReady) return;
    const snapshot: SavedChartPreferences = {
      timeframe,
      range,
      variant,
      indicators: enabledIndicators,
    };
    void saveChartPreferences(snapshot);
  }, [enabledIndicators, prefsReady, range, timeframe, variant]);

  useEffect(() => {
    if (!prefsReady || loading || !webReadyRef.current) return;
    pushChartPreferences();
  }, [enabledIndicators, focusTradeId, loading, prefsReady, pushChartPreferences, range, timeframe, variant]);

  // Native owns timeframe, range and chart type; the web chart only reports
  // what it is showing. Adopting its report let a state message sent before a
  // preference arrived (or a push the page missed while loading) flip the
  // saved choice back to the web default, e.g. candles → area.
  const reconciledAtRef = useRef(0);
  const handleWebMessage = (data: string) => {
    let message: { type?: string; result?: NativeTrendPullbackResult; error?: string } & Partial<ChartState>;
    try { message = JSON.parse(data) as typeof message; } catch { return; }
    if (message.type === 'gx-native-trend-pullback-result' && message.result) {
      setAnalysisResult(message.result);
      setAnalysisError(null);
      setAnalysisBusy(false);
      setAnalysisModalOpen(true);
      return;
    }
    if (message.type === 'gx-native-trend-pullback-error') {
      setAnalysisResult(null);
      setAnalysisError(message.error ?? 'TrendPullbackV1 could not run.');
      setAnalysisBusy(false);
      setAnalysisModalOpen(true);
      return;
    }
    if (message.type === 'gx-native-trade-focus-cleared') {
      setFocusTradeId(null);
      router.setParams({ trade: undefined });
      return;
    }
    if (message.type === 'gx-native-chart-ready') {
      webReadyRef.current = true;
      if (prefsReady) pushChartPreferences();
      return;
    }
    if (message.type !== 'gx-native-chart-state' || typeof message.price !== 'number') return;
    if (message.instrument && message.instrument !== instrument) return;
    setChartState(message as ChartState);
    webReadyRef.current = true;
    const drifted =
      (message.timeframe !== undefined && NATIVE_TIMEFRAME[message.timeframe] !== timeframe)
      || (message.range !== undefined && message.range !== range)
      || (message.variant !== undefined && message.variant !== variant);
    if (!drifted) {
      setMarketBusy(false);
      return;
    }
    // A mismatch right after a change is just the old state still in flight;
    // one that persists means the page missed a push, so resend (throttled).
    const now = Date.now();
    if (prefsReady && now - reconciledAtRef.current > 1500) {
      reconciledAtRef.current = now;
      pushChartPreferences();
    }
  };

  // The embedded page starts from its own default/system theme, which has no
  // way to know the app's in-Settings choice — push it on load and whenever
  // it changes while this tab stays mounted (e.g. flipping Theme in Settings
  // without leaving Chart).
  useEffect(() => { if (!loading) command('theme', themeMode); }, [themeMode, loading]);
  const activeVariant = CHART_VARIANTS.find((option) => option.value === variant) ?? CHART_VARIANTS[5];
  const VariantIcon = VARIANT_ICONS[variant];
  const selectPair = (next: typeof PAIRS[number]) => {
    setInstrument(next);
    setPairsOpen(false);
    setChartState(null);
    setFocusTradeId(null);
    router.setParams({ instrument: next, trade: undefined });
    command('instrument', next);
  };
  const selectTimeframe = (next: Timeframe) => {
    if (next === timeframe) return;
    setMarketBusy(true);
    setTimeframe(next);
  };
  const timeframeColumnWidth = Math.max(0, timeframeWidth - 6) / TIMEFRAMES.length;
  const timeframeLensStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: activeTimeframeIndex.value * timeframeColumnWidth }] }),
    [timeframeColumnWidth],
  );
  const onTimeframeLayout = (event: LayoutChangeEvent) => setTimeframeWidth(event.nativeEvent.layout.width);
  const hasPendingManualEntry = manualEntries.some((entry) => entry.status === 'PENDING' || entry.status === 'TRIGGERING');
  const hasOpenManualTrade = manualEntries.some((entry) => entry.status === 'TRIGGERED' && entry.paperTradeStatus === 'open');
  const hasBlockingManualTrade = hasPendingManualEntry || hasOpenManualTrade;
  const analyzeChart = () => {
    if (hasBlockingManualTrade) return;
    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisBusy(true);
    setAnalysisModalOpen(true);
    setEnabledIndicators((current) => current.filter((indicator) =>
      indicator !== 'adaptive-swing-trendlines-v1' && indicator !== 'swing-trend-lines'));
    if (timeframe !== '15m') {
      setMarketBusy(true);
      setTimeframe('15m');
      command('timeframe', '15m');
    }
    command('analyze');
  };
  const cancelAnalysis = () => {
    command('cancel-analysis');
    setAnalysisBusy(false);
    setAnalysisModalOpen(false);
  };
  const acceptAnalysis = (plan: NativeTrendPullbackResult) => {
    if (!plan.action || plan.entry === null || plan.stopLoss === null || plan.takeProfit === null) return;
    const direction = plan.action === 'LONG' ? 'long' : 'short';
    setTradeDraft({
      direction, entry: plan.entry, stop: plan.stopLoss, target: plan.takeProfit,
      // Same shape the web builds, so forward-test trades are tagged either way.
      analysisContext: {
        version: 1,
        direction,
        setup: 'trend-pullback-loose-v1',
        frozen: {
          trend: plan.trend ?? null,
          trendSource: plan.trendSource ?? null,
          currentMove: plan.currentMove,
          pullbackLevelKind: plan.debug?.pullbackLevelKind ?? null,
          h1AtrPips: plan.debug?.h1AtrPips ?? null,
          planned: { entry: plan.entry, stop: plan.stopLoss, target: plan.takeProfit, currentPrice: plan.currentPrice ?? null, status: plan.status },
          warnings: plan.warnings ?? [],
        },
      },
    });
    setAnalysisModalOpen(false);
    // BottomDrawer keeps its native Modal mounted for its exit animation.
    // Open the next drawer after that Modal is gone so it cannot be hidden beneath it.
    setTimeout(() => setTradeOpen(true), 260);
  };
  const selectRange = (next: Range) => {
    if (next === range) { setRangesOpen(false); return; }
    setMarketBusy(true);
    setRange(next);
    setRangesOpen(false);
  };
  const selectVariant = (next: Variant) => {
    setVariant(next);
    setVariantsOpen(false);
  };
  const toggleIndicator = (indicator: ChartIndicator) => {
    setEnabledIndicators((current) => (current.includes(indicator) ? current.filter((item) => item !== indicator) : [...current, indicator]));
  };
  const activeManualEntry = manualEntries.find((entry) => entry.status === 'TRIGGERED' && entry.paperTradeStatus === 'open')
    ?? manualEntries.find((entry) => entry.status === 'PENDING' || entry.status === 'TRIGGERING')
    ?? null;
  const manualTradeAction: ManualTradeAction = activeManualEntry?.status === 'TRIGGERED' ? 'close' : activeManualEntry ? 'cancel' : 'trade';
  const tradeActionLabel = manualTradeAction === 'close' ? 'Close trade' : manualTradeAction === 'cancel' ? 'Cancel' : 'Trade';
  const handleTradeAction = () => {
    setTradeActionError(null);
    if (manualTradeAction === 'trade') {
      setTradeOpen(true);
      return;
    }
    setConfirmTradeAction(manualTradeAction);
  };
  const executeTradeAction = async () => {
    if (!confirmTradeAction || !activeManualEntry) return;
    setTradeActionBusy(true);
    setTradeActionError(null);
    try {
      if (confirmTradeAction === 'cancel') {
        await apiFetchDelete(`/api/pending-entries/${activeManualEntry.id}`);
      } else {
        await apiPost(`/api/pending-entries/${activeManualEntry.id}/close`, { instrument });
      }
      setConfirmTradeAction(null);
      command('refresh');
      await refreshManualEntries();
    } catch (error) {
      setTradeActionError(error instanceof Error ? error.message : `Could not ${confirmTradeAction === 'cancel' ? 'cancel the pending trade' : 'close the trade'}.`);
    } finally {
      setTradeActionBusy(false);
    }
  };

  if (failed) return <View style={[styles.errorState, themedScreen.errorState]}><Text style={styles.errorTitle}>Chart unavailable</Text><Text style={styles.errorCopy}>Check that the GX web app is reachable on this device, then try again.</Text><Pressable onPress={() => { setFailed(false); setLoading(true); setRetry((value) => value + 1); }} style={styles.retry}><Text style={styles.retryText}>Retry chart</Text></Pressable></View>;

  return <View style={[styles.root, themedScreen.root]}>
    <View style={[styles.header, themedScreen.header, { paddingTop: Math.max(insets.top + 8, 24) }]}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => setPairsOpen(true)} style={styles.pairButton} accessibilityRole="button" accessibilityLabel="Select currency pair"><Text style={styles.pair}>{pairLabel(instrument)}</Text><ChevronDown size={16} strokeWidth={2} color={theme.colors.textSecondary} /></Pressable>
        <View style={styles.headerActions}><Pressable onPress={analyzeChart} disabled={hasBlockingManualTrade} style={[styles.analyze, hasBlockingManualTrade ? styles.analyzeDisabled : null]} accessibilityRole="button" accessibilityLabel={hasBlockingManualTrade ? 'Analyze unavailable while a pending or open trade exists' : 'Analyze with TrendPullbackV1'}><Sparkles size={18} strokeWidth={2} color="#ffffff" /></Pressable><Pressable onPress={() => setNotificationsOpen(true)} style={styles.bell} accessibilityRole="button" accessibilityLabel="Open notifications"><Bell size={19} strokeWidth={2} color={theme.colors.textSecondary} /></Pressable></View>
      </View>
      <View style={styles.quoteRow}><Text style={styles.quote}>{chartState?.priceLabel ?? price(chartState?.price ?? null, instrument)}</Text><Text style={[styles.change, chartState?.positive === false ? styles.down : styles.up]}>{chartState ? `${chartState.positive ? '+' : ''}${chartState.change.toFixed(instrument.includes('JPY') ? 3 : 5)}  ${chartState.positive ? '+' : ''}${chartState.changePercent.toFixed(2)}%` : 'Live quote'}</Text><Text style={styles.session}>{session.marketOpen ? `${session.label} session` : 'Market closed'}</Text></View>
      <View style={styles.timeframes} onLayout={onTimeframeLayout}>{timeframeColumnWidth > 0 ? <Animated.View pointerEvents="none" style={[styles.timeframeLens, { width: timeframeColumnWidth }, timeframeLensStyle]} /> : null}{TIMEFRAMES.map((option) => <TimeframeItem key={option} option={option} active={timeframe === option} onPress={() => selectTimeframe(option)} />)}</View>
    </View>
    <View style={[styles.chartFrame, themedScreen.chartFrame]}>
      <WebView key={`${instrument}-${retry}`} ref={webView} source={{ uri: source }} style={[styles.webview, themedScreen.webview]} originWhitelist={['*']} sharedCookiesEnabled thirdPartyCookiesEnabled cacheEnabled={false} javaScriptEnabled domStorageEnabled injectedJavaScriptBeforeContentLoaded={webViewThemeBootstrap} onLoadStart={() => { setLoading(true); webReadyRef.current = false; }} onLoadEnd={() => { setLoading(false); webReadyRef.current = true; setTimeout(() => { pushChartPreferences(); }, 0); }} onMessage={(event) => handleWebMessage(event.nativeEvent.data)} onError={() => { setLoading(false); setFailed(true); setMarketBusy(false); }} onHttpError={(event) => { if (event.nativeEvent.statusCode >= 400) { setLoading(false); setFailed(true); setMarketBusy(false); } }} />
      {loading || marketBusy ? <View pointerEvents="none" style={[styles.loading, themedScreen.loading]}><ActivityIndicator color={theme.colors.primary} /><Text style={styles.loadingText}>{loading ? 'Loading chart…' : 'Updating chart…'}</Text></View> : null}
    </View>
    <View style={[styles.toolbar, themedScreen.toolbar]}><Tool icon={SlidersHorizontal} label="Indicators" active={enabledIndicators.length > 0} onPress={() => setIndicatorsOpen(true)} /><Tool icon={Crosshair} label="Fixed 10-pip setup" onPress={() => setPositionOpen(true)} /><Tool icon={CalendarRange} label={`Visible range · ${range}`} active={false} onPress={() => setRangesOpen(true)} /><Tool icon={VariantIcon} label={`Chart type · ${activeVariant.label}`} onPress={() => setVariantsOpen(true)} /><Tool icon={RotateCcw} label="Reset chart view" onPress={() => command('reset')} /></View>
    <View style={styles.tradeAction}>{tradeActionError ? <Text style={styles.tradeActionError} accessibilityRole="alert">{tradeActionError}</Text> : null}<Pressable onPress={handleTradeAction} disabled={tradeActionBusy} style={[styles.tradeButton, manualTradeAction === 'cancel' ? styles.cancelTradeButton : manualTradeAction === 'close' ? styles.closeTradeButton : null, tradeActionBusy ? styles.tradeButtonDisabled : null]} accessibilityRole="button" accessibilityLabel={tradeActionLabel}><Text style={styles.tradeButtonText}>{tradeActionBusy ? 'Working…' : tradeActionLabel}</Text></Pressable></View>
    <DockFade height={96} />
    <BottomDrawer visible={pairsOpen} onClose={() => setPairsOpen(false)} eyebrow="Chart" title="Select pair">{PAIRS.map((option) => <Pressable key={option} onPress={() => selectPair(option)} style={[styles.drawerRow, instrument === option ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{pairLabel(option)}</Text>{instrument === option ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>)}</BottomDrawer>
    <BottomDrawer visible={rangesOpen} onClose={() => setRangesOpen(false)} eyebrow="Chart" title="Visible range">{RANGES.map((option) => <Pressable key={option} onPress={() => selectRange(option)} style={[styles.drawerRow, range === option ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{option}</Text>{range === option ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>)}</BottomDrawer>
    <BottomDrawer visible={variantsOpen} onClose={() => setVariantsOpen(false)} eyebrow="Chart" title="Chart type">{CHART_VARIANTS.map((option) => <Pressable key={option.value} onPress={() => selectVariant(option.value)} style={[styles.drawerRow, variant === option.value ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{option.label}</Text>{variant === option.value ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>)}</BottomDrawer>
    <BottomDrawer visible={indicatorsOpen} onClose={() => setIndicatorsOpen(false)} eyebrow="Chart" title="Indicators" scrollable>{INDICATOR_GROUPS.map((group) => <View key={group.title}><Text style={styles.drawerGroupTitle}>{group.title}</Text>{group.options.map((option) => { const on = enabledIndicators.includes(option.value); return <Pressable key={option.value} onPress={() => toggleIndicator(option.value)} style={[styles.drawerRow, on ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{option.label}</Text>{on ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>; })}</View>)}</BottomDrawer>
    <BottomDrawer visible={positionOpen} onClose={() => setPositionOpen(false)} eyebrow="Chart" title="Fixed 10-pip setup"><Text style={styles.drawerCopy}>Risk and reward are both fixed at 10 pips. Choose a direction to place the movable setup on the chart.</Text><View style={styles.directionRow}><Pressable onPress={() => { setPositionOpen(false); command('position', 'long'); }} style={[styles.directionButton, styles.longButton]}><Text style={styles.directionText}>Long</Text></Pressable><Pressable onPress={() => { setPositionOpen(false); command('position', 'short'); }} style={[styles.directionButton, styles.shortButton]}><Text style={styles.directionText}>Short</Text></Pressable></View></BottomDrawer>
    <NotificationDrawer visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    <TradeDrawer
      visible={tradeOpen}
      onClose={() => { setTradeOpen(false); setTradeDraft(null); }}
      instrument={instrument}
      bid={chartState?.bid ?? null}
      ask={chartState?.ask ?? null}
      draft={tradeDraft}
      onCreated={() => { command('refresh'); void refreshManualEntries(); }}
    />
    <BottomDrawer visible={confirmTradeAction !== null} onClose={() => { if (!tradeActionBusy) setConfirmTradeAction(null); }} title={confirmTradeAction === 'cancel' ? 'Cancel pending trade?' : 'Close active trade?'}>
      <Text style={styles.confirmCopy}>{confirmTradeAction === 'cancel' ? 'This removes the pending order. It will not open a trade.' : 'This closes the open paper trade at the current available price.'}</Text>
      <View style={styles.confirmActions}><Pressable onPress={() => setConfirmTradeAction(null)} disabled={tradeActionBusy} style={[styles.confirmSecondary, tradeActionBusy ? styles.tradeButtonDisabled : null]}><Text style={styles.confirmSecondaryText}>Keep trade</Text></Pressable><Pressable onPress={() => void executeTradeAction()} disabled={tradeActionBusy} style={[styles.confirmPrimary, confirmTradeAction === 'cancel' ? styles.cancelTradeButton : styles.closeTradeButton, tradeActionBusy ? styles.tradeButtonDisabled : null]}><Text style={styles.tradeButtonText}>{tradeActionBusy ? 'Working…' : confirmTradeAction === 'cancel' ? 'Cancel pending trade' : 'Close trade'}</Text></Pressable></View>
    </BottomDrawer>
    <NativeTrendPullbackModal visible={analysisModalOpen} busy={analysisBusy} result={analysisResult} error={analysisError} instrument={instrument} onClose={() => setAnalysisModalOpen(false)} onCancel={cancelAnalysis} onAccept={acceptAnalysis} />
  </View>;
}

function NativeTrendPullbackModal({ visible, busy, result, error, instrument, onClose, onCancel, onAccept }: { visible: boolean; busy: boolean; result: NativeTrendPullbackResult | null; error: string | null; instrument: string; onClose: () => void; onCancel: () => void; onAccept: (plan: NativeTrendPullbackResult) => void }) {
  const plan = result?.status !== 'NO_VALID_ENTRY' ? result : null;
  return <BottomDrawer visible={visible} onClose={busy ? onCancel : onClose} title={busy ? 'Analyzing chart' : plan ? result?.status === 'ENTRY_AVAILABLE_NOW' ? 'Entry available now' : plan.currentMove === 'NONE' ? 'Next pullback level' : 'Planned pullback entry' : error ? 'Analysis unavailable' : 'No trade plan'}>
    {busy ? <><ActivityIndicator style={styles.analysisSpinner} color={theme.colors.primary} /><Text style={styles.analysisCopy}>Loading fresh candles and the current OANDA price.</Text><Pressable onPress={onCancel} style={styles.analysisSecondary}><Text style={styles.analysisSecondaryText}>Cancel</Text></Pressable></> : plan ? <><View style={styles.analysisTitleRow}><Text style={[styles.analysisDirection, plan.action === 'LONG' ? styles.analysisLong : styles.analysisShort]}>{plan.action}</Text></View><View style={styles.analysisEntry}><Text style={styles.analysisLabel}>Entry</Text><Text style={styles.analysisEntryPrice}>{price(plan.entry, instrument)}</Text><Text style={styles.analysisCopy}>{plan.distanceToEntryPips?.toFixed(1) ?? '—'} pips away</Text></View><View style={styles.analysisLevels}><View style={styles.analysisLevel}><Text style={styles.analysisStopLabel}>Stop loss</Text><Text style={styles.analysisLevelPrice}>{price(plan.stopLoss, instrument)}</Text><Text style={styles.analysisLevelCopy}>{plan.stopDistancePips?.toFixed(1) ?? '—'} pips risk</Text></View><View style={styles.analysisLevel}><Text style={styles.analysisTargetLabel}>Take profit</Text><Text style={styles.analysisLevelPrice}>{price(plan.takeProfit, instrument)}</Text><Text style={styles.analysisLevelCopy}>{plan.targetDistancePips?.toFixed(1) ?? '—'} pips reward</Text></View></View><View style={styles.analysisRr}><Text style={styles.analysisCopy}>Risk / reward</Text><Text style={styles.analysisRrValue}>{plan.riskReward?.toFixed(2) ?? '—'}:1</Text></View><View style={styles.analysisActions}><Pressable onPress={onClose} style={[styles.analysisPrimary, styles.analysisReject]}><Text style={styles.analysisPrimaryText}>Reject</Text></Pressable><Pressable onPress={() => onAccept(plan)} style={styles.analysisPrimary}><Text style={styles.analysisPrimaryText}>Accept</Text></Pressable></View></> : <><Text style={styles.analysisCopy}>{error ?? result?.reasons[0] ?? 'TrendPullbackV1 could not form a valid setup.'}</Text><Pressable onPress={onClose} style={styles.analysisPrimary}><Text style={styles.analysisPrimaryText}>Done</Text></Pressable></>}
  </BottomDrawer>;
}

function Tool({ icon: Icon, label, active = false, onPress }: { icon: LucideIcon; label: string; active?: boolean; onPress: () => void }) {
  const color = active ? theme.colors.primary : theme.colors.textSecondary;
  return (
    <Pressable onPress={onPress} style={[styles.tool, active ? styles.toolActive : null]} accessibilityRole="button" accessibilityLabel={label}>
      <Icon size={22} strokeWidth={1.85} color={color} />
    </Pressable>
  );
}

function TimeframeItem({ option, active, onPress }: { option: Timeframe; active: boolean; onPress: () => void }) {
  const pressProgress = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(pressProgress.value, [0, 1], [1, 0.9]) }] }));
  return <Pressable onPress={onPress} onPressIn={() => { pressProgress.value = withTiming(1, { duration: 75 }); }} onPressOut={() => { pressProgress.value = withSpring(0, { damping: 15, stiffness: 230, mass: 0.4 }); }} style={styles.timeframe} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`${option} timeframe`}><Animated.View style={pressStyle}><Text style={[styles.timeframeText, active ? styles.timeframeTextActive : null]}>{option}</Text></Animated.View></Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, header: { paddingHorizontal: 16, paddingBottom: 10, gap: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.cardBorder }, headerRow: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, pairButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5 }, pair: { fontSize: 15, fontFamily: theme.fonts.sansBold, color: theme.colors.textPrimary }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 }, analyze: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: theme.colors.primary }, analyzeDisabled: { opacity: 0.38 }, bell: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: theme.colors.surfaceRaised },
  quoteRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }, quote: { fontSize: 22, fontFamily: theme.fonts.monoBold, color: theme.colors.textPrimary, letterSpacing: -0.5 }, change: { fontSize: 11, fontFamily: theme.fonts.monoMedium }, up: { color: theme.colors.primary }, down: { color: theme.colors.danger }, session: { marginLeft: 'auto', fontSize: 10, fontFamily: theme.fonts.sansSemiBold, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.colors.textMuted }, timeframes: { position: 'relative', minHeight: 39, flexDirection: 'row', padding: 3, overflow: 'hidden', borderRadius: 10, backgroundColor: theme.colors.surfaceRaised }, timeframeLens: { position: 'absolute', top: 3, bottom: 3, left: 3, borderRadius: 7, backgroundColor: theme.colors.primarySoft, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.primary }, timeframe: { zIndex: 1, flex: 1, minHeight: 33, alignItems: 'center', justifyContent: 'center' }, timeframeText: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textSecondary }, timeframeTextActive: { color: theme.colors.primary },
  chartFrame: { flex: 1, minHeight: 180 }, webview: { flex: 1 }, loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 9 }, loadingText: { fontSize: 13, fontFamily: theme.fonts.sansMedium, color: theme.colors.textSecondary }, toolbar: { zIndex: 6, minHeight: 52, flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 8, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.cardBorder }, tool: { flex: 1, minWidth: 0, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 11 }, toolActive: { backgroundColor: theme.colors.primarySoft }, tradeAction: { zIndex: 6, marginBottom: 94, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, backgroundColor: 'transparent' }, tradeActionError: { marginBottom: 8, textAlign: 'center', fontSize: 12, lineHeight: 17, fontFamily: theme.fonts.sansMedium, color: theme.colors.danger }, tradeButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.colors.primary }, cancelTradeButton: { backgroundColor: theme.colors.warning }, closeTradeButton: { backgroundColor: theme.colors.danger }, tradeButtonDisabled: { opacity: 0.55 }, tradeButtonText: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' }, confirmCopy: { marginHorizontal: 4, fontSize: 14, lineHeight: 20, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, confirmActions: { flexDirection: 'row', gap: 10, marginTop: 22, marginHorizontal: 4 }, confirmSecondary: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border }, confirmSecondaryText: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, confirmPrimary: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: theme.colors.primary },
  drawerRow: { minHeight: 49, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border, borderRadius: 10 }, drawerRowActive: { backgroundColor: theme.colors.primaryMuted }, drawerPair: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, drawerGroupTitle: { marginTop: 8, marginBottom: 4, paddingHorizontal: 12, fontSize: 11, fontFamily: theme.fonts.sansSemiBold, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.colors.textMuted }, drawerCopy: { marginHorizontal: 12, marginBottom: 14, fontSize: 13, lineHeight: 19, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, directionRow: { flexDirection: 'row', gap: 10, marginHorizontal: 12, paddingBottom: 8 }, directionButton: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }, longButton: { backgroundColor: theme.colors.primary }, shortButton: { backgroundColor: theme.colors.danger }, directionText: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' }, errorState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }, errorTitle: { fontSize: 19, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, errorCopy: { marginTop: 7, textAlign: 'center', fontSize: 13, lineHeight: 19, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, retry: { marginTop: 20, minHeight: 44, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.colors.primary }, retryText: { fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' },
  analysisTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginHorizontal: 4 }, analysisDirection: { fontSize: 20, fontFamily: theme.fonts.sansBold }, analysisLong: { color: theme.colors.primary }, analysisShort: { color: theme.colors.danger }, analysisSpinner: { marginTop: 14 }, analysisCopy: { marginTop: 8, marginHorizontal: 4, fontSize: 13, lineHeight: 19, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, analysisEntry: { marginTop: 18, marginHorizontal: 4, padding: 16, borderRadius: 16, backgroundColor: theme.colors.surfaceRaised }, analysisLabel: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, textTransform: 'uppercase', letterSpacing: 0.7, color: theme.colors.textMuted }, analysisEntryPrice: { marginTop: 5, fontSize: 30, fontFamily: theme.fonts.monoBold, letterSpacing: -0.7, color: theme.colors.textPrimary }, analysisLevels: { flexDirection: 'row', gap: 10, marginTop: 10, marginHorizontal: 4 }, analysisLevel: { flex: 1, padding: 13, borderRadius: 14, backgroundColor: theme.colors.surfaceRaised }, analysisStopLabel: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.danger }, analysisTargetLabel: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.primary }, analysisLevelPrice: { marginTop: 5, fontSize: 15, fontFamily: theme.fonts.monoBold, color: theme.colors.textPrimary }, analysisLevelCopy: { marginTop: 4, fontSize: 11, fontFamily: theme.fonts.sans, color: theme.colors.textMuted }, analysisRr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingHorizontal: 8 }, analysisRrValue: { fontSize: 16, fontFamily: theme.fonts.monoBold, color: theme.colors.textPrimary }, analysisActions: { flexDirection: 'row', gap: 10, marginHorizontal: 4, marginTop: 20 }, analysisPrimary: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 20, borderRadius: 13, backgroundColor: theme.colors.primary }, analysisPrimaryText: { fontSize: 15, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' }, analysisReject: { backgroundColor: theme.colors.danger }, analysisSecondary: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 20, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border }, analysisSecondaryText: { fontSize: 15, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary },
});
