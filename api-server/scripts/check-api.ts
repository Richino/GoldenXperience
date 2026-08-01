const baseUrl = process.env.API_SERVER_URL || "http://localhost:8787";

async function main() {
  const root = baseUrl.replace(/\/$/, "");
  const health = await fetch(`${root}/health`, { headers: { Accept: "application/json" } });
  const healthPayload = await health.json();
  if (!health.ok || healthPayload.ok !== true) throw new Error("API health check failed.");
  const response = await fetch(`${root}/api/oanda/test`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json();
  console.log(JSON.stringify({ health: healthPayload, protectedRouteStatus: response.status, protectedRoute: payload }, null, 2));
  if (response.status !== 401) throw new Error("Protected API route did not reject an unauthenticated request.");
}

main().catch((error) => {
  console.error(`Could not reach ${baseUrl}. Start the API server first.`);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
