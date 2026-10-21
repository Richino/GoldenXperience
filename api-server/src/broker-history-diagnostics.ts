/** Only allow diagnostic metadata: provider bodies and database row details can contain private data. */
export function brokerHistoryFailure(stage: "broker-read" | "database-import", error: unknown) {
  const source = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const errorType = typeof source.name === "string" && ["Error", "OandaRequestError", "RangeError", "SyntaxError", "TypeError", "AbortError", "TimeoutError", "AggregateError"].includes(source.name) ? source.name : "Error";
  const status = typeof source.status === "number" && Number.isInteger(source.status) && source.status >= 400 && source.status <= 599 ? source.status : null;
  const code = typeof source.code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/.test(source.code) ? source.code : null;
  const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value) ? value : null;
  const timedOut = source.name === "AbortError" || source.name === "TimeoutError" || source.message === "OANDA request timed out.";
  const reason = stage === "broker-read"
    ? status === 401 || status === 403 ? "broker-authentication"
      : status === 429 ? "broker-rate-limit"
      : status !== null ? "broker-http"
      : timedOut ? "broker-timeout"
      : source.name === "RangeError" || source.name === "SyntaxError" ? "broker-response-data"
      : "broker-connection"
    : timedOut ? "database-timeout" : code?.startsWith("42") ? "database-schema" : "database-import";
  return {
    stage, reason, errorType, httpStatus: status, code,
    // Constraint/table/column names identify a failed migration or validation without logging rows or SQL parameters.
    ...(stage === "database-import" ? {
      constraint: identifier(source.constraint), table: identifier(source.table), column: identifier(source.column),
    } : {}),
  };
}
