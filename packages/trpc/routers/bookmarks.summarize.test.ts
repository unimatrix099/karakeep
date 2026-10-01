import { beforeEach, describe, expect, test, vi } from "vitest";

import { InferenceRateLimitedError } from "@karakeep/shared/inferenceRateLimit";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

const inferenceMocks = vi.hoisted(() => ({
  buildInferenceClient: vi.fn(),
  inferFromText: vi.fn(),
}));

vi.mock("@karakeep/shared/inference", () => ({
  InferenceClientFactory: {
    build: inferenceMocks.buildInferenceClient,
  },
  EmbeddingClientFactory: {
    build: vi.fn(() => null),
  },
}));

beforeEach<CustomTestContext>(async (context) => {
  await defaultBeforeEach(true)(context);
  inferenceMocks.buildInferenceClient.mockReset();
  inferenceMocks.inferFromText.mockReset();
  inferenceMocks.buildInferenceClient.mockReturnValue({
    inferFromText: inferenceMocks.inferFromText,
  });
});

describe("bookmark summarization", () => {
  test<CustomTestContext>("returns TOO_MANY_REQUESTS when the inference rate limit is hit", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await api.createBookmark({
      url: "https://example.com",
      type: BookmarkTypes.LINK,
    });
    inferenceMocks.inferFromText.mockRejectedValue(
      new InferenceRateLimitedError("inference", 30),
    );

    await expect(
      api.summarizeBookmark({ bookmarkId: bookmark.id }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "AI provider rate limit reached, retry in 30s",
    });
    expect(inferenceMocks.inferFromText).toHaveBeenCalledTimes(1);
  });

  test<CustomTestContext>("propagates other inference failures unchanged", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].bookmarks;
    const bookmark = await api.createBookmark({
      url: "https://example.com",
      type: BookmarkTypes.LINK,
    });
    inferenceMocks.inferFromText.mockRejectedValue(
      new Error("provider unavailable"),
    );

    await expect(
      api.summarizeBookmark({ bookmarkId: bookmark.id }),
    ).rejects.toThrow("provider unavailable");
  });
});
