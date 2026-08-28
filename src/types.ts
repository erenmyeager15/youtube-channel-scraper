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
  maxShortsPerChannel?: number;
  includeLiveStreams?: boolean;
  maxLiveStreamsPerChannel?: number;
  includePlaylists?: boolean;
  maxPlaylistsPerChannel?: number;
  includeCommunityPosts?: boolean;
  maxCommunityPostsPerChannel?: number;
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
  recordType: 'channel';
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
  recordType: 'video';
  contentType: 'video' | 'short' | 'live_stream';
  videoId: string;
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
  liveStatus: 'live' | 'upcoming' | 'streamed' | null;
  scrapedAt: string;
}

export interface PlaylistRecord {
  recordType: 'playlist';
  channelUrl: string;
  channelName: string | null;
  playlistId: string;
  playlistUrl: string;
  playlistTitle: string | null;
  videoCount: string | null;
  videoCountNumber: number | null;
  thumbnailUrl: string | null;
  scrapedAt: string;
}

export interface CommunityPostRecord {
  recordType: 'community_post';
  channelUrl: string;
  channelName: string | null;
  postId: string;
  postUrl: string;
  postText: string | null;
  publishedDate: string | null;
  likeCount: string | null;
  likeCountNumber: number | null;
  commentCount: string | null;
  commentCountNumber: number | null;
  attachmentType: 'image' | 'video' | 'playlist' | 'poll' | 'none';
  attachmentUrl: string | null;
  imageUrl: string | null;
  scrapedAt: string;
}
