/**
 * 成就系统
 *
 * 场景：记录用户学习里程碑，提供正向激励
 */

export interface Achievement {
  /** 成就 ID */
  id: string;
  /** 成就名称 */
  name: string;
  /** 成就描述 */
  description: string;
  /** 成就类型 */
  type: 'streak' | 'milestone' | 'mastery' | 'speed' | 'challenge';
  /** 成就等级（1-5） */
  tier: 1 | 2 | 3 | 4 | 5;
  /** 图标（emoji） */
  icon: string;
  /** 解锁条件描述 */
  requirement: string;
  /** 是否已解锁 */
  unlocked: boolean;
  /** 解锁时间 */
  unlockedAt?: number;
  /** 当前进度（用于未解锁的成就） */
  progress?: {
    current: number;
    target: number;
  };
}

export interface AchievementCheck {
  /** 检查的成就列表 */
  achievements: Achievement[];
  /** 新解锁的成就 */
  newlyUnlocked: Achievement[];
}

export interface LearningStats {
  /** 连续学习天数 */
  streakDays: number;
  /** 总学习天数 */
  totalDays: number;
  /** 总笔记数 */
  totalNotes: number;
  /** 总复习卡片数 */
  totalCards: number;
  /** 已进入复习态的卡片数（ts-fsrs state = 2） */
  masteredCards: number;
  /** 第一次复习就进入复习态的卡片数（reps = 1 且 state = 2，即首次评「容易」） */
  perfectCards: number;
  /** 复习次数（所有卡片 reps 之和） */
  reviewCount: number;
  /** 总做题数（做过的不同题目数） */
  totalQuizzes: number;
  /** 做题正确率 */
  quizAccuracy: number;
  /** 单日最多学习分钟数 */
  maxDailyMinutes: number;
}

/**
 * 检查并解锁成就
 *
 * @param stats 学习统计数据
 * @param previousAchievements 之前已解锁的成就（如果为空，则从头开始检查）
 * @returns 成就检查结果
 */
export function checkAchievements(
  stats: LearningStats,
  previousAchievements: Achievement[] = []
): AchievementCheck {
  const allAchievements = defineAchievements();
  const newlyUnlocked: Achievement[] = [];

  // 构建已解锁成就的 Map（用于快速查找）
  const previousUnlockedMap = new Map<string, Achievement>();
  for (const prev of previousAchievements) {
    if (prev.unlocked) {
      previousUnlockedMap.set(prev.id, prev);
    }
  }

  // 评估每个成就
  for (const achievement of allAchievements) {
    const wasUnlocked = previousUnlockedMap.has(achievement.id);

    if (wasUnlocked) {
      // 已解锁，保留之前的状态
      const prevAchievement = previousUnlockedMap.get(achievement.id)!;
      achievement.unlocked = true;
      achievement.unlockedAt = prevAchievement.unlockedAt;
    } else {
      // 未解锁，评估是否解锁
      const unlockResult = evaluateAchievement(achievement, stats);

      if (unlockResult.unlocked) {
        achievement.unlocked = true;
        achievement.unlockedAt = Date.now();
        newlyUnlocked.push(achievement);
      } else {
        achievement.unlocked = false;
        achievement.progress = unlockResult.progress;
      }
    }
  }

  return {
    achievements: allAchievements,
    newlyUnlocked,
  };
}

/**
 * 定义所有成就
 */
