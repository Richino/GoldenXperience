import "server-only";

import { serverApiUrl } from "@/lib/api/url";

export async function getApiData<T>(path: string): Promise<T> {
  const response = await fetch(serverApiUrl(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`API request failed with ${response.status}.`);
  return response.json() as Promise<T>;
}
