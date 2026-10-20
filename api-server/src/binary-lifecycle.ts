/** Retired: historical reads remain available; new predictions require explicit opt-in. */
export function binaryCollectionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.BINARY_ENABLED === "true";
}