function defineAchievements(): Achievement[] {
  return [
    // ===== 连续学习成就 =====
    {
      id: 'streak-3',
      name: '初心不改',
      description: '连续学习 3 天',
      type: 'streak',
      tier: 1,
      icon: '🔥',
      requirement: '连续 3 天学习',
      unlocked: false,
    },
    {
      id: 'streak-7',
      name: '一周坚持',
      description: '连续学习 7 天',
      type: 'streak',
      tier: 2,
      icon: '🔥',
      requirement: '连续 7 天学习',
      unlocked: false,
    },
    {
      id: 'streak-30',
      name: '月度冠军',
      description: '连续学习 30 天',
      type: 'streak',
      tier: 3,
      icon: '🏆',
      requirement: '连续 30 天学习',
      unlocked: false,
    },
    {
      id: 'streak-100',
      name: '百日修炼',
      description: '连续学习 100 天',
      type: 'streak',
      tier: 4,
      icon: '💎',
      requirement: '连续 100 天学习',
      unlocked: false,
    },
    {
      id: 'streak-365',
      name: '全年无休',
      description: '连续学习 365 天',
      type: 'streak',
      tier: 5,
      icon: '👑',
      requirement: '连续 365 天学习',
      unlocked: false,
    },

    // ===== 里程碑成就 =====
    {
      id: 'notes-10',
      name: '笔记新手',
      description: '创建 10 篇笔记',
      type: 'milestone',
      tier: 1,
      icon: '📝',
      requirement: '创建 10 篇笔记',
      unlocked: false,
    },
    {
      id: 'notes-50',
      name: '勤奋记录者',
      description: '创建 50 篇笔记',
      type: 'milestone',
      tier: 2,
      icon: '📚',
      requirement: '创建 50 篇笔记',
      unlocked: false,
    },
    {
      id: 'notes-100',
      name: '知识宝库',
      description: '创建 100 篇笔记',
      type: 'milestone',
      tier: 3,
      icon: '🏛️',
      requirement: '创建 100 篇笔记',
      unlocked: false,
    },
    {
      id: 'reviews-100',
      name: '复习先锋',
      description: '完成 100 次复习',
      type: 'milestone',
      tier: 2,
      icon: '🔄',
      requirement: '完成 100 次复习',
      unlocked: false,
    },
    {
      id: 'reviews-500',
      name: '复习大师',
      description: '完成 500 次复习',
      type: 'milestone',
      tier: 3,
      icon: '⭐',
      requirement: '完成 500 次复习',
      unlocked: false,
    },
    {
      id: 'quizzes-100',
      name: '题海初探',
      description: '完成 100 道题目',
      type: 'milestone',
      tier: 2,
      icon: '📋',
      requirement: '完成 100 道题目',
      unlocked: false,
    },
    {
      id: 'quizzes-500',
      name: '刷题达人',
      description: '完成 500 道题目',
      type: 'milestone',
      tier: 3,
      icon: '🎯',
      requirement: '完成 500 道题目',
      unlocked: false,
    },
    {
      id: 'quizzes-1000',
      name: '题库征服者',
      description: '完成 1000 道题目',
      type: 'milestone',
      tier: 4,
      icon: '🏅',
      requirement: '完成 1000 道题目',
      unlocked: false,
    },

    // ===== 掌握度成就 =====
    {
      id: 'review-mastery-100',
      name: '过目成诵',
      description: '100 张卡片进入复习态',
      type: 'mastery',
      tier: 3,
      icon: '🎖️',
      requirement: '100 张卡片已进入复习态',
      unlocked: false,
    },
    {
      id: 'quiz-accuracy-80',
      name: '答题高手',
      description: '做题正确率达到 80%',
      type: 'mastery',
      tier: 3,
      icon: '🥇',
      requirement: '做题正确率 ≥ 80%（至少 100 道题）',
      unlocked: false,
    },
    {
      id: 'perfect-cards-50',
      name: '完美主义者',
      description: '50 张卡片第一次复习就进入复习态',
      type: 'mastery',
      tier: 3,
      icon: '💯',
      requirement: '50 张卡片首次复习即评「容易」',
      unlocked: false,
    },
    {
      id: 'quiz-mastery-90',
      name: '答题宗师',
      description: '做题正确率达到 90%',
      type: 'mastery',
      tier: 3,
      icon: '🥇',
      requirement: '做题正确率 ≥ 90%（至少 100 道题）',
      unlocked: false,
    },

    // ===== 速度成就 =====
    {
      id: 'daily-3hours',
      name: '专注战士',
      description: '单日学习 3 小时',
      type: 'speed',
      tier: 2,
      icon: '⚡',
      requirement: '单日学习 180 分钟',
      unlocked: false,
    },
    {
      id: 'daily-5hours',
      name: '学习狂人',
      description: '单日学习 5 小时',
      type: 'speed',
      tier: 3,
      icon: '🚀',
      requirement: '单日学习 300 分钟',
      unlocked: false,
    },

    // ===== 挑战成就 =====
    {
      id: 'cards-200',
      name: '积少成多',
      description: '卡片总数达到 200 张',
      type: 'milestone',
      tier: 2,
      icon: '🗂️',
      requirement: '总卡片数达到 200 张',
      unlocked: false,
    },
    {
      id: 'challenge-all-round',
      name: '全能学者',
      description: '单周完成笔记、复习、做题三项任务',
      type: 'challenge',
      tier: 3,
      icon: '🌟',
      requirement: '一周内笔记 + 复习 + 做题',
      unlocked: false,
    },
  ];
}

