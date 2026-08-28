import type { ProxyConfigurationOptions } from 'apify';

import type { ActorInput, ScrapeMode } from './types.js';

export const MAX_CHANNELS_PER_RUN = 50;
export const MAX_DETAILED_CHANNELS_PER_RUN = 10;
export const MAX_SEARCH_KEYWORDS = 10;
export const MAX_CHANNELS_PER_SEARCH = 50;
export const MAX_VIDEOS_PER_CHANNEL = 100;
export const MAX_DETAILED_VIDEOS_PER_CHANNEL = 5;
export const MAX_SHORTS_PER_CHANNEL = 50;
export const MAX_LIVE_STREAMS_PER_CHANNEL = 50;
export const MAX_PLAYLISTS_PER_CHANNEL = 50;
export const MAX_COMMUNITY_POSTS_PER_CHANNEL = 50;

type ActorProxyOptions = ProxyConfigurationOptions & { useApifyProxy?: boolean };

export interface NormalizedActorInput {
  channelUrls: string[];
  searchKeywords: string[];
  mode: ScrapeMode;
  maxChannels: number;
  maxVideosPerChannel: number;
  maxDetailedVideosPerChannel: number;
  includeShorts: boolean;
  maxShortsPerChannel: number;
  includeLiveStreams: boolean;
  maxLiveStreamsPerChannel: number;
  includePlaylists: boolean;
  maxPlaylistsPerChannel: number;
  includeCommunityPosts: boolean;
  maxCommunityPostsPerChannel: number;
  proxyOptions: ActorProxyOptions | undefined;
  maxRequestsPerCrawl: number;
}

