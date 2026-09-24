import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HomeCard } from '@/components/home/HomeCard';
import { Text } from '@/components/ui/AppText';
import { BottomDrawer } from '@/components/ui/BottomDrawer';
import { DockFade } from '@/components/ui/DockFade';
import { theme } from '@/constants/theme';
import { useAuth } from '@/lib/auth/AuthContext';
import { apiGet, apiPatch } from '@/lib/api/client';
import { notificationSounds, usePreferences, type NotificationSound, type TextSize, type ThemeMode } from '@/lib/preferences/PreferencesContext';
import type { PaperRiskConfiguration, PaperRiskPolicy } from '@/types/api';

const POSITION_OPTIONS = [null, ...Array.from({ length: 10 }, (_, i) => i + 1)];

function formFrom(policy: PaperRiskPolicy) {
  const value = policy.pending ?? policy.active;
  return { risk: String(value.riskPercent), positions: value.maxSimultaneousPositions, exposure: value.maxTotalNominalRiskPercent === null ? '' : String(value.maxTotalNominalRiskPercent), paused: policy.collectionPaused };
}

function parseRisk(risk: string, positions: number | null, exposure: string): PaperRiskConfiguration | null {
  const riskPercent = Number(risk);
  const maxTotalNominalRiskPercent = exposure.trim() ? Number(exposure) : null;
  if (!Number.isFinite(riskPercent) || riskPercent < 0.1 || riskPercent > 5) return null;
  if (maxTotalNominalRiskPercent !== null && (!Number.isFinite(maxTotalNominalRiskPercent) || maxTotalNominalRiskPercent < riskPercent || maxTotalNominalRiskPercent > 50)) return null;
  return { riskPercent, maxSimultaneousPositions: positions, maxTotalNominalRiskPercent };
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const { themeMode, textSize, notificationSound, setThemeMode, setTextSize, setNotificationSound } = usePreferences();
  const [picker, setPicker] = useState<'theme' | 'text' | 'sound' | null>(null);
  const [policy, setPolicy] = useState<PaperRiskPolicy | null>(null);
  const [risk, setRisk] = useState('');
  const [positions, setPositions] = useState<number | null>(null);
  const [exposure, setExposure] = useState('');
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipNextSave = useRef(true);

  const load = useCallback(async () => {
    try {
      const payload = await apiGet<{ policy: PaperRiskPolicy }>('/api/paper-risk');
      const form = formFrom(payload.policy);
      skipNextSave.current = true;
      setPolicy(payload.policy); setRisk(form.risk); setPositions(form.positions); setExposure(form.exposure); setPaused(form.paused); setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Risk settings are temporarily unavailable.');
    } finally { setLoading(false); setHydrated(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!hydrated) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    const next = parseRisk(risk, positions, exposure);
    if (!next) return;
    const timer = setTimeout(() => {
      void (async () => {
        setSaving(true);
        try {
          const payload = await apiPatch<{ policy: PaperRiskPolicy }>('/api/paper-risk/settings', {
            configuration: next,
            collectionPaused: paused,
          });
          setPolicy(payload.policy);
          setError(null);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Risk settings could not be saved.');
        } finally {
          setSaving(false);
        }
      })();
    }, 450);
    return () => clearTimeout(timer);
  }, [hydrated, risk, positions, exposure, paused]);
  function confirmSignOut() {
    Alert.alert('Sign out?', 'You will need to sign in again to access your workspace.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => void signOut() }]);
  }
  function selectSound(sound: NotificationSound) {
    setNotificationSound(sound);
  }
  function changeTheme(value: ThemeMode) {
    if (value === themeMode) { setPicker(null); return; }
    setThemeMode(value);
    setPicker(null);
  }

  return <View style={styles.root}><ScrollView contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top + 10, 28), paddingBottom: 118 + Math.max(insets.bottom, 8) }]} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl tintColor={theme.colors.primary} refreshing={loading} onRefresh={() => void load()} />}>
    <View><Text style={styles.title}>Settings</Text><Text style={styles.subtitle}>Appearance, alerts, and account</Text></View>
    <HomeCard style={styles.card}><Text style={styles.section}>Appearance</Text><Row label="Theme" value={themeMode === 'light' ? 'Light' : 'Dark'} onPress={() => setPicker('theme')} /><Row label="Text size" value={textSize === 'small' ? 'Small' : textSize === 'large' ? 'Large' : 'Standard'} onPress={() => setPicker('text')} last /></HomeCard>
    <HomeCard style={styles.card}><Text style={styles.section}>Notifications</Text><Row label="Notification sound" value={notificationSounds.find((sound) => sound.value === notificationSound)?.label ?? 'Soft Whistle'} onPress={() => setPicker('sound')} last /></HomeCard>
    <HomeCard style={styles.card} accessibilityLabel="Paper trading risk settings"><View style={styles.sectionHead}><View><Text style={styles.section}>Paper trading</Text><Text style={styles.helper}>Practice-entry risk limits</Text></View><Text style={[styles.status, paused ? styles.paused : styles.active]}>{paused ? 'Paused' : 'Accepting'}</Text></View>
      {loading && !policy ? <ActivityIndicator style={styles.loader} color={theme.colors.primary} /> : <>
        <Text style={styles.field}>Risk per trade</Text><Field value={risk} onChangeText={setRisk} label="Risk per trade percent" placeholder="0.1–5" />
        <Text style={styles.field}>Max open positions</Text><View style={styles.grid}>{POSITION_OPTIONS.map((option) => <Pressable key={option ?? 'all'} onPress={() => setPositions(option)} style={[styles.choice, positions === option ? styles.choiceOn : null]} accessibilityRole="button" accessibilityState={{ selected: positions === option }}><Text style={[styles.choiceText, positions === option ? styles.choiceTextOn : null]}>{option ?? '∞'}</Text></Pressable>)}</View>
        <Text style={styles.field}>Max exposure <Text style={styles.optional}>Optional</Text></Text><Field value={exposure} onChangeText={setExposure} label="Maximum exposure percent" placeholder="Unlimited" />
        <View style={styles.switchRow}><View style={styles.switchCopy}><Text style={styles.switchTitle}>Allow new entries</Text></View><Switch value={!paused} onValueChange={(value) => setPaused(!value)} trackColor={{ false: theme.colors.surfaceRaised, true: theme.colors.primarySoft }} thumbColor={!paused ? theme.colors.primary : theme.colors.textSecondary} /></View>
        {error ? <Text style={styles.error}>{error}</Text> : null}{saving && !error ? <Text style={styles.helper}>Saving…</Text> : null}
      </>}
    </HomeCard>
    <HomeCard style={styles.card}><Text style={styles.section}>Account</Text><Row label="Signed in as" value={user?.email ?? '—'} /><Pressable onPress={confirmSignOut} style={styles.signOut} accessibilityRole="button"><SymbolView name={{ ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' }} size={16} tintColor={theme.colors.danger} /><Text style={styles.signOutText}>Sign out</Text></Pressable></HomeCard>
  </ScrollView><DockFade height={96} /><PreferencePicker visible={picker === 'theme'} title="Theme" options={[{ value: 'dark', label: 'Dark', detail: 'GX dark appearance' }, { value: 'light', label: 'Light', detail: 'Bright GX appearance' }]} selected={themeMode} onSelect={(value) => { changeTheme(value as ThemeMode); }} onClose={() => setPicker(null)} /><PreferencePicker visible={picker === 'text'} title="Text size" options={[{ value: 'small', label: 'Small', detail: 'More information on screen' }, { value: 'standard', label: 'Standard', detail: 'Recommended' }, { value: 'large', label: 'Large', detail: 'Easier to read' }]} selected={textSize} onSelect={(value) => { setTextSize(value as TextSize); setPicker(null); }} onClose={() => setPicker(null)} /><PreferencePicker visible={picker === 'sound'} title="Notification sound" options={notificationSounds.map((sound) => ({ ...sound, detail: 'Saved for alert playback' }))} selected={notificationSound} onSelect={(value) => { selectSound(value as NotificationSound); setPicker(null); }} onClose={() => setPicker(null)} /></View>;
}

function Field({ value, onChangeText, label, placeholder }: { value: string; onChangeText: (value: string) => void; label: string; placeholder: string }) {
  return <View style={styles.fieldWrap}><TextInput value={value} onChangeText={onChangeText} keyboardType="decimal-pad" placeholder={placeholder} placeholderTextColor={theme.colors.textMuted} style={styles.input} accessibilityLabel={label} /><Text style={styles.suffix}>%</Text></View>;
}
function Row({ label, value, last = false, onPress }: { label: string; value: string; last?: boolean; onPress?: () => void }) { return <Pressable disabled={!onPress} onPress={onPress} style={[styles.row, last ? styles.last : null]} accessibilityRole={onPress ? 'button' : undefined}><Text style={styles.rowLabel}>{label}</Text><View style={styles.rowEnd}><Text style={styles.rowValue}>{value}</Text>{onPress ? <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={14} tintColor={theme.colors.textMuted} /> : null}</View></Pressable>; }

function PreferencePicker({ visible, title, options, selected, onSelect, onClose }: { visible: boolean; title: string; options: Array<{ value: string; label: string; detail: string }>; selected: string; onSelect: (value: string) => void; onClose: () => void }) {
  return (
    <BottomDrawer visible={visible} onClose={onClose} eyebrow="Settings" title={title} scrollable>
      {options.map((option, index) => (
        <Pressable
          key={option.value}
          onPress={() => onSelect(option.value)}
          style={[
            styles.drawerRow,
            selected === option.value ? styles.drawerRowActive : null,
            index === options.length - 1 ? styles.drawerRowLast : null,
          ]}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === option.value }}
        >
          <View style={styles.drawerCopy}>
            <Text style={styles.drawerLabel}>{option.label}</Text>
            <Text style={styles.drawerDetail}>{option.detail}</Text>
          </View>
          {selected === option.value ? (
            <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={18} tintColor={theme.colors.primary} />
          ) : null}
        </Pressable>
      ))}
    </BottomDrawer>
  );
}