/**
 * 评估单个成就是否解锁
 */
function evaluateAchievement(
  achievement: Achievement,
  stats: LearningStats
): { unlocked: boolean; progress?: { current: number; target: number } } {
  switch (achievement.id) {
    // 连续学习
    case 'streak-3':
      return evaluate(stats.streakDays, 3);
    case 'streak-7':
      return evaluate(stats.streakDays, 7);
    case 'streak-30':
      return evaluate(stats.streakDays, 30);
    case 'streak-100':
      return evaluate(stats.streakDays, 100);
    case 'streak-365':
      return evaluate(stats.streakDays, 365);

    // 笔记里程碑
    case 'notes-10':
      return evaluate(stats.totalNotes, 10);
    case 'notes-50':
      return evaluate(stats.totalNotes, 50);
    case 'notes-100':
      return evaluate(stats.totalNotes, 100);

    // 复习里程碑
    case 'reviews-100':
      return evaluate(stats.reviewCount, 100);
    case 'reviews-500':
      return evaluate(stats.reviewCount, 500);

    // 做题里程碑
    case 'quizzes-100':
      return evaluate(stats.totalQuizzes, 100);
    case 'quizzes-500':
      return evaluate(stats.totalQuizzes, 500);
    case 'quizzes-1000':
      return evaluate(stats.totalQuizzes, 1000);

    // 掌握度
    case 'review-mastery-100':
      return evaluate(stats.masteredCards, 100);
    case 'quiz-accuracy-80':
      return evaluateWithMinimum(stats.quizAccuracy, 0.8, stats.totalQuizzes, 100);
    case 'quiz-mastery-90':
      return evaluateWithMinimum(stats.quizAccuracy, 0.9, stats.totalQuizzes, 100);
    case 'perfect-cards-50':
      return evaluate(stats.perfectCards, 50);

    // 速度
    case 'daily-3hours':
      return evaluate(stats.maxDailyMinutes, 180);
    case 'daily-5hours':
      return evaluate(stats.maxDailyMinutes, 300);

    // 挑战成就
    case 'cards-200':
      return evaluate(stats.totalCards, 200);
    case 'challenge-all-round':
      return {
        unlocked:
          stats.totalNotes > 0 && stats.reviewCount > 0 && stats.totalQuizzes > 0,
      };

    default:
      return { unlocked: false };
  }
}

/**
 * 简单评估：当前值 >= 目标值
 */
function evaluate(
  current: number,
  target: number
): { unlocked: boolean; progress?: { current: number; target: number } } {
  return {
    unlocked: current >= target,
    progress: { current, target },
  };
}

/**
 * 带最小样本量的评估（用于正确率类成就）
 */
function evaluateWithMinimum(
  value: number,
  target: number,
  count: number,
  minCount: number
): { unlocked: boolean; progress?: { current: number; target: number } } {
  if (count < minCount) {
    return {
      unlocked: false,
      progress: { current: count, target: minCount },
    };
  }

  return {
    unlocked: value >= target,
    progress: { current: Math.round(value * 100), target: Math.round(target * 100) },
  };
}

/**
 * 获取用户成就统计
 */
export function getAchievementSummary(achievements: Achievement[]): {
  totalUnlocked: number;
  totalAchievements: number;
  unlockedByTier: Record<number, number>;
  recentUnlocked: Achievement[];
} {
  const unlocked = achievements.filter((a) => a.unlocked);

  const unlockedByTier: Record<number, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };

  for (const achievement of unlocked) {
    unlockedByTier[achievement.tier]++;
  }

  // 最近解锁（按时间倒序）
  const recentUnlocked = unlocked
    .filter((a) => a.unlockedAt)
    .sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0))
    .slice(0, 5);

  return {
    totalUnlocked: unlocked.length,
    totalAchievements: achievements.length,
    unlockedByTier,
    recentUnlocked,
  };
}

/**
 * 获取接近解锁的成就（进度 >= 80%）
 */
export function getNearbyAchievements(achievements: Achievement[]): Achievement[] {
  return achievements
    .filter((a) => !a.unlocked && a.progress)
    .filter((a) => {
      const progress = a.progress!;
      return progress.current / progress.target >= 0.8;
    })
    .sort((a, b) => {
      const progressA = a.progress!.current / a.progress!.target;
      const progressB = b.progress!.current / b.progress!.target;
      return progressB - progressA;
    });
}
