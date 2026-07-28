import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const baseUrl = process.env.API_SERVER_URL || process.env.NEXT_PUBLIC_API_SERVER_URL || "http://localhost:8787";

async function main() {
  const response = await fetch(`${baseUrl}/api/oanda/test`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json();

  console.log(JSON.stringify(payload, null, 2));

  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    `Could not reach ${baseUrl}. Start the API server with "npm run start" first.`,
  );
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