const styles = StyleSheet.create({
  topControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, iconButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }, referenceCard: { paddingTop: 27, paddingBottom: 27 }, referenceHeading: { fontSize: 16, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, segmentRow: { minHeight: 80, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, segmentLabel: { fontSize: 16, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, segment: { width: 178 }, segmentTrack: { flexDirection: 'row', padding: 4, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceInset }, segmentItem: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 13 }, segmentItemOn: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised }, segmentText: { fontSize: 15, fontFamily: theme.fonts.sansMedium, color: theme.colors.textSecondary }, segmentTextOn: { color: theme.colors.textPrimary }, controlLabel: { marginTop: 26, fontSize: 16, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, soundSelect: { marginTop: 14, minHeight: 60, paddingHorizontal: 16, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, soundSelectText: { fontSize: 16, fontFamily: theme.fonts.sans, color: theme.colors.textPrimary }, preview: { marginTop: 16, minHeight: 60, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' }, previewText: { fontSize: 16, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, volumeRow: { marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }, volumeTrack: { flex: 1, height: 10, borderRadius: 5, backgroundColor: theme.colors.surfaceRaised }, volumeFill: { width: '50%', height: '100%', borderRadius: 5, backgroundColor: theme.colors.primary }, volumeKnob: { position: 'absolute', left: '50%', top: -6, width: 22, height: 22, marginLeft: -11, borderRadius: 11, backgroundColor: theme.colors.textPrimary }, volumeLabel: { width: 50, textAlign: 'right', fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary }, noticeRow: { minHeight: 70, marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, noticeLast: { marginTop: 4 }, noticeTitle: { fontSize: 16, fontFamily: theme.fonts.sansMedium, color: theme.colors.textPrimary }, noticeDetail: { marginTop: 3, fontSize: 13, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, outlineButton: { minHeight: 58, minWidth: 76, paddingHorizontal: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' }, outlineText: { fontSize: 16, fontFamily: theme.fonts.sansMedium, color: theme.colors.textPrimary },
  root: { flex: 1, backgroundColor: theme.colors.background }, content: { paddingHorizontal: 16, gap: 14 }, title: { fontSize: 28, fontFamily: theme.fonts.sansBold, color: theme.colors.textPrimary, letterSpacing: -0.7 }, subtitle: { marginTop: 3, fontSize: 13, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, card: { paddingVertical: 18 }, section: { fontSize: 10, fontFamily: theme.fonts.sansMedium, letterSpacing: 1.4, color: theme.colors.textMuted, textTransform: 'uppercase' }, row: { minHeight: 52, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border }, last: { borderBottomWidth: 0, paddingBottom: 0 }, rowLabel: { flex: 1, fontSize: 14, fontFamily: theme.fonts.sansMedium, color: theme.colors.textPrimary }, rowEnd: { maxWidth: '58%', flexDirection: 'row', alignItems: 'center', gap: 5 }, rowValue: { flexShrink: 1, fontSize: 12, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary, textAlign: 'right' }, sectionHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }, helper: { marginTop: 4, fontSize: 11.5, lineHeight: 16, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary }, status: { fontSize: 11, fontFamily: theme.fonts.sansSemiBold }, active: { color: theme.colors.primary }, paused: { color: theme.colors.danger }, loader: { marginVertical: 36 }, field: { marginTop: 18, marginBottom: 7, fontSize: 11, fontFamily: theme.fonts.sansMedium, color: theme.colors.textSecondary }, optional: { color: theme.colors.textMuted }, fieldWrap: { height: 46, flexDirection: 'row', alignItems: 'center', borderRadius: 12, backgroundColor: theme.colors.surfaceInset, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border, paddingHorizontal: 13 }, input: { flex: 1, height: '100%', fontSize: 15, fontFamily: theme.fonts.monoMedium, color: theme.colors.textPrimary }, suffix: { fontSize: 13, fontFamily: theme.fonts.sansMedium, color: theme.colors.textMuted }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, choice: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceInset, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border }, choiceOn: { backgroundColor: theme.colors.primarySoft, borderColor: 'rgba(0, 229, 155, 0.42)' }, choiceText: { fontSize: 13, fontFamily: theme.fonts.monoMedium, color: theme.colors.textSecondary }, choiceTextOn: { color: theme.colors.primary }, switchRow: { marginTop: 20, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border, flexDirection: 'row', alignItems: 'center', gap: 14 }, switchCopy: { flex: 1 }, switchTitle: { fontSize: 14, fontFamily: theme.fonts.sansMedium, color: theme.colors.textPrimary },   error: { marginTop: 12, fontSize: 12, fontFamily: theme.fonts.sansMedium, color: theme.colors.danger }, signOut: { marginTop: 14, minHeight: 44, borderRadius: 12, backgroundColor: theme.colors.dangerSoft, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, signOutText: { fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.danger },
  drawerRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border, borderRadius: 10 },
  drawerRowActive: { backgroundColor: theme.colors.primaryMuted },
  drawerRowLast: { borderBottomWidth: 0 },
  drawerCopy: { flex: 1, minWidth: 0, paddingRight: 10 },
  drawerLabel: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary },
  drawerDetail: { marginTop: 2, fontSize: 11.5, lineHeight: 16, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary },
});
