import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioFetch } from "../src/lib/api";

const { auth } = vi.hoisted(() => ({
  auth: { currentUser: null as null | { getIdToken: (force?: boolean) => Promise<string> } },
}));
vi.mock("../src/lib/firebase", () => ({ auth }));

const getIdToken = vi.fn();
const fetchRequest = vi.fn();
const reply = (status: number, error?: string) => new Response(JSON.stringify({ error }), { status });

beforeEach(() => {
  getIdToken.mockReset().mockResolvedValueOnce("cached-token").mockResolvedValueOnce("refreshed-token");
  fetchRequest.mockReset();
  auth.currentUser = { getIdToken };
  vi.stubGlobal("fetch", fetchRequest);
});

afterEach(() => vi.unstubAllGlobals());

describe("studio token refresh", () => {
  it("refreshes once and retries the same request with the new token after a 401", async () => {
    fetchRequest.mockResolvedValueOnce(reply(401)).mockResolvedValueOnce(reply(200));
    const signal = new AbortController().signal;
    await expect(studioFetch("/songs/test/archive", "POST", { archived: true }, signal)).resolves.toMatchObject({ status: 200 });
    expect(getIdToken.mock.calls).toEqual([[], [true]]);
    const request = { method: "POST", body: '{"archived":true}', signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer cached-token" } };
    expect(fetchRequest).toHaveBeenNthCalledWith(1, "/api/songs/test/archive", request);
    expect(fetchRequest).toHaveBeenNthCalledWith(2, "/api/songs/test/archive", {
      ...request, headers: { ...request.headers, Authorization: "Bearer refreshed-token" },
    });
  });

  it("keeps the second 401 and stops", async () => {
    fetchRequest.mockResolvedValueOnce(reply(401)).mockResolvedValueOnce(reply(401, "Invalid sign-in token."));
    await expect(studioFetch("/session")).rejects.toMatchObject({ status: 401, message: "Invalid sign-in token." });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(getIdToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, "server policy text", "This Google account is not allowed."],
    [503, "Server cannot verify sign-ins (configuration)", "Server cannot verify sign-ins (configuration)"],
    [503, "Server cannot access Firebase data (configuration)", "Server cannot access Firebase data (configuration)"],
  ])("reports HTTP %s without refreshing the token or changing the session", async (status, error, message) => {
    const user = auth.currentUser;
    fetchRequest.mockResolvedValueOnce(reply(status, error));
    await expect(studioFetch("/session")).rejects.toMatchObject({ status, message });
    expect(getIdToken).toHaveBeenCalledTimes(1);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(auth.currentUser).toBe(user);
  });

  it("does not retry using a different signed-in user", async () => {
    const other = { getIdToken: vi.fn() };
    fetchRequest.mockImplementationOnce(async () => {
      auth.currentUser = other;
      return reply(401, "Invalid sign-in token.");
    });
    await expect(studioFetch("/session")).rejects.toMatchObject({ status: 401 });
    expect(other.getIdToken).not.toHaveBeenCalled();
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });
});
