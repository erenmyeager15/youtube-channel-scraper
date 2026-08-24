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

export type ExternalLinkPlatform =
  | 'website'
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'x'
  | 'youtube'
  | 'tiktok'
  | 'reddit'
  | 'twitch'
  | 'threads'
  | 'discord';

export interface ChannelExternalLink {
  title: string | null;
  url: string;
  platform: ExternalLinkPlatform;
}

export interface SocialProfiles {
  facebook: string[];
  instagram: string[];
  linkedin: string[];
  x: string[];
  youtube: string[];
  tiktok: string[];
  reddit: string[];
  twitch: string[];
  threads: string[];
  discord: string[];
}

export interface ChannelRecord {
  channelUrl: string;
  channelId: string | null;
  canonicalChannelUrl: string;
  videosUrl: string;
  shortsUrl: string;
  liveStreamsUrl: string;
  playlistsUrl: string;
  communityUrl: string;
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
  socialProfiles: SocialProfiles;
  websiteLinks: string[];
  externalLinks: ChannelExternalLink[];
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
