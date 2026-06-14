export type ExtractionStatus = "ok" | "partial" | "failed";

export interface PostStats {
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
}

export interface DiscoveredPost {
  postUrl: string;
  activityUrn: string | null;
  analyticsUrl: string | null;
  postedAtText: string | null;
  textPreview: string | null;
  seedStats?: Partial<PostStats>;
}

export interface CollectedPost extends DiscoveredPost {
  stats: PostStats;
  status: ExtractionStatus;
  error?: string;
}

export interface CollectionOutput {
  collectedAt: string;
  source: "linkedin-profile-activity";
  windowDays: number;
  posts: CollectedPost[];
}
