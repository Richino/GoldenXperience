import { useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Card } from "@/components/ui/Card";
import { AppText } from "@/components/ui/AppText";
import { DetailHeader } from "@/components/ui/DetailHeader";

/** Signal detail — Phase 1 stub; the full signal view follows with the chart. */
export default function SignalDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Screen scroll>
      <DetailHeader title="Signal" />
      <Card>
        <AppText tone="muted" eyebrow>
          Signal reference
        </AppText>
        <AppText size="sm" weight="600" mono style={{ marginTop: 4 }}>
          {id}
        </AppText>
        <AppText tone="secondary" size="sm" style={{ marginTop: 12 }}>
          The full signal breakdown with live chart context arrives in Phase 2.
        </AppText>
      </Card>
    </Screen>
  );
}
