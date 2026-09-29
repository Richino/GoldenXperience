import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Crosshair } from 'lucide-react-native';

import { Text } from '@/components/ui/AppText';
import { BottomDrawer } from '@/components/ui/BottomDrawer';
import { theme, type ThemeColors } from '@/constants/theme';
import { apiGet, apiPost, apiPut } from '@/lib/api/client';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';

type AutomationMode = 'alert' | 'auto';
type WatchState = 'NO_PLAN' | 'WAITING' | 'AT_LEVEL' | 'CONFIRMED' | 'INVALIDATED';
type AutomateSignal = {
  id: string;
  confirmation: 'REJECTION' | 'SWEEP';
  direction: 'long' | 'short';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  status: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
};
type AutomateSnapshot = {
  automation: { enabled: boolean; mode: AutomationMode; lastCheckedAt: string | null };
  watch: { state: WatchState; direction: 'long' | 'short' | null; level: number | null; zoneFar: number | null; counterTrend: boolean; rewardRisk: number | null; reason: string } | null;
  signals: AutomateSignal[];
};

const STATE_LABEL: Record<WatchState, string> = {
  NO_PLAN: 'No plan',
  WAITING: 'Waiting for the level',
  AT_LEVEL: 'At the level · waiting for confirmation',
  CONFIRMED: 'Confirmed',
  INVALIDATED: 'Level broken',
};

