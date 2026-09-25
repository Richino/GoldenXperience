import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
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

import { Text } from '@/components/ui/AppText';
import { TradeDrawer } from '@/components/chart/TradeDrawer';
import { NotificationDrawer } from '@/components/home/NotificationDrawer';
import { BottomDrawer } from '@/components/ui/BottomDrawer';
import { DockFade } from '@/components/ui/DockFade';
import { rawColors, theme } from '@/constants/theme';
import { webAppUrl } from '@/lib/api/config';
import { getMarketCondition } from '@/lib/time';
import { loadChartPreferences, saveChartPreferences, type SavedChartPreferences } from '@/lib/chart/chart-preferences';
import { usePreferences } from '@/lib/preferences/PreferencesContext';

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
  const params = useLocalSearchParams<{ instrument?: string | string[] }>();
  const requested = resolveInstrumentParam(params.instrument);
  const [instrument, setInstrument] = useState(() => requested);
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
  const [prefsReady, setPrefsReady] = useState(false);
  const [marketBusy, setMarketBusy] = useState(false);
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

  useFocusEffect(
    useCallback(() => {
      const next = resolveInstrumentParam(params.instrument);
      setInstrument((current) => (current === next ? current : next));
      setChartState(null);
      webReadyRef.current = false;
    }, [params.instrument]),
  );

  useEffect(() => {
    setChartState(null);
    webReadyRef.current = false;
  }, [instrument]);

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
  }, [command, enabledIndicators, instrument, range, themeMode, timeframe, variant]);

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
  }, [enabledIndicators, loading, prefsReady, pushChartPreferences, range, timeframe, variant]);

  // Native owns timeframe, range and chart type; the web chart only reports
  // what it is showing. Adopting its report let a state message sent before a
  // preference arrived (or a push the page missed while loading) flip the
  // saved choice back to the web default, e.g. candles → area.
  const reconciledAtRef = useRef(0);
  const handleWebMessage = (data: string) => {
    let message: { type?: string } & Partial<ChartState>;
    try { message = JSON.parse(data) as typeof message; } catch { return; }
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
    router.setParams({ instrument: next });
    command('instrument', next);
  };
  const selectTimeframe = (next: Timeframe) => {
    if (next === timeframe) return;
    setMarketBusy(true);
    setTimeframe(next);
  };
  const analyzeChart = () => {
    setEnabledIndicators((current) => current.includes('adaptive-swing-trendlines-v1')
      ? current : [...current, 'adaptive-swing-trendlines-v1']);
    if (timeframe !== '15m') {
      setMarketBusy(true);
      setTimeframe('15m');
      command('timeframe', '15m');
    }
    command('analyze');
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

  if (failed) return <View style={[styles.errorState, themedScreen.errorState]}><Text style={styles.errorTitle}>Chart unavailable</Text><Text style={styles.errorCopy}>Check that the GX web app is reachable on this device, then try again.</Text><Pressable onPress={() => { setFailed(false); setLoading(true); setRetry((value) => value + 1); }} style={styles.retry}><Text style={styles.retryText}>Retry chart</Text></Pressable></View>;

  return <View style={[styles.root, themedScreen.root]}>
    <View style={[styles.header, themedScreen.header, { paddingTop: Math.max(insets.top + 8, 24) }]}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => setPairsOpen(true)} style={styles.pairButton} accessibilityRole="button" accessibilityLabel="Select currency pair"><Text style={styles.pair}>{pairLabel(instrument)}</Text><ChevronDown size={16} strokeWidth={2} color={theme.colors.textSecondary} /></Pressable>
        <View style={styles.headerActions}><Pressable onPress={analyzeChart} style={styles.analyze} accessibilityRole="button" accessibilityLabel="Analyze with TrendPullbackV1"><Sparkles size={18} strokeWidth={2} color="#ffffff" /></Pressable><Pressable onPress={() => setNotificationsOpen(true)} style={styles.bell} accessibilityRole="button" accessibilityLabel="Open notifications"><Bell size={19} strokeWidth={2} color={theme.colors.textSecondary} /></Pressable></View>
      </View>
      <View style={styles.quoteRow}><Text style={styles.quote}>{chartState?.priceLabel ?? price(chartState?.price ?? null, instrument)}</Text><Text style={[styles.change, chartState?.positive === false ? styles.down : styles.up]}>{chartState ? `${chartState.positive ? '+' : ''}${chartState.change.toFixed(instrument.includes('JPY') ? 3 : 5)}  ${chartState.positive ? '+' : ''}${chartState.changePercent.toFixed(2)}%` : 'Live quote'}</Text><Text style={styles.session}>{session.marketOpen ? `${session.label} session` : 'Market closed'}</Text></View>
      <View style={styles.timeframes}>{TIMEFRAMES.map((option) => <Pressable key={option} onPress={() => selectTimeframe(option)} style={[styles.timeframe, timeframe === option ? styles.timeframeActive : null]} accessibilityRole="button"><Text style={[styles.timeframeText, timeframe === option ? styles.timeframeTextActive : null]}>{option}</Text></Pressable>)}</View>
    </View>
    <View style={[styles.chartFrame, themedScreen.chartFrame]}>
      <WebView key={`${instrument}-${retry}`} ref={webView} source={{ uri: source }} style={[styles.webview, themedScreen.webview]} originWhitelist={['*']} sharedCookiesEnabled thirdPartyCookiesEnabled cacheEnabled={false} javaScriptEnabled domStorageEnabled injectedJavaScriptBeforeContentLoaded={webViewThemeBootstrap} onLoadStart={() => { setLoading(true); webReadyRef.current = false; }} onLoadEnd={() => { setLoading(false); webReadyRef.current = true; setTimeout(() => { pushChartPreferences(); }, 0); }} onMessage={(event) => handleWebMessage(event.nativeEvent.data)} onError={() => { setLoading(false); setFailed(true); setMarketBusy(false); }} onHttpError={(event) => { if (event.nativeEvent.statusCode >= 400) { setLoading(false); setFailed(true); setMarketBusy(false); } }} />
      {loading || marketBusy ? <View pointerEvents="none" style={[styles.loading, themedScreen.loading]}><ActivityIndicator color={theme.colors.primary} /><Text style={styles.loadingText}>{loading ? 'Loading chart…' : 'Updating chart…'}</Text></View> : null}
    </View>
    <View style={[styles.toolbar, themedScreen.toolbar]}><Tool icon={SlidersHorizontal} label="Indicators" active={enabledIndicators.length > 0} onPress={() => setIndicatorsOpen(true)} /><Tool icon={Crosshair} label="Fixed 10-pip setup" onPress={() => setPositionOpen(true)} /><Tool icon={CalendarRange} label={`Visible range · ${range}`} active={false} onPress={() => setRangesOpen(true)} /><Tool icon={VariantIcon} label={`Chart type · ${activeVariant.label}`} onPress={() => setVariantsOpen(true)} /><Tool icon={RotateCcw} label="Reset chart view" onPress={() => command('reset')} /></View>
    <View style={styles.tradeAction}><Pressable onPress={() => setTradeOpen(true)} style={styles.tradeButton} accessibilityRole="button" accessibilityLabel="Create trade"><Text style={styles.tradeButtonText}>Trade</Text></Pressable></View>
    <DockFade height={96} />
    <BottomDrawer visible={pairsOpen} onClose={() => setPairsOpen(false)} eyebrow="Chart" title="Select pair">{PAIRS.map((option) => <Pressable key={option} onPress={() => selectPair(option)} style={[styles.drawerRow, instrument === option ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{pairLabel(option)}</Text>{instrument === option ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>)}</BottomDrawer>
    <BottomDrawer visible={rangesOpen} onClose={() => setRangesOpen(false)} eyebrow="Chart" title="Visible range">{RANGES.map((option) => <Pressable key={option} onPress={() => selectRange(option)} style={[styles.drawerRow, range === option ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{option}</Text>{range === option ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>)}</BottomDrawer>
    <BottomDrawer visible={variantsOpen} onClose={() => setVariantsOpen(false)} eyebrow="Chart" title="Chart type">{CHART_VARIANTS.map((option) => <Pressable key={option.value} onPress={() => selectVariant(option.value)} style={[styles.drawerRow, variant === option.value ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{option.label}</Text>{variant === option.value ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>)}</BottomDrawer>
    <BottomDrawer visible={indicatorsOpen} onClose={() => setIndicatorsOpen(false)} eyebrow="Chart" title="Indicators" scrollable>{INDICATOR_GROUPS.map((group) => <View key={group.title}><Text style={styles.drawerGroupTitle}>{group.title}</Text>{group.options.map((option) => { const on = enabledIndicators.includes(option.value); return <Pressable key={option.value} onPress={() => toggleIndicator(option.value)} style={[styles.drawerRow, on ? styles.drawerRowActive : null]}><Text style={styles.drawerPair}>{option.label}</Text>{on ? <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} /> : null}</Pressable>; })}</View>)}</BottomDrawer>
    <BottomDrawer visible={positionOpen} onClose={() => setPositionOpen(false)} eyebrow="Chart" title="Fixed 10-pip setup"><Text style={styles.drawerCopy}>Risk and reward are both fixed at 10 pips. Choose a direction to place the movable setup on the chart.</Text><View style={styles.directionRow}><Pressable onPress={() => { setPositionOpen(false); command('position', 'long'); }} style={[styles.directionButton, styles.longButton]}><Text style={styles.directionText}>Long</Text></Pressable><Pressable onPress={() => { setPositionOpen(false); command('position', 'short'); }} style={[styles.directionButton, styles.shortButton]}><Text style={styles.directionText}>Short</Text></Pressable></View></BottomDrawer>
    <NotificationDrawer visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    <TradeDrawer
      visible={tradeOpen}
      onClose={() => setTradeOpen(false)}
      instrument={instrument}
      bid={chartState?.bid ?? null}
      ask={chartState?.ask ?? null}
      onCreated={() => command('refresh')}
    />
  </View>;
}

function Tool({ icon: Icon, label, active = false, onPress }: { icon: LucideIcon; label: string; active?: boolean; onPress: () => void }) {
  const color = active ? theme.colors.primary : theme.colors.textSecondary;
  return (
    <Pressable onPress={onPress} style={[styles.tool, active ? styles.toolActive : null]} accessibilityRole="button" accessibilityLabel={label}>
      <Icon size={22} strokeWidth={1.85} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 }, header: { paddingHorizontal: 16, paddingBottom: 10, gap: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.cardBorder }, headerRow: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, pairButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5 }, pair: { fontSize: 15, fontFamily: theme.fonts.sansBold, color: theme.colors.textPrimary }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 }, analyze: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: theme.colors.primary }, bell: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: theme.colors.surfaceRaised },
  quoteRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }, quote: { fontSize: 22, fontFamily: theme.fonts.monoBold, color: theme.colors.textPrimary, letterSpacing: -0.5 }, change: { fontSize: 11, fontFamily: theme.fonts.monoMedium }, up: { color: theme.colors.primary }, down: { color: theme.colors.danger }, session: { marginLeft: 'auto', fontSize: 10, fontFamily: theme.fonts.sansSemiBold, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.colors.textMuted }, timeframes: { minHeight: 39, flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: theme.colors.surfaceRaised }, timeframe: { flex: 1, minHeight: 33, alignItems: 'center', justifyContent: 'center', borderRadius: 7 }, timeframeActive: { backgroundColor: theme.colors.primarySoft }, timeframeText: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textSecondary }, timeframeTextActive: { color: theme.colors.primary },
  chartFrame: { flex: 1, minHeight: 180 }, webview: { flex: 1 }, loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 9 }, loadingText: { fontSize: 13, fontFamily: theme.fonts.sansMedium, color: theme.colors.textSecondary }, toolbar: { zIndex: 6, minHeight: 52, flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 8, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.cardBorder }, tool: { flex: 1, minWidth: 0, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 11 }, toolActive: { backgroundColor: theme.colors.primarySoft }, tradeAction: { zIndex: 6, marginBottom: 94, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, backgroundColor: 'transparent' }, tradeButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.colors.primary }, tradeButtonText: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' },
  drawerRow: { minHeight: 49, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border, borderRadius: 10 }, drawerRowActive: { backgroundColor: theme.colors.primaryMuted }, drawerPair: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, drawerGroupTitle: { marginTop: 8, marginBottom: 4, paddingHorizontal: 12, fontSize: 11, fontFamily: theme.fonts.sansSemiBold, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.colors.textMuted }, drawerCopy: { marginHorizontal: 12, marginBottom: 14, fontSize: 13, lineHeight: 19, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, directionRow: { flexDirection: 'row', gap: 10, marginHorizontal: 12, paddingBottom: 8 }, directionButton: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }, longButton: { backgroundColor: theme.colors.primary }, shortButton: { backgroundColor: theme.colors.danger }, directionText: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' }, errorState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }, errorTitle: { fontSize: 19, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, errorCopy: { marginTop: 7, textAlign: 'center', fontSize: 13, lineHeight: 19, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, retry: { marginTop: 20, minHeight: 44, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.colors.primary }, retryText: { fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' },
});
