import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { AppText } from "@/components/ui/AppText";

/** A back control + title for pushed (non-tab) detail screens. */
export function DetailHeader({ title }: { title: string }) {
  const colors = useColors();
  const router = useRouter();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg }}>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))} hitSlop={10}>
        <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
      </Pressable>
      <AppText size="lg" weight="700">
        {title}
      </AppText>
    </View>
  );
}
