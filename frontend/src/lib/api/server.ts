import "server-only";
import { cookies } from "next/headers";

import { serverApiUrl } from "@/lib/api/url";

export async function getApiData<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const response = await fetch(serverApiUrl(path), { cache: "no-store", headers: { cookie: cookieStore.toString() } });
  if (!response.ok) throw new Error(`API request failed with ${response.status}.`);
  return response.json() as Promise<T>;
}
