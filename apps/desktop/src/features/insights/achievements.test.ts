import { describe, expect, it } from "vitest";
import {
  buildAchievementTracks,
  buildAchievementWallItems,
  buildSpecialAchievements,
  calculateAchievementTrackProgress,
  selectDefaultTrackMilestone,
  selectTrackCover,
} from "./achievements";
import type { Achievement } from "@/core/types";

function achievement(
  category: string,
  threshold: number,
  progress: number,
  unlocked = false,
): Achievement {
  return {
    code: `${category}-${threshold}`,
    category,
    threshold,
    progress,
    unlocked_at: unlocked ? "2026-01-01T00:00:00Z" : undefined,
  };
}

describe("achievement milestone tracks", () => {
  it("groups milestones in a stable category and threshold order", () => {
    const tracks = buildAchievementTracks([
      achievement("commit", 10, 12, true),
      achievement("token", 1_000_000, 2_000_000, true),
      achievement("token", 100_000, 2_000_000, true),
      achievement("agents", 2, 1),
    ]);

    expect(tracks.map((track) => track.category)).toEqual([
      "token",
      "session",
      "commit",
      "active-days",
      "streak",
      "workspaces",
      "agents",
    ]);
    expect(tracks[0].milestones.map((milestone) => milestone.threshold)).toEqual([
      100_000, 1_000_000,
    ]);
    expect(tracks[0].completed).toBe(2);
    expect(tracks.find((track) => track.category === "agents")?.next?.threshold).toBe(2);
  });

  it("calculates progress inside the current threshold segment", () => {
    const milestones = [
      achievement("streak", 3, 19, true),
      achievement("streak", 7, 19, true),
      achievement("streak", 30, 19),
      achievement("streak", 100, 19),
    ];

    expect(calculateAchievementTrackProgress(milestones, 19)).toBeCloseTo((2 + 12 / 23) / 4);
  });

  it("handles not-started and completed tracks", () => {
    const milestones = [achievement("agents", 2, 0), achievement("agents", 4, 0)];
    expect(calculateAchievementTrackProgress(milestones, 0)).toBe(0);
    expect(
      calculateAchievementTrackProgress(
        milestones.map((item) => ({ ...item, progress: 5 })),
        5,
      ),
    ).toBe(1);
  });

  it("retains a permanently unlocked milestone if current progress drops", () => {
    const milestones = [achievement("commit", 10, 5, true), achievement("commit", 100, 5)];
    const track = buildAchievementTracks(milestones).find((value) => value.category === "commit")!;
    expect(track.completed).toBe(1);
    expect(track.next?.threshold).toBe(100);
  });

  it("keeps special achievements out of numeric tracks and in a stable order", () => {
    const achievements = [
      achievement("token", 100_000, 100_000, true),
      { code: "special-night-owl", category: "special", threshold: 1, progress: 0 },
      { code: "special-first-memory", category: "special", threshold: 1, progress: 1 },
      {
        code: "special-first-changeset",
        category: "special",
        threshold: 1,
        progress: 1,
        unlocked_at: "2026-01-02T00:00:00Z",
      },
    ];

    expect(buildAchievementTracks(achievements).flatMap((track) => track.milestones)).toHaveLength(
      1,
    );
    expect(buildSpecialAchievements(achievements)).toEqual([
      expect.objectContaining({
        achievement: expect.objectContaining({ code: "special-first-changeset" }),
        secret: false,
        unlocked: true,
      }),
      expect.objectContaining({
        achievement: expect.objectContaining({ code: "special-first-memory" }),
        secret: false,
        unlocked: true,
      }),
      expect.objectContaining({
        achievement: expect.objectContaining({ code: "special-night-owl" }),
        secret: true,
        unlocked: false,
      }),
    ]);
  });

  it("uses the highest unlocked milestone as the track cover and the first target before progress starts", () => {
    const progressed = buildAchievementTracks([
      achievement("token", 100_000, 2_000_000, true),
      achievement("token", 1_000_000, 2_000_000, true),
      achievement("token", 10_000_000, 2_000_000),
    ])[0];
    expect(selectTrackCover(progressed).threshold).toBe(1_000_000);
    expect(selectDefaultTrackMilestone(progressed).threshold).toBe(1_000_000);

    const unstarted = buildAchievementTracks([
      achievement("agents", 1, 0),
      achievement("agents", 2, 0),
    ]).find((track) => track.category === "agents")!;
    expect(selectTrackCover(unstarted).threshold).toBe(1);
  });

  it("combines tracks and special achievements and sorts them by recent unlock", () => {
    const items = buildAchievementWallItems([
      { ...achievement("token", 100_000, 100_000, true), unlocked_at: "2026-01-02T00:00:00Z" },
      { ...achievement("commit", 1, 1, true), unlocked_at: "2026-01-01T00:00:00Z" },
      achievement("agents", 1, 1),
      {
        code: "special-first-changeset",
        category: "special",
        threshold: 1,
        progress: 1,
        unlocked_at: "2026-01-03T00:00:00Z",
      },
      { code: "special-night-owl", category: "special", threshold: 1, progress: 0 },
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "special:special-first-changeset",
      "track:token",
      "track:commit",
      "track:agents",
      "special:special-night-owl",
    ]);
  });

  it("keeps unlocked items with unknown dates before locked items in stable order", () => {
    const items = buildAchievementWallItems([
      achievement("token", 100_000, 100_000),
      achievement("commit", 1, 0),
      { code: "special-first-memory", category: "special", threshold: 1, progress: 1 },
      { code: "special-night-owl", category: "special", threshold: 1, progress: 0 },
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "track:token",
      "special:special-first-memory",
      "track:commit",
      "special:special-night-owl",
    ]);
  });
});
