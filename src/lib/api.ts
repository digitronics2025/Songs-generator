import { auth } from "./firebase";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function studioFetch(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, "Sign in with Google to continue.");
  const token = await user.getIdToken();
  signal?.throwIfAborted();
  if (!token || auth.currentUser !== user) throw new ApiError(401, "Sign in with Google to continue.");

  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  const send = (value: string) => fetch("/api" + path, {
    method, signal, headers: {
      Authorization: "Bearer " + value, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }, ...(requestBody === undefined ? {} : { body: requestBody }),
  });
  let response = await send(token);
  if (response.status === 401 && auth.currentUser === user && !signal?.aborted) {
    const refreshed = await user.getIdToken(true).catch(() => undefined);
    signal?.throwIfAborted();
    if (refreshed && auth.currentUser === user) response = await send(refreshed);
  }
  if (!response.ok) {
    if (response.status === 403) throw new ApiError(403, "This Google account is not allowed.");
    const payload = await response.json().catch(() => ({})) as { error?: unknown } | null;
    const message = typeof payload?.error === "string" ? payload.error :
      response.status === 503 ? "Studio configuration is unavailable. Try again or contact the owner." : "Studio request failed.";
    throw new ApiError(response.status, message);
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