function price(value: number | null, instrument: string) {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(instrument.includes('JPY') ? 3 : 5);
}
function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Header button + drawer for the server-side pullback confirmation watch (same API as the web chart). */
export function AutomateButton({ instrument, onPlaced }: { instrument: string; onPlaced?: () => void }) {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<AutomateSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setSnapshot(await apiGet<AutomateSnapshot>(`/api/automate?instrument=${instrument}`)); } catch { /* next poll retries */ }
  }, [instrument]);

  useEffect(() => {
    setSnapshot(null);
    void refresh();
    const timer = setInterval(() => void refresh(), open ? 15_000 : 60_000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const save = async (enabled: boolean, mode: AutomationMode) => {
    setBusy(true); setError(null);
    try { setSnapshot(await apiPut<AutomateSnapshot>('/api/automate', { instrument, enabled, mode })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const act = async (signal: AutomateSignal, action: 'accept' | 'reject') => {
    setBusy(true); setError(null);
    try {
      await apiPost(`/api/automate/signals/${signal.id}/${action}`);
      if (action === 'accept') onPlaced?.();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not act on the signal.'); }
    finally { setBusy(false); void refresh(); }
  };

  const enabled = snapshot?.automation.enabled ?? false;
  const mode = snapshot?.automation.mode ?? 'alert';
  const watch = snapshot?.watch ?? null;
  const alert = snapshot?.signals.find((signal) => signal.status === 'ALERTED' && Date.parse(signal.expiresAt) > Date.now()) ?? null;
  const history = (snapshot?.signals ?? []).filter((signal) => signal.id !== alert?.id).slice(0, 4);

  return <>
    <Pressable onPress={() => setOpen(true)} style={[styles.button, enabled ? styles.buttonOn : null]} accessibilityRole="button" accessibilityLabel={alert ? 'Automate: signal waiting' : enabled ? 'Automate is on' : 'Automate'}>
      <Crosshair size={18} strokeWidth={2} color={enabled ? colors.primary : colors.textSecondary} />
      {alert ? <View style={styles.dot} /> : null}
    </Pressable>
    <BottomDrawer visible={open} onClose={() => setOpen(false)} eyebrow={`Automate · ${instrument.replace('_', '/')} · M15`} title={enabled ? 'Watching this pair' : 'Automate is off'} scrollable>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.strong}>Watch pullback confirmation</Text>
          <Text style={styles.muted}>Rejection or liquidity sweep at the level, every completed M15 candle, also while the app is closed.</Text>
        </View>
        <Switch value={enabled} disabled={busy || !snapshot} onValueChange={(value) => void save(value, mode)} trackColor={{ true: colors.primary, false: colors.border }} />
      </View>
      <View style={styles.modes}>
        {(['alert', 'auto'] as const).map((value) => (
          <Pressable key={value} disabled={busy || !snapshot} onPress={() => void save(enabled, value)} style={[styles.mode, mode === value ? styles.modeActive : null]} accessibilityRole="radio" accessibilityState={{ checked: mode === value }}>
            <Text style={styles.strong}>{value === 'alert' ? 'Alert me' : 'Place it'}</Text>
            <Text style={styles.muted}>{value === 'alert' ? 'Notify, I accept or reject' : 'Send the practice order'}</Text>
          </Pressable>
        ))}
      </View>
      {alert ? (
        <View style={styles.alert}>
          <Text style={styles.alertEyebrow}>{alert.confirmation === 'SWEEP' ? 'Sweep' : 'Rejection'} confirmed · expires {clock(alert.expiresAt)}</Text>
          <Text style={[styles.alertSide, { color: alert.direction === 'long' ? colors.primary : colors.danger }]}>{alert.direction === 'long' ? 'LONG' : 'SHORT'} at market</Text>
          <Text style={styles.mono}>Entry ≈ {price(alert.entryPrice, instrument)} · Stop {price(alert.stopPrice, instrument)} · Target {price(alert.targetPrice, instrument)}</Text>
          <Text style={styles.muted}>{alert.reason} Entry is re-priced at the live quote when you accept.</Text>
          <View style={styles.actions}>
            <Pressable disabled={busy} onPress={() => void act(alert, 'reject')} style={[styles.action, styles.reject]}><Text style={styles.actionText}>Reject</Text></Pressable>
            <Pressable disabled={busy} onPress={() => void act(alert, 'accept')} style={styles.action}><Text style={styles.actionText}>Accept</Text></Pressable>
          </View>
        </View>
      ) : null}
      <View style={styles.card}>
        <Text style={styles.label}>Now</Text>
        {watch ? <>
          <Text style={styles.strong}>{STATE_LABEL[watch.state]}</Text>
          {watch.direction && watch.level !== null ? <Text style={styles.body}>{watch.direction === 'long' ? 'Long at support' : 'Short at resistance'} {price(watch.level, instrument)} · zone to {price(watch.zoneFar, instrument)} · {watch.rewardRisk}:1{watch.counterTrend ? ' · against 1H/4H' : ''}</Text> : null}
          <Text style={styles.muted}>{watch.reason}</Text>
          {snapshot?.automation.lastCheckedAt ? <Text style={styles.muted}>Checked {clock(snapshot.automation.lastCheckedAt)}</Text> : null}
        </> : <Text style={styles.muted}>{enabled ? 'First check runs within a minute.' : 'Turn it on to start watching.'}</Text>}
      </View>
      {history.map((signal) => (
        <View key={signal.id} style={styles.history}>
          <Text style={styles.strong}>{clock(signal.createdAt)} · {signal.direction === 'long' ? 'Long' : 'Short'} {signal.confirmation.toLowerCase()} · {signal.status.toLowerCase()}</Text>
          <Text style={styles.muted}>{signal.reason}</Text>
        </View>
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.footnote}>Not backtested. Skips when the spread is over 10% of the stop or high-impact news is within 30 min. Auto orders are practice-account only and never replace a trade you already have on this pair.</Text>
    </BottomDrawer>
  </>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  button: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: colors.surfaceRaised },
  buttonOn: { backgroundColor: colors.primarySoft },
  dot: { position: 'absolute', top: 4, right: 4, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.warning, borderWidth: 2, borderColor: colors.surface },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 4, padding: 12, borderRadius: 14, backgroundColor: colors.surfaceRaised },
  rowText: { flex: 1, gap: 2 },
  modes: { flexDirection: 'row', gap: 10, marginTop: 10, marginHorizontal: 4 },
  mode: { flex: 1, padding: 12, gap: 2, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  modeActive: { borderWidth: 1.5, borderColor: colors.primary, backgroundColor: colors.primarySoft },
  alert: { marginTop: 14, marginHorizontal: 4, padding: 14, gap: 4, borderRadius: 16, borderWidth: 1, borderColor: colors.primary },
  alertEyebrow: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, textTransform: 'uppercase', letterSpacing: 0.6, color: colors.primary },
  alertSide: { fontSize: 20, fontFamily: theme.fonts.sansBold },
  mono: { fontSize: 13, fontFamily: theme.fonts.monoBold, color: colors.textPrimary },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  action: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: colors.primary },
  reject: { backgroundColor: colors.danger },
  actionText: { fontSize: 15, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' },
  card: { marginTop: 14, marginHorizontal: 4, padding: 14, gap: 3, borderRadius: 16, backgroundColor: colors.surfaceRaised },
  label: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold, textTransform: 'uppercase', letterSpacing: 0.7, color: colors.textMuted },
  strong: { fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: colors.textPrimary },
  body: { fontSize: 13, fontFamily: theme.fonts.sans, color: colors.textSecondary },
  muted: { fontSize: 12, lineHeight: 17, fontFamily: theme.fonts.sans, color: colors.textMuted },
  history: { marginTop: 8, marginHorizontal: 4, padding: 12, gap: 2, borderRadius: 12, backgroundColor: colors.surfaceRaised },
  error: { marginTop: 10, marginHorizontal: 4, fontSize: 13, fontFamily: theme.fonts.sansMedium, color: colors.danger },
  footnote: { marginTop: 14, marginHorizontal: 4, marginBottom: 8, fontSize: 11, lineHeight: 15, fontFamily: theme.fonts.sans, color: colors.textMuted },
});
