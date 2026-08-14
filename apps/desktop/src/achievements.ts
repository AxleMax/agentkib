import type { Achievement } from "./types";

export const achievementCategories = [
  "token",
  "session",
  "commit",
  "active-days",
  "streak",
  "workspaces",
  "agents",
] as const;

export const productAchievementCodes = [
  "special-first-changeset",
  "special-first-memory",
  "special-shared-workspace",
  "special-exact-attribution",
  "special-remote-handshake",
] as const;

export const secretAchievementCodes = [
  "special-night-owl",
  "special-comeback",
  "special-same-day-delivery",
] as const;

export type AchievementCategory = typeof achievementCategories[number];

export interface AchievementTrack {
  category: AchievementCategory;
  progress: number;
  milestones: Achievement[];
  completed: number;
  next?: Achievement;
  progressRatio: number;
}

export interface SpecialAchievement {
  achievement: Achievement;
  secret: boolean;
  unlocked: boolean;
}

export function achievementReached(achievement: Achievement) {
  return Boolean(achievement.unlocked_at) || achievement.progress >= achievement.threshold;
}

export function buildAchievementTracks(achievements: Achievement[]): AchievementTrack[] {
  return achievementCategories.map((category) => {
    const milestones = achievements
      .filter((achievement) => achievement.category === category)
      .sort((left, right) => left.threshold - right.threshold);
    const progress = milestones.reduce((value, milestone) => Math.max(value, milestone.progress), 0);
    const completed = milestones.filter(achievementReached).length;
    const next = milestones.find((milestone) => !achievementReached(milestone));
    return {
      category,
      progress,
      milestones,
      completed,
      next,
      progressRatio: calculateAchievementTrackProgress(milestones, progress),
    };
  });
}

export function buildSpecialAchievements(achievements: Achievement[]): SpecialAchievement[] {
  const byCode = new Map(achievements.map((achievement) => [achievement.code, achievement]));
  return [...productAchievementCodes, ...secretAchievementCodes].flatMap((code) => {
    const achievement = byCode.get(code);
    return achievement ? [{
      achievement,
      secret: (secretAchievementCodes as readonly string[]).includes(code),
      unlocked: achievementReached(achievement),
    }] : [];
  });
}

export function calculateAchievementTrackProgress(milestones: Achievement[], progress: number) {
  if (!milestones.length) return 0;
  const ordered = [...milestones].sort((left, right) => left.threshold - right.threshold);
  const nextIndex = ordered.findIndex((milestone) => !achievementReached(milestone));
  if (nextIndex === -1) return 1;
  const previousThreshold = nextIndex === 0 ? 0 : ordered[nextIndex - 1].threshold;
  const nextThreshold = ordered[nextIndex].threshold;
  const span = Math.max(1, nextThreshold - previousThreshold);
  const segmentProgress = Math.max(0, Math.min(1, (progress - previousThreshold) / span));
  return Math.max(0, Math.min(1, (nextIndex + segmentProgress) / ordered.length));
}