export function normalizeActorInput(input: ActorInput): NormalizedActorInput {
  const channelInputs = cleanStringArray(input.channelUrls, 'channelUrls');
  const searchKeywords = cleanStringArray(input.searchKeywords, 'searchKeywords');

  if (channelInputs.length > MAX_CHANNELS_PER_RUN) {
    throw new Error(`channelUrls accepts at most ${MAX_CHANNELS_PER_RUN} entries per run.`);
  }
  if (searchKeywords.length > MAX_SEARCH_KEYWORDS) {
    throw new Error(`searchKeywords accepts at most ${MAX_SEARCH_KEYWORDS} entries per run.`);
  }

  const mode = input.mode ?? 'fast';
  if (mode !== 'fast' && mode !== 'detailed') {
    throw new Error('mode must be either "fast" or "detailed".');
  }
  if (mode === 'detailed' && channelInputs.length > MAX_DETAILED_CHANNELS_PER_RUN) {
    throw new Error(
      `Detailed mode accepts at most ${MAX_DETAILED_CHANNELS_PER_RUN} direct channel URLs per run.`,
    );
  }

  const channelUrls = [...new Set(channelInputs.map(normalizeYouTubeChannelUrl))];
  const maxChannels = readBoundedInteger(
    input.maxChannels,
    1,
    MAX_CHANNELS_PER_SEARCH,
    1,
    'maxChannels',
  );
  if (mode === 'detailed' && maxChannels > MAX_DETAILED_CHANNELS_PER_RUN) {
    throw new Error(
      `maxChannels cannot exceed ${MAX_DETAILED_CHANNELS_PER_RUN} in detailed mode.`,
    );
  }
  const maxVideosPerChannel = readBoundedInteger(
    input.maxVideosPerChannel,
    1,
    MAX_VIDEOS_PER_CHANNEL,
    1,
    'maxVideosPerChannel',
  );
  const maxDetailedVideosPerChannel = readBoundedInteger(
    input.maxDetailedVideosPerChannel,
    0,
    MAX_DETAILED_VIDEOS_PER_CHANNEL,
    1,
    'maxDetailedVideosPerChannel',
  );
  if (input.includeShorts !== undefined && typeof input.includeShorts !== 'boolean') {
    throw new Error('includeShorts must be a boolean.');
  }
  for (const [fieldName, value] of [
    ['includeLiveStreams', input.includeLiveStreams],
    ['includePlaylists', input.includePlaylists],
    ['includeCommunityPosts', input.includeCommunityPosts],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${fieldName} must be a boolean.`);
    }
  }
  const maxShortsPerChannel = readBoundedInteger(
    input.maxShortsPerChannel, 1, MAX_SHORTS_PER_CHANNEL, 10, 'maxShortsPerChannel',
  );
  const maxLiveStreamsPerChannel = readBoundedInteger(
    input.maxLiveStreamsPerChannel, 1, MAX_LIVE_STREAMS_PER_CHANNEL, 10, 'maxLiveStreamsPerChannel',
  );
  const maxPlaylistsPerChannel = readBoundedInteger(
    input.maxPlaylistsPerChannel, 1, MAX_PLAYLISTS_PER_CHANNEL, 10, 'maxPlaylistsPerChannel',
  );
  const maxCommunityPostsPerChannel = readBoundedInteger(
    input.maxCommunityPostsPerChannel, 1, MAX_COMMUNITY_POSTS_PER_CHANNEL, 10, 'maxCommunityPostsPerChannel',
  );

  if (channelUrls.length === 0 && searchKeywords.length === 0) {
    throw new Error('Provide at least one YouTube channel URL, @handle, or search keyword.');
  }

  return {
    channelUrls,
    searchKeywords,
    mode,
    maxChannels,
    maxVideosPerChannel,
    maxDetailedVideosPerChannel,
    includeShorts: input.includeShorts ?? false,
    maxShortsPerChannel,
    includeLiveStreams: input.includeLiveStreams ?? false,
    maxLiveStreamsPerChannel,
    includePlaylists: input.includePlaylists ?? false,
    maxPlaylistsPerChannel,
    includeCommunityPosts: input.includeCommunityPosts ?? false,
    maxCommunityPostsPerChannel,
    proxyOptions: buildProxyConfigurationOptions(input.proxyConfiguration),
    maxRequestsPerCrawl: (mode === 'detailed' ? MAX_DETAILED_CHANNELS_PER_RUN : MAX_CHANNELS_PER_RUN)
      + searchKeywords.length,
  };
}

export function normalizeYouTubeChannelUrl(rawValue: string): string {
  const raw = rawValue.trim();
  if (!raw) throw new Error('YouTube channel inputs cannot be empty.');

  let candidate = raw;
  if (candidate.startsWith('@')) candidate = `https://www.youtube.com/${candidate}`;
  else if (candidate.startsWith('/@')) candidate = `https://www.youtube.com${candidate}`;
  else if (/^(?:www\.|m\.)?youtube\.com\//i.test(candidate)) candidate = `https://${candidate}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid YouTube channel input "${rawValue}". Use a full channel URL or an @handle.`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    throw new Error(`Only youtube.com channel URLs are accepted, got "${rawValue}".`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Invalid YouTube channel URL "${rawValue}".`);
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`YouTube channel URL "${rawValue}" does not identify a channel.`);
  }

  let canonicalSegments: string[];
  if (segments[0].startsWith('@') && segments[0].length > 1) {
    canonicalSegments = [segments[0]];
  } else if (['channel', 'c', 'user'].includes(segments[0].toLowerCase()) && segments[1]) {
    canonicalSegments = [segments[0].toLowerCase(), segments[1]];
  } else {
    throw new Error(
      `Unsupported YouTube channel URL "${rawValue}". Use /@handle, /channel/ID, /c/name, or /user/name.`,
    );
  }

  return `https://www.youtube.com/${canonicalSegments.join('/')}`;
}

export function buildProxyConfigurationOptions(raw: ActorInput['proxyConfiguration']): ActorProxyOptions | undefined {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error('proxyConfiguration must be a proxy configuration object.');
  }

  const config = raw ?? {};
  if (config.useApifyProxy !== undefined && typeof config.useApifyProxy !== 'boolean') {
    throw new Error('proxyConfiguration.useApifyProxy must be a boolean.');
  }
  const proxyUrls = cleanStringArray(config.proxyUrls, 'proxyConfiguration.proxyUrls');
  const groups = cleanStringArray(config.apifyProxyGroups, 'proxyConfiguration.apifyProxyGroups');
  const country = cleanCountryCode(config.apifyProxyCountry);

  if (proxyUrls.length > 0) {
    if (config.useApifyProxy === true || groups.length > 0 || country) {
      throw new Error('proxyConfiguration cannot combine custom proxyUrls with Apify Proxy settings.');
    }
    return { proxyUrls };
  }

  if (config.useApifyProxy === false) {
    if (groups.length > 0 || country) {
      throw new Error('Apify Proxy groups or country cannot be used when useApifyProxy is false.');
    }
    return undefined;
  }

  if (config.useApifyProxy !== true && groups.length === 0 && !country) {
    return undefined;
  }

  return {
    useApifyProxy: true,
    ...(groups.length > 0 ? { apifyProxyGroups: groups } : {}),
    ...(country ? { apifyProxyCountry: country } : {}),
  };
}

function cleanStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of strings.`);
  if (value.some((item) => typeof item !== 'string')) {
    throw new Error(`${fieldName} must contain only strings.`);
  }

  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function cleanCountryCode(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-zA-Z]{2}$/.test(value.trim())) {
    throw new Error('proxyConfiguration.apifyProxyCountry must be a two-letter country code.');
  }
  return value.trim().toUpperCase();
}

function readBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
  fieldName: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || Number(resolved) < minimum || Number(resolved) > maximum) {
    throw new Error(`${fieldName} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(resolved);
}
