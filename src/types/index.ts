/** Supported intent actions for the protocol */
export type IntentAction =
  | "swap"
  | "stake"
  | "lend"
  | "borrow"
  | "transfer"
  | "vote"
  | "mint"
  | "burn"
  | "tweet"
  | "custom";

/** Completion status for protocol completions */
export enum CompletionStatus {
  AwaitingSignature = "awaiting_signature",
  Submitted = "submitted",
  Verified = "verified",
  Rejected = "rejected",
  Expired = "expired",
}

/** Types of point events */
export enum PointEventType {
  Awarded = "awarded",
  Bonus = "bonus",
  Penalty = "penalty",
  Refund = "refund",
  Transfer = "transfer",
  Reservation = "reservation",
  Release = "release",
}

/** Protocol status */
export enum ProtocolStatus {
  Pending = "pending",
  Active = "active",
  Suspended = "suspended",
  Revoked = "revoked",
}

/** Campaign status */
export enum CampaignStatus {
  Active = "active",
  Paused = "paused",
  Completed = "completed",
  Cancelled = "cancelled",
}

/** Quest types */
export enum QuestType {
  Single = "single",
  Composable = "composable",
  Recurring = "recurring",
}

/** Subscription frequency */
export enum SubscriptionFrequency {
  Daily = "daily",
  Weekly = "weekly",
  Monthly = "monthly",
}

/** Delegation trigger types */
export enum DelegationTriggerType {
  Schedule = "schedule",
  PriceThreshold = "price_threshold",
  Event = "event",
}

/** Tweet submission status */
export enum TweetSubmissionStatus {
  Pending = "pending",
  Approved = "approved",
  Rejected = "rejected",
}

/** Leaderboard snapshot type */
export enum LeaderboardSnapshotType {
  User = "user",
  Protocol = "protocol",
}

/** Marketing spend type */
export enum MarketingSpendType {
  Points = "points",
  Tokens = "tokens",
  SOL = "sol",
}

/** Base user record */
export interface User {
  wallet_address: string;
  total_points: bigint;
  synced_points: bigint;
  updated_at: Date;
}

/** User balance record */
export interface UserBalance {
  wallet_address: string;
  total_earned: bigint;
  total_pending: bigint;
  total_spent: bigint;
  total_reserved: bigint;
  usable_balance: bigint;
  updated_at: Date;
}

/** Protocol record */
export interface Protocol {
  id: string;
  admin_wallet: string;
  name: string;
  description: string | null;
  blink_base_url: string | null;
  supported_actions: string[];
  trust_score: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** Campaign record */
export interface Campaign {
  campaign_id: string;
  protocol_id: string;
  name: string;
  description: string | null;
  action_type: string;
  points_per_completion: number;
  max_per_user_per_day: number;
  budget_total: bigint | null;
  budget_spent: bigint;
  status: string;
  start_at: Date;
  end_at: Date | null;
  created_at: Date;
}

/** Point event record */
export interface PointEvent {
  id: string;
  user_wallet: string;
  protocol_id: string | null;
  type: PointEventType;
  amount: bigint;
  completion_id: string | null;
  source_signature: string | null;
  source_reference: string | null;
  reason: string | null;
  created_at: Date;
}
