import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { apiGet } from '@/lib/api/client';
import { currentTradingDayKey } from '@/lib/time';
import type { AccountBalanceHistoryPoint, AccountSummary, CalendarSnapshot, JournalTrade, OpenPosition, PendingEntry } from '@/types/api';

export type HomeData = {
  account: AccountSummary | null;
  accountHistory: AccountBalanceHistoryPoint[];
  openPositions: OpenPosition[];
  journalTrades: JournalTrade[];
  pendingEntries: PendingEntry[];
  calendar: CalendarSnapshot | null;
  calendarLoading: boolean;
  loading: boolean;
  error: string | null;
  todayKey: string;
  refresh: () => Promise<void>;
};

export function useHomeData(): HomeData {
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountHistory, setAccountHistory] = useState<AccountBalanceHistoryPoint[]>([]);
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([]);
  const [journalTrades, setJournalTrades] = useState<JournalTrade[]>([]);
  const [pendingEntries, setPendingEntries] = useState<PendingEntry[]>([]);
  const [calendar, setCalendar] = useState<CalendarSnapshot | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const todayKey = useRef(currentTradingDayKey()).current;

  const refreshAccount = useCallback(async () => {
    try {
      const payload = await apiGet<{ data: AccountSummary }>('/api/oanda/account-summary');
      setAccount(payload.data);
    } catch {
      // The slow refresh below reports the outage.
    }
  }, []);

  const refreshOpenPositions = useCallback(async () => {
    try {
      const payload = await apiGet<{ data: OpenPosition[] }>('/api/oanda/open-positions');
      setOpenPositions(payload.data);
    } catch {
      // A broker snapshot outage must not make the rest of Home unavailable.
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [accountPayload, historyPayload, journalPayload] = await Promise.all([
        apiGet<{ data: AccountSummary }>('/api/oanda/account-summary'),
        apiGet<{ data: AccountBalanceHistoryPoint[] }>('/api/oanda/account-history'),
        apiGet<{ trades: JournalTrade[] }>('/api/journal/trades?limit=50&filter=all'),
      ]);
      setAccount(accountPayload.data);
      setAccountHistory(historyPayload.data);
      setJournalTrades(journalPayload.trades);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Dashboard data is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPendingEntries = useCallback(async () => {
    try {
      const payload = await apiGet<{ entries?: PendingEntry[] }>('/api/pending-entries');
      setPendingEntries((payload.entries ?? []).filter((entry) => entry.status === 'PENDING' || entry.status === 'TRIGGERING'));
    } catch {
      // Non-fatal: the rest of Home stays usable during a pending-entries outage.
    }
  }, []);

  const refreshCalendar = useCallback(async () => {
    setCalendarLoading(true);
    try {
      const payload = await apiGet<{ data: CalendarSnapshot }>('/api/oanda/calendar');
      setCalendar(payload.data);
    } catch {
      setCalendar(null);
    } finally {
      setCalendarLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAccount();
    const timer = setInterval(() => void refreshAccount(), 5_000);
    return () => clearInterval(timer);
  }, [refreshAccount]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void refreshOpenPositions();
    const timer = setInterval(() => void refreshOpenPositions(), 15_000);
    return () => clearInterval(timer);
  }, [refreshOpenPositions]);

  useEffect(() => {
    void refreshPendingEntries();
    const timer = setInterval(() => void refreshPendingEntries(), 5_000);
    return () => clearInterval(timer);
  }, [refreshPendingEntries]);

  useEffect(() => {
    void refreshCalendar();
    const timer = setInterval(() => void refreshCalendar(), 60_000);
    return () => clearInterval(timer);
  }, [refreshCalendar]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshAccount();
        void refresh();
        void refreshOpenPositions();
        void refreshPendingEntries();
      }
    });
    return () => subscription.remove();
  }, [refreshAccount, refresh, refreshOpenPositions, refreshPendingEntries]);

  return {
    account,
    accountHistory,
    openPositions,
    journalTrades,
    pendingEntries,
    calendar,
    calendarLoading,
    loading,
    error,
    todayKey,
    refresh,
  };
}
