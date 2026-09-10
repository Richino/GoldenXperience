import { View } from "react-native";
import { Card } from "@/components/ui/Card";
import { AppText } from "@/components/ui/AppText";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { formatMoney, formatR, formatSignedMoney } from "@/lib/format";
import type { AccountSummary } from "@/types/api";

interface AccountHeroProps {
  account: AccountSummary;
  userLabel: string;
  /** Live-marked P/L across open positions, or null while unknown. */
  openPL: number | null;
  todayNet: number | null;
  todayR: number | null;
}

/**
 * The account overview — NAV as the headline figure with the day's realised
 * result and live open P/L beneath. NAV (not balance) leads because it already
 * includes unrealised movement; a balance note appears only when they diverge.
 */
export function AccountHero({ account, userLabel, openPL, todayNet, todayR }: AccountHeroProps) {
  const colors = useColors();
  const balanceDiffers = Math.abs(account.balance - account.nav) >= 0.01;

  return (
    <Card elevated>
      <AppText tone="muted" eyebrow>
        {userLabel}
      </AppText>
      <AppText size="hero" weight="800" mono style={{ marginTop: spacing.xs }}>
        {formatMoney(account.nav, account.currency)}
      </AppText>
      {balanceDiffers ? (
        <AppText tone="muted" size="xs" style={{ marginTop: 2 }}>
          Balance {formatMoney(account.balance, account.currency)}
        </AppText>
      ) : null}

      <View style={{ flexDirection: "row", gap: spacing.xl, marginTop: spacing.lg }}>
        <HeroStat
          label="Open P/L"
          value={openPL === null ? "—" : formatSignedMoney(openPL, account.currency)}
          tone={openPL === null ? "muted" : openPL >= 0 ? "positive" : "negative"}
        />
        <HeroStat
          label="Today"
          value={todayNet === null ? "—" : formatSignedMoney(todayNet, account.currency)}
          tone={todayNet === null ? "muted" : todayNet >= 0 ? "positive" : "negative"}
        />
        <HeroStat
          label="Today R"
          value={formatR(todayR)}
          tone={todayR === null ? "muted" : todayR >= 0 ? "positive" : "negative"}
        />
      </View>

      <View style={{ height: 1, backgroundColor: colors.border, marginTop: spacing.lg }} />
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: spacing.md }}>
        <HeroMeta label="Margin used" value={formatMoney(account.marginUsed, account.currency)} />
        <HeroMeta label="Available" value={formatMoney(account.marginAvailable, account.currency)} />
        <HeroMeta label="Open" value={String(account.openTradeCount)} />
      </View>
    </Card>
  );
}

function HeroStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "positive" | "negative" | "muted";
}) {
  return (
    <View style={{ gap: 3 }}>
      <AppText tone="muted" eyebrow>
        {label}
      </AppText>
      <AppText size="lg" weight="700" mono tone={tone === "muted" ? "muted" : tone}>
        {value}
      </AppText>
    </View>
  );
}

function HeroMeta({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <AppText tone="muted" size="xs">
        {label}
      </AppText>
      <AppText size="sm" weight="600" mono>
        {value}
      </AppText>
    </View>
  );
}
