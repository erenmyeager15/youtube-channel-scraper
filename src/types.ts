export interface ProxyConfig {
  useApifyProxy?: boolean;
  apifyProxyGroups?: string[];
  apifyProxyCountry?: string;
  proxyUrls?: string[];
}

export type ScrapeMode = 'fast' | 'detailed';

export interface ActorInput {
  channelUrls?: string[];
  searchKeywords?: string[];
  mode?: ScrapeMode;
  maxChannels?: number;
  maxVideosPerChannel?: number;
  maxDetailedVideosPerChannel?: number;
  includeShorts?: boolean;
  proxyConfiguration?: ProxyConfig;
}

export interface ChannelRecord {
  channelUrl: string;
  channelName: string | null;
  handle: string | null;
  subscriberCount: string | null;
  subscriberCountNumber: number | null;
  totalViews: string | null;
  totalViewsNumber: number | null;
  totalVideoCount: string | null;
  totalVideoCountNumber: number | null;
  joinDate: string | null;
  country: string | null;
  channelDescription: string | null;
  avatarImageUrl: string | null;
  bannerImageUrl: string | null;
  channelCategory: string | null;
  isVerified: boolean;
  socialLinks: string[];
  scrapedAt: string;
}

export interface VideoRecord {
  channelUrl: string;
  channelName: string | null;
  videoUrl: string;
  videoTitle: string | null;
  viewCount: string | null;
  viewCountNumber: number | null;
  likeCount: string | null;
  likeCountNumber: number | null;
  commentCount: string | null;
  commentCountNumber: number | null;
  durationSeconds: number | null;
  durationFormatted: string | null;
  publishedDate: string | null;
  thumbnailUrl: string | null;
  videoDescription: string | null;
  tags: string[];
  category: string | null;
  isShorts: boolean;
  scrapedAt: string;
}
