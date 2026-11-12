export type GameKey = 'shake' | 'redpacket' | 'quiz' | 'lottery';
export type ViewKey = 'lobby' | GameKey;
export type EligibilityPolicy =
  | 'independent'
  | 'exclude_game_winners_from_lottery'
  | 'one_prize_per_person';

export interface Participant {
  id: number;
  employeeNo: string;
  name: string;
  department: string;
  status: 'active' | 'pending' | 'excluded' | 'absent';
  source: 'roster' | 'self';
  createdAt: number;
}

export interface LeaderboardEntry {
  participantId: number;
  name: string;
  department: string;
  score: number;
  rank: number;
}

export interface LotteryPrize {
  name: string;
  count: number;
  each: number;
  image?: string;
}

export interface ShakeSettings {
  durationSec: number;
  winners: number;
  prizeName: string;
}

export interface RedPacketSettings {
  durationSec: number;
  mode: 'random' | 'fixed';
  budgetFen: number;
  packetCount: number;
  fixedFen: number;
  minFen: number;
  maxFen: number;
  maxClaims: number;
  prizeName: string;
}

export interface QuizSettings {
  winners: number;
  basePoints: number;
  speedBonusMax: number;
  prizeName: string;
}

export interface EventSettings {
  eventName: string;
  company: string;
  joinCode: string;
  joinMode: 'roster' | 'self' | 'hybrid';
  allowSelfRegistration: boolean;
  requireSelfApproval: boolean;
  eligibilityPolicy: EligibilityPolicy;
  displayNameMode: 'masked' | 'full';
  drawVisualCards: number;
  shake: ShakeSettings;
  redpacket: RedPacketSettings;
  quiz: QuizSettings;
  lotteryPrizes: LotteryPrize[];
}

export interface Question {
  id: number;
  sort: number;
  text: string;
  options: string[];
  correctOption: number;
  durationSec: number;
  points: number;
}

export interface PublicQuestion {
  id: number;
  index: number;
  total: number;
  text: string;
  options: string[];
  durationSec: number;
  endsAt: number;
  correctOption?: number;
}

export interface Winner {
  resultId: number;
  participantId: number;
  name: string;
  department: string;
  prizeName: string;
  rank: number;
  amountFen?: number;
}

export interface ShakeSnapshot {
  phase: 'idle' | 'running' | 'finished';
  startsAt?: number;
  endsAt?: number;
  durationSec: number;
  participantCount: number;
  top: LeaderboardEntry[];
  winners: Winner[];
}

export interface RedPacketRecent {
  name: string;
  amountFen: number;
  at: number;
}

export interface RedPacketSnapshot {
  phase: 'idle' | 'running' | 'finished';
  startsAt?: number;
  endsAt?: number;
  durationSec: number;
  packetCount: number;
  claimedCount: number;
  claimedAmountFen: number;
  maxClaims: number;
  recent: RedPacketRecent[];
}

export interface QuizSnapshot {
  phase: 'idle' | 'question' | 'locked' | 'revealed' | 'finished';
  startsAt?: number;
  endsAt?: number;
  question?: PublicQuestion;
  answeredCount: number;
  correctCount?: number;
  distribution?: number[];
  top: LeaderboardEntry[];
  winners: Winner[];
}

export interface LotterySnapshot {
  phase: 'idle' | 'ready' | 'drawing' | 'result';
  prizes: LotteryPrize[];
  remaining: number[];
  eligibleCount: number;
  visualNames: string[];
  lastDraw?: {
    drawId: string;
    prizeIndex: number;
    prizeName: string;
    winners: Winner[];
    at: number;
  };
}

export interface LiveSnapshot {
  now: number;
  view: ViewKey;
  eventName: string;
  company: string;
  publicOrigin: string;
  join: {
    joinMode: EventSettings['joinMode'];
    allowSelfRegistration: boolean;
    requireSelfApproval: boolean;
    joinCodeRequired: boolean;
    joinCode: string;
    participantCount: number;
    activeCount: number;
    pendingCount: number;
  };
  shake: ShakeSnapshot;
  redpacket: RedPacketSnapshot;
  quiz: QuizSnapshot;
  lottery: LotterySnapshot;
  displayNameMode: EventSettings['displayNameMode'];
}

export interface PlayerSummary {
  participant: Participant;
  view: ViewKey;
  shake: {
    score: number;
    rank: number | null;
    phase: ShakeSnapshot['phase'];
  };
  redpacket: {
    claimedCount: number;
    totalFen: number;
    claims: Array<{
      amountFen: number;
      claimCode: string;
      createdAt: number;
      redeemedAt: number | null;
    }>;
  };
  quiz: {
    score: number;
    rank: number | null;
    answer?: {
      questionId: number;
      optionIndex: number;
      correct: boolean;
      score: number;
    };
  };
  lottery: {
    won: boolean;
    results: Winner[];
  };
}

export interface AdminOverview {
  snapshot: LiveSnapshot;
  settings: EventSettings;
  questions: Question[];
  stats: {
    participants: number;
    active: number;
    pending: number;
    completedGames: number;
    totalClaims: number;
    totalClaimedFen: number;
  };
  recentResults: Array<{
    id: number;
    game: GameKey;
    name: string;
    employeeNo: string;
    prizeName: string;
    rank: number;
    amountFen: number | null;
    createdAt: number;
    voided: boolean;
  }>;
}

export interface AdminClaimRow {
  id: number;
  employeeNo: string;
  name: string;
  department: string;
  amountFen: number;
  claimCode: string;
  createdAt: number;
  redeemedAt: number | null;
}

export interface JoinRequest {
  employeeNo: string;
  name: string;
  department?: string;
  joinCode?: string;
}

export interface JoinResponse {
  participant: Participant;
  pending: boolean;
}

export interface ClaimResponse {
  ok: boolean;
  reason?: 'closed' | 'empty' | 'limit' | 'rate' | 'duplicate';
  amountFen?: number;
  claimCode?: string;
  claimedCount?: number;
  maxClaims?: number;
}

export interface ShakeAck {
  ok: boolean;
  score?: number;
  rank?: number | null;
  reason?: 'closed' | 'rate' | 'invalid';
}
