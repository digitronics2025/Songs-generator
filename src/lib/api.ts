import { auth } from "./firebase";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function studioFetch(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new ApiError(401, "Sign in with Google to continue.");
  const response = await fetch("/api" + path, {
    method, signal, headers: {
      Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(response.status, payload.error || "Studio request failed.");
  }
  return response;
}

export async function studioApi<T = { saved: boolean }>(path: string, method?: string, body?: unknown, signal?: AbortSignal) {
  return (await studioFetch(path, method, body, signal)).json() as Promise<T>;
}

export const songPath = (id: string) => "/songs/" + encodeURIComponent(id);
export async function studioAudio(path: string | null | undefined, signal?: AbortSignal) {
  if (!path) throw new Error("This take has no stored audio.");
  return (await studioFetch("/storage-proxy?path=" + encodeURIComponent(path), "GET", undefined, signal)).blob();
}
