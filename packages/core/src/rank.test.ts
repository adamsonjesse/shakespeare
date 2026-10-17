import { describe, expect, it } from "vitest";
import { applyTheme, assistPayload, mergeWeights, rankItems, readWeightDelta, threadMessages } from "./rank.ts";

const HALF_LIFE_MS = 60 * 60 * 1000;
const NOW = "2099-01-01T10:00:00.000Z";

describe("rankItems", () => {
  it("returns an empty list for empty input", () => {
    expect(rankItems([], NOW, HALF_LIFE_MS)).toEqual([]);
  });

  it("ranks a theme match ahead of an equal-recency non-match", () => {
    const createdAt = NOW;
    const ranked = rankItems(
      [
        { id: "plain", createdAt, matchesTheme: false },
        { id: "match", createdAt, matchesTheme: true },
      ],
      NOW,
      HALF_LIFE_MS,
    );
    expect(ranked.map((item) => item.id)).toEqual(["match", "plain"]);
  });

  it("lets a much newer non-match outrank a stale match", () => {
    const ranked = rankItems(
      [
        { id: "stale", createdAt: "2099-01-01T00:00:00.000Z", matchesTheme: true },
        { id: "fresh", createdAt: NOW, matchesTheme: false },
      ],
      NOW,
      HALF_LIFE_MS,
    );
    expect(ranked.map((item) => item.id)).toEqual(["fresh", "stale"]);
  });

  it("breaks equal scores by newer time, then by id", () => {
    const ranked = rankItems(
      [
        { id: "b", createdAt: "2099-01-01T08:00:00.000Z", matchesTheme: false },
        { id: "c", createdAt: "2099-01-01T09:00:00.000Z", matchesTheme: false },
        { id: "a", createdAt: "2099-01-01T09:00:00.000Z", matchesTheme: false },
      ],
      NOW,
      HALF_LIFE_MS,
    );
    expect(ranked.map((item) => item.id)).toEqual(["a", "c", "b"]);
  });

  it("nests each reply one level under its parent", () => {
    const threaded = threadMessages(
      [
        { id: "root", parentId: null, createdAt: "2099-01-01T08:00:00.000Z", matchesTheme: false, read: false },
        { id: "child", parentId: "root", createdAt: "2099-01-01T09:00:00.000Z", matchesTheme: false, read: false },
        { id: "grand", parentId: "child", createdAt: NOW, matchesTheme: false, read: false },
      ],
      NOW,
      HALF_LIFE_MS,
    );
    expect(threaded.map((row) => [row.item.id, row.indent])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grand", 1],
    ]);
  });

  it("lists unread roots before read roots", () => {
    const threaded = threadMessages(
      [
        { id: "read", parentId: null, createdAt: NOW, matchesTheme: false, read: true },
        { id: "unread", parentId: null, createdAt: "2099-01-01T08:00:00.000Z", matchesTheme: false, read: false },
      ],
      NOW,
      HALF_LIFE_MS,
    );
    expect(threaded.map((row) => row.item.id)).toEqual(["unread", "read"]);
  });

  it("hides text that does not match the theme, including unverified rows", () => {
    const messages = [
      { id: "a", verified: true, body: "runway plan" },
      { id: "b", verified: true, body: "hello club" },
      { id: "c", verified: false },
    ];
    expect(applyTheme(messages, ["Runway"]).map((message) => message.id)).toEqual(["a"]);
    expect(applyTheme(messages, null).map((message) => message.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the milestone 3 order when theme weights are empty", () => {
    const createdAt = NOW;
    const items = [
      { id: "b", createdAt, matchesTheme: false, themeIds: ["theme-b"] },
      { id: "m", createdAt, matchesTheme: false, themeIds: ["theme-a"] },
    ];
    expect(rankItems(items, NOW, HALF_LIFE_MS).map((item) => item.id)).toEqual(["b", "m"]);
    expect(rankItems(items, NOW, HALF_LIFE_MS, {}).map((item) => item.id)).toEqual(["b", "m"]);
  });

  it("lifts an equally recent theme A item above theme B after a bookmark weight", () => {
    const createdAt = NOW;
    const items = [
      { id: "b", createdAt, matchesTheme: false, themeIds: ["theme-b"] },
      { id: "m", createdAt, matchesTheme: false, themeIds: ["theme-a"] },
    ];
    expect(rankItems(items, NOW, HALF_LIFE_MS, {}).map((item) => item.id)).toEqual(["b", "m"]);
    expect(rankItems(items, NOW, HALF_LIFE_MS, { "theme-a": 1 }).map((item) => item.id)).toEqual(["m", "b"]);
  });

  it("produces that weighted order while no hub process is running", () => {
    const createdAt = NOW;
    const items = [
      { id: "b", createdAt, matchesTheme: false, themeIds: ["theme-b"] },
      { id: "m", createdAt, matchesTheme: false, themeIds: ["theme-a"] },
    ];
    expect(rankItems(items, NOW, HALF_LIFE_MS, { "theme-a": 1 }).map((item) => item.id)).toEqual(["m", "b"]);
  });

  it("ignores a read shorter than the dwell and counts a read that reaches it", () => {
    expect(readWeightDelta("2099-01-01T10:00:00.000Z", "2099-01-01T10:00:01.999Z")).toBe(0);
    expect(readWeightDelta("2099-01-01T10:00:00.000Z", "2099-01-01T10:00:02.000Z")).toBe(1);
  });

  it("keeps assist off from changing weights and drops message text from the payload", () => {
    const remote = [{ themeId: "theme-a", weight: 1, body: "hello club" }];
    expect(mergeWeights({}, remote, false)).toEqual({});
    expect(mergeWeights({}, remote, true)).toEqual({ "theme-a": 1 });
    const payload = assistPayload("alice", remote);
    expect(JSON.stringify(payload).includes("hello club")).toBe(false);
    expect(payload).toEqual({
      op: "publish-weights",
      publicKey: "alice",
      weights: [{ themeId: "theme-a", weight: 1 }],
    });
  });
});
