import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/AppText';
import { BottomDrawer } from '@/components/ui/BottomDrawer';
import { theme } from '@/constants/theme';
import { apiGet, apiPost } from '@/lib/api/client';
import { formatPrice, pairLabel } from '@/lib/format';
import type { JournalTrade } from '@/types/api';

function pipSize(instrument: string) {
  return instrument.includes('JPY') ? 0.01 : 0.0001;
}

function inferOrderType(direction: 'long' | 'short', entry: number, reference: number | null) {
  if (reference === null || !Number.isFinite(entry)) return null;
  if (direction === 'long') return entry >= reference ? 'Buy stop' : 'Buy limit';
  return entry <= reference ? 'Sell stop' : 'Sell limit';
}

export function TradeDrawer({
  visible,
  onClose,
  instrument,
  bid,
  ask,
  draft,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  instrument: string;
  bid: number | null;
  ask: number | null;
  draft?: { direction: 'long' | 'short'; entry: number; stop: number; target: number } | null;
  onCreated?: () => void;
}) {
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [orderReferencePrice, setOrderReferencePrice] = useState<number | null>(null);
  const [entryPrice, setEntryPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [checkingBlock, setCheckingBlock] = useState(false);
  const bidRef = useRef(bid);
  const askRef = useRef(ask);
  bidRef.current = bid;
  askRef.current = ask;

  const current = direction === 'long' ? ask : bid;
  const parsedEntry = entryPrice.trim() === '' ? Number.NaN : Number(entryPrice);
  const parsedStop = stopPrice.trim() === '' ? null : Number(stopPrice);
  const parsedTarget = targetPrice.trim() === '' ? null : Number(targetPrice);
  const distancePips = current !== null && Number.isFinite(parsedEntry)
    ? Math.abs(parsedEntry - current) / pipSize(instrument)
    : null;
  const inferredOrder = inferOrderType(direction, parsedEntry, orderReferencePrice);
  const spreadPips = bid !== null && ask !== null ? Math.max(0, (ask - bid) / pipSize(instrument)) : null;

  const resetForm = useCallback(() => {
    const initialDirection: 'long' | 'short' = draft?.direction ?? 'long';
    setDirection(initialDirection);
    const reference = initialDirection === 'long' ? askRef.current : bidRef.current;
    setOrderReferencePrice(reference);
    setEntryPrice(draft ? formatPrice(draft.entry, instrument) : reference !== null ? formatPrice(reference, instrument) : '');
    setStopPrice(draft ? formatPrice(draft.stop, instrument) : '');
    setTargetPrice(draft ? formatPrice(draft.target, instrument) : '');
    setError(null);
  }, [draft, instrument]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    resetForm();
    setCheckingBlock(true);
    void (async () => {
      try {
        const payload = await apiGet<{ trades: JournalTrade[] }>('/api/journal/trades?limit=40&filter=open');
        if (cancelled) return;
        const hasOpen = (payload.trades ?? []).some(
          (trade) => trade.status === 'open' && trade.instrument?.toUpperCase() === instrument.toUpperCase(),
        );
        setBlocked(hasOpen);
      } catch {
        if (cancelled) return;
        setBlocked(false);
      } finally {
        if (!cancelled) setCheckingBlock(false);
      }
    })();
    return () => { cancelled = true; };
  }, [instrument, resetForm, visible]);

  const creationBlocked = blocked;

  async function save() {
    setError(null);
    if (creationBlocked) {
      setError('This pair already has an active position. Close it before creating another entry.');
      return;
    }
    if (current === null) {
      setError('Wait for a fresh executable market quote.');
      return;
    }
    if (!Number.isFinite(parsedEntry) || parsedEntry <= 0) {
      setError('Enter a valid entry price.');
      return;
    }
    if (stopPrice.trim() && (!Number.isFinite(parsedStop) || (parsedStop ?? 0) <= 0)) {
      setError('Enter a valid stop price.');
      return;
    }
    if (targetPrice.trim() && (!Number.isFinite(parsedTarget) || (parsedTarget ?? 0) <= 0)) {
      setError('Enter a valid target price.');
      return;
    }
    if (Boolean(stopPrice.trim()) !== Boolean(targetPrice.trim())) {
      setError('Enter both a stop and a target, or leave both blank.');
      return;
    }
    if (parsedStop !== null && parsedTarget !== null && Number.isFinite(parsedStop) && Number.isFinite(parsedTarget)) {
      const okSide = direction === 'long'
        ? parsedStop < parsedEntry && parsedTarget > parsedEntry
        : parsedStop > parsedEntry && parsedTarget < parsedEntry;
      if (!okSide) {
        setError(direction === 'long'
          ? 'For a long: stop must be below entry, target above it.'
          : 'For a short: stop must be above entry, target below it.');
        return;
      }
    }

    setSaving(true);
    try {
      await apiPost('/api/pending-entries', {
        instrument,
        direction,
        entryPrice: parsedEntry,
        stopPrice: parsedStop,
        targetPrice: parsedTarget,
        expiresAt: null,
        activateAt: null,
        invalidationPrice: null,
        orderReferencePrice,
      });
      onCreated?.();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the pending entry.');
    } finally {
      setSaving(false);
    }
  }

  const submitDisabled = saving || creationBlocked || checkingBlock || !Number.isFinite(parsedEntry) || parsedEntry <= 0;

  const summary = useMemo(() => (
    <View style={styles.summary}>
      <Text style={styles.summaryTitle}>{direction.toUpperCase()} {pairLabel(instrument)}</Text>
      <Text style={styles.summaryLine}>Order: {inferredOrder ?? '—'}</Text>
      <Text style={styles.summaryLine}>Entry: {Number.isFinite(parsedEntry) ? formatPrice(parsedEntry, instrument) : '—'}</Text>
      <Text style={styles.summaryLine}>Current: {current !== null ? formatPrice(current, instrument) : '—'}</Text>
      <Text style={styles.summaryLine}>Distance: {distancePips === null ? '—' : `${distancePips.toFixed(1)} pips`}</Text>
      <Text style={styles.summaryLine}>Spread: {spreadPips === null ? '—' : `${spreadPips.toFixed(1)} pips`}</Text>
    </View>
  ), [current, direction, distancePips, inferredOrder, instrument, parsedEntry, spreadPips]);

  return (
    <BottomDrawer visible={visible} onClose={onClose} eyebrow="Trade" title={pairLabel(instrument)} scrollable>
      {creationBlocked ? (
        <Text style={styles.blocked}>
          This pair already has an active position. Close it before creating another entry.
        </Text>
      ) : null}
      <View style={styles.directionRow}>
        {(['long', 'short'] as const).map((option) => (
          <Pressable
            key={option}
            onPress={() => {
              setDirection(option);
              const ref = option === 'long' ? ask : bid;
              setOrderReferencePrice(ref);
              if (entryPrice.trim() === '' && ref !== null) setEntryPrice(formatPrice(ref, instrument));
            }}
            style={[styles.directionButton, option === 'long' ? styles.long : styles.short, direction === option ? styles.directionActive : null]}
          >
            <Text style={styles.directionText}>{option.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>
      <Field label="Entry price" hint={current !== null ? `Current ${formatPrice(current, instrument)}${distancePips !== null ? ` · ${distancePips.toFixed(1)} pips away` : ''}` : 'Waiting for quote…'}>
        <TextInput
          value={entryPrice}
          onChangeText={(value) => {
            if (entryPrice.trim() === '') setOrderReferencePrice(current);
            setEntryPrice(value);
          }}
          keyboardType="decimal-pad"
          placeholder={current !== null ? formatPrice(current, instrument) : '0.00000'}
          placeholderTextColor={theme.colors.textMuted}
          style={styles.input}
          accessibilityLabel="Entry price"
        />
      </Field>
      <View style={styles.levelRow}>
        <Field label="Stop loss" compact>
          <TextInput value={stopPrice} onChangeText={setStopPrice} keyboardType="decimal-pad" placeholder="Optional" placeholderTextColor={theme.colors.textMuted} style={styles.input} accessibilityLabel="Stop loss" />
        </Field>
        <Field label="Take profit" compact>
          <TextInput value={targetPrice} onChangeText={setTargetPrice} keyboardType="decimal-pad" placeholder="Optional" placeholderTextColor={theme.colors.textMuted} style={styles.input} accessibilityLabel="Take profit" />
        </Field>
      </View>
      {summary}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <Pressable
        onPress={() => void save()}
        disabled={submitDisabled}
        style={[styles.submit, submitDisabled ? styles.submitDisabled : null]}
        accessibilityRole="button"
        accessibilityLabel="Create pending entry"
      >
        <Text style={styles.submitText}>{saving ? 'Saving…' : checkingBlock ? 'Checking open positions…' : 'Create entry'}</Text>
      </Pressable>
    </BottomDrawer>
  );
}

function Field({
  label,
  hint,
  compact = false,
  children,
}: {
  label: string;
  hint?: string;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.field, compact ? styles.fieldCompact : null]}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  blocked: { marginHorizontal: 4, marginBottom: 12, fontSize: 13, lineHeight: 19, fontFamily: theme.fonts.sansMedium, color: theme.colors.danger },
  directionRow: { flexDirection: 'row', gap: 10, marginBottom: 14, paddingHorizontal: 4 },
  directionButton: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, opacity: 0.45 },
  directionActive: { opacity: 1 },
  long: { backgroundColor: theme.colors.primary },
  short: { backgroundColor: theme.colors.danger },
  directionText: { fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' },
  field: { marginBottom: 14, paddingHorizontal: 4 },
  fieldCompact: { flex: 1, marginBottom: 0 },
  label: { marginBottom: 6, fontSize: 12, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textSecondary },
  hint: { marginTop: 6, fontSize: 11, fontFamily: theme.fonts.sans, color: theme.colors.textMuted },
  input: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceRaised,
    fontSize: 15,
    fontFamily: theme.fonts.monoMedium,
    color: theme.colors.textPrimary,
  },
  levelRow: { flexDirection: 'row', gap: 10, marginBottom: 14, paddingHorizontal: 4 },
  summary: { marginTop: 4, marginBottom: 12, marginHorizontal: 4, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceRaised, gap: 4 },
  summaryTitle: { fontSize: 13, fontFamily: theme.fonts.sansSemiBold, color: theme.colors.textPrimary },
  summaryLine: { fontSize: 12, fontFamily: theme.fonts.sans, color: theme.colors.textSecondary },
  error: { marginHorizontal: 4, marginBottom: 10, fontSize: 13, lineHeight: 18, fontFamily: theme.fonts.sansMedium, color: theme.colors.danger },
  submit: { marginHorizontal: 4, marginTop: 4, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.colors.primary },
  submitDisabled: { opacity: 0.45 },
  submitText: { fontSize: 14, fontFamily: theme.fonts.sansSemiBold, color: '#ffffff' },
});
