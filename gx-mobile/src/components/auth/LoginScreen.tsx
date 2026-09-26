import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme, shadows, type ThemeColors } from '@/constants/theme';
import { useThemeColors, useThemedStyles } from '@/lib/theme/useTheme';
import { Text } from '@/components/ui/AppText';
import { useAuth } from '@/lib/auth/AuthContext';

export function LoginScreen() {
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { signIn, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email || !password || busy) return;
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch {
      // error surfaced via useAuth().error
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.content, { paddingTop: Math.max(insets.top, 16), paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>Gx</Text>
          </View>
          <View>
            <Text style={styles.brandTitle}>
              Golden<Text style={{ color: colors.primary }}>X</Text>perience
            </Text>
            <Text style={styles.brandSubtitle}>Forex workspace</Text>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeading}>
            <View style={styles.securityIcon}>
              <SymbolView name={{ ios: 'lock', android: 'lock', web: 'lock' }} size={16} tintColor={colors.primary} />
            </View>
            <View style={styles.cardHeadingText}>
              <Text style={styles.overline}>Secure access</Text>
              <Text style={styles.heading}>Welcome back</Text>
              <Text style={styles.subheading}>Sign in to your personal forex workspace.</Text>
            </View>
          </View>

          <View style={styles.fields}>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Email address</Text>
              <View style={styles.inputWrap}>
                <SymbolView name={{ ios: 'envelope', android: 'mail', web: 'mail' }} size={15} tintColor={colors.textSecondary} />
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  style={styles.input}
                />
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Password</Text>
              <View style={styles.inputWrap}>
                <SymbolView name={{ ios: 'lock', android: 'lock', web: 'lock' }} size={15} tintColor={colors.textSecondary} />
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Enter your password"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.input}
                />
                <Pressable onPress={() => setShowPassword((value) => !value)} hitSlop={8}>
                  <SymbolView
                    name={{ ios: showPassword ? 'eye.slash' : 'eye', android: showPassword ? 'visibility_off' : 'visibility', web: showPassword ? 'visibility_off' : 'visibility' }}
                    size={15}
                    tintColor={colors.textSecondary}
                  />
                </Pressable>
              </View>
            </View>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable onPress={submit} disabled={busy} style={[styles.submit, busy ? styles.submitBusy : null]}>
            {busy ? <ActivityIndicator color="#04140d" /> : <Text style={styles.submitText}>Sign in to workspace</Text>}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 24,
  },
  brandMark: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  brandMarkText: {
    fontSize: 16,
    fontFamily: theme.fonts.sansExtraBold,
    color: colors.primary,
  },
  brandTitle: {
    fontSize: 15,
    fontFamily: theme.fonts.sansBold,
    color: colors.textPrimary,
  },
  brandSubtitle: {
    marginTop: 1,
    fontSize: 10,
    fontFamily: theme.fonts.sansSemiBold,
    letterSpacing: 1,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: theme.radii.hero,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    padding: 22,
    ...shadows(colors).card,
  },
  cardHeading: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 22,
  },
  securityIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  cardHeadingText: {
    flex: 1,
  },
  overline: {
    fontSize: 10,
    fontFamily: theme.fonts.sansBold,
    letterSpacing: 1,
    color: colors.primary,
    textTransform: 'uppercase',
  },
  heading: {
    marginTop: 2,
    fontSize: 21,
    fontFamily: theme.fonts.sansBold,
    color: colors.textPrimary,
  },
  subheading: {
    marginTop: 4,
    fontSize: 12.5,
    fontFamily: theme.fonts.sans,
    color: colors.textSecondary,
  },
  fields: {
    gap: 16,
  },
  field: {
    gap: 7,
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: theme.fonts.sansSemiBold,
    color: colors.textMutedStrong,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: theme.radii.md,
    paddingHorizontal: 13,
    paddingVertical: Platform.OS === 'ios' ? 12 : 4,
    backgroundColor: colors.surfaceRaised,
  },
  input: {
    flex: 1,
    fontSize: 14,
    fontFamily: theme.fonts.sans,
    color: colors.textPrimary,
  },
  error: {
    marginTop: 14,
    fontSize: 12,
    fontFamily: theme.fonts.sansMedium,
    color: colors.danger,
  },
  submit: {
    marginTop: 20,
    height: 48,
    borderRadius: theme.radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  submitBusy: {
    opacity: 0.85,
  },
  submitText: {
    fontSize: 14,
    fontFamily: theme.fonts.sansBold,
    color: '#04140d',
  },
});
