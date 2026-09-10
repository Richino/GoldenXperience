import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { Redirect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { useColors } from "@/theme/ThemeProvider";
import { radius, spacing } from "@/theme/tokens";
import { AppText } from "@/components/ui/AppText";

export default function LoginScreen() {
  const { status, signIn } = useAuth();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "authenticated") return <Redirect href="/(tabs)" />;

  const canSubmit = email.trim().length > 3 && password.length >= 1 && !submitting;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
      // On success the AuthProvider flips to authenticated and the redirect
      // above unmounts this screen.
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.isOffline
            ? "Can’t reach GoldenXperience. Check your connection."
            : err.message
          : "Sign in failed. Try again.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          paddingHorizontal: spacing.xl,
          paddingTop: insets.top,
          paddingBottom: insets.bottom + spacing.xl,
          gap: spacing.xxl,
        }}
      >
        <View style={{ gap: spacing.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: radius.md,
                backgroundColor: colors.gxAccentSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppText size="lg" weight="800" style={{ color: colors.gxAccent }}>
                G
              </AppText>
            </View>
            <AppText size="xl" weight="800">
              GoldenXperience
            </AppText>
          </View>
          <AppText tone="secondary" size="sm">
            Sign in to your GX trading account.
          </AppText>
        </View>

        <View style={{ gap: spacing.md }}>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="username"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
            autoCapitalize="none"
            textContentType="password"
            onSubmitEditing={onSubmit}
            returnKeyType="go"
          />

          {error ? (
            <AppText size="sm" tone="negative" weight="500">
              {error}
            </AppText>
          ) : null}

          <Pressable
            onPress={onSubmit}
            disabled={!canSubmit}
            style={{
              marginTop: spacing.sm,
              backgroundColor: canSubmit ? colors.gxAccent : colors.surfaceMuted,
              borderRadius: radius.md,
              paddingVertical: spacing.lg - 2,
              alignItems: "center",
            }}
          >
            <AppText
              size="md"
              weight="700"
              style={{ color: canSubmit ? colors.background : colors.textMuted }}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </AppText>
          </Pressable>
        </View>

        <AppText tone="muted" size="xs" style={{ textAlign: "center" }}>
          GoldenXperience · secure session stored in your device keychain
        </AppText>
      </View>
    </KeyboardAvoidingView>
  );
}

interface FieldProps extends React.ComponentProps<typeof TextInput> {
  label: string;
}

function Field({ label, style, ...props }: FieldProps) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      <AppText tone="secondary" eyebrow>
        {label}
      </AppText>
      <TextInput
        {...props}
        placeholderTextColor={colors.textMuted}
        style={[
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            color: colors.textPrimary,
            fontSize: 16,
          },
          style,
        ]}
      />
    </View>
  );
}
