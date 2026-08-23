import type { ProxyConfiguration } from 'apify';
import { gotScraping } from 'crawlee';

import { classifyYouTubeDocument } from './youtube-utils.js';

type JsonObject = Record<string, any>;

export interface YouTubePage {
  initialData: JsonObject;
  html: string;
  finalUrl: string;
}

export interface ChannelAboutMetadata {
  subscriberText: string | null;
  videoCountText: string | null;
  totalViewsText: string | null;
  joinDate: string | null;
  country: string | null;
  description: string | null;
  socialLinks: string[];
  canonicalUrl: string | null;
}

export interface VideoDetailMetadata {
  title: string | null;
  viewCount: string | null;
  likeCount: string | null;
  likeCountNumber: number | null;
  commentCount: string | null;
  commentCountNumber: number | null;
  durationSeconds: number | null;
  publishedDate: string | null;
  thumbnailUrl: string | null;
  description: string | null;
  tags: string[];
  category: string | null;
}

export interface YouTubePlayerApiConfig {
  apiKey: string;
  clientVersion: string;
}

const REQUEST_HEADERS = {
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  cookie: 'SOCS=CAI',
};

export async function fetchYouTubePage(
  url: string,
  proxyConfiguration?: ProxyConfiguration,
  maximumAttempts = 4,
): Promise<YouTubePage> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const proxyUrl = proxyConfiguration
        ? await proxyConfiguration.newUrl(`youtube-http-${attempt}-${Date.now()}`)
        : undefined;
      const response = await gotScraping({
        url,
        proxyUrl,
        headers: REQUEST_HEADERS,
        timeout: { request: 30_000 },
        retry: { limit: 0 },
        throwHttpErrors: false,
        followRedirect: true,
      });

      const html = String(response.body);
      const title = readHtmlTitle(html);
      const state = classifyYouTubeDocument(title, stripMarkup(html).slice(0, 80_000), false);

      if (response.statusCode >= 400) throw new Error(`YouTube returned HTTP ${response.statusCode}`);
      if (state === 'blocked') throw new Error('YouTube blocked the request');
      if (state === 'unavailable') throw new Error('YouTube page is unavailable');

      return {
        initialData: extractInitialData(html),
        html,
        finalUrl: response.url,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maximumAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }

  throw new Error(`YouTube request failed after ${maximumAttempts} attempts: ${lastError?.message ?? 'unknown error'}`);
}

export async function fetchYouTubePlayerData(
  videoId: string,
  sourceHtml: string,
  proxyConfiguration?: ProxyConfiguration,
  maximumAttempts = 3,
): Promise<JsonObject> {
  const config = extractPlayerApiConfig(sourceHtml);
  if (!config) throw new Error('YouTube public player API configuration was not found');

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const proxyUrl = proxyConfiguration
        ? await proxyConfiguration.newUrl(`youtube-player-${attempt}-${Date.now()}`)
        : undefined;
      const response = await gotScraping({
        url: `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(config.apiKey)}`,
        method: 'POST',
        proxyUrl,
        headers: {
          ...REQUEST_HEADERS,
          'content-type': 'application/json',
          origin: 'https://www.youtube.com',
          'x-youtube-client-name': '1',
          'x-youtube-client-version': config.clientVersion,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: config.clientVersion,
              hl: 'en',
              gl: 'US',
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        timeout: { request: 30_000 },
        retry: { limit: 0 },
        throwHttpErrors: false,
      });

      if (response.statusCode >= 400) throw new Error(`YouTube player API returned HTTP ${response.statusCode}`);
      const data = JSON.parse(String(response.body)) as JsonObject;
      if (!data.videoDetails && !data.microformat?.playerMicroformatRenderer) {
        throw new Error('YouTube player API returned no public video metadata');
      }
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maximumAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }

  throw new Error(
    `YouTube player metadata request failed after ${maximumAttempts} attempts: `
    + `${lastError?.message || lastError?.name || 'unknown error'}`,
  );
}

export function extractPlayerApiConfig(html: string): YouTubePlayerApiConfig | null {
  const apiKey = extractJsonStringSetting(html, 'INNERTUBE_API_KEY');
  const clientVersion = extractJsonStringSetting(html, 'INNERTUBE_CLIENT_VERSION');
  return apiKey && clientVersion ? { apiKey, clientVersion } : null;
}

export function extractInitialData(html: string): JsonObject {
  const markers = ['var ytInitialData =', 'window["ytInitialData"] =', 'ytInitialData ='];

  for (const marker of markers) {
    let markerIndex = html.indexOf(marker);
    while (markerIndex >= 0) {
      const objectStart = html.indexOf('{', markerIndex + marker.length);
      if (objectStart < 0) break;
      const objectEnd = findJsonObjectEnd(html, objectStart);
      if (objectEnd > objectStart) {
        try {
          return JSON.parse(html.slice(objectStart, objectEnd + 1)) as JsonObject;
        } catch {
          // Another marker occurrence may contain the serialized page payload.
        }
      }
      markerIndex = html.indexOf(marker, markerIndex + marker.length);
    }
  }

  throw new Error('YouTube initial page data was not found');
}

export function extractChannelMetadata(initialData: JsonObject) {
  const metadata = initialData?.metadata?.channelMetadataRenderer ?? {};
  const legacyHeader = initialData?.header?.c4TabbedHeaderRenderer ?? {};
  const pageHeader = initialData?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel ?? {};

  const title: string | null = metadata.title ?? legacyHeader.title ?? null;
  const description: string | null = metadata.description ?? null;
  const handle: string | null = legacyHeader.channelHandleText?.runs?.[0]?.text
    ?? (metadata.vanityChannelUrl ? `@${String(metadata.vanityChannelUrl).split('/@')[1] ?? ''}` : null);

  const avatars = metadata.avatar?.thumbnails ?? legacyHeader.avatar?.thumbnails ?? [];
  const banners = legacyHeader.banner?.thumbnails ?? [];
  let subscriberText: string | null = legacyHeader.subscriberCountText?.simpleText ?? null;
  let videoCountText: string | null = legacyHeader.videosCountText?.runs
    ?.map((run: JsonObject) => run.text)
    .join('') ?? null;

  if (!subscriberText || !videoCountText) {
    const rows = pageHeader?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
    for (const row of rows) {
      for (const part of row.metadataParts ?? []) {
        const text: string = part.text?.content ?? '';
        if (/subscriber/i.test(text) && !subscriberText) subscriberText = text;
        else if (/video/i.test(text) && !videoCountText) videoCountText = text;
      }
    }
  }

  const badgeText = `${JSON.stringify(legacyHeader.badges ?? [])}${JSON.stringify(pageHeader?.title ?? '')}`;
  const externalId: string | null = metadata.externalId ?? legacyHeader.channelId ?? null;

  return {
    title,
    description,
    handle,
    avatarUrl: avatars.length ? avatars[avatars.length - 1].url as string : null,
    bannerUrl: banners.length ? banners[banners.length - 1].url as string : null,
    subscriberText,
    videoCountText,
    isVerified: /verified|official artist/i.test(badgeText),
    externalId,
    canonicalUrl: metadata.channelUrl
      ?? (externalId ? `https://www.youtube.com/channel/${externalId}` : null),
  };
}

export function extractChannelAbout(initialData: JsonObject): ChannelAboutMetadata | null {
  let aboutView: JsonObject | null = null;
  walkObjects(initialData, (object) => {
    const candidate = object.aboutChannelViewModel ?? object.channelAboutFullMetadataRenderer;
    if (candidate && typeof candidate === 'object') aboutView = candidate;
  }, () => aboutView !== null);

  if (!aboutView) return null;
  const about = aboutView as JsonObject;
  const links = Array.isArray(about.links) ? about.links : Array.isArray(about.primaryLinks) ? about.primaryLinks : [];
  const socialLinks = [...new Set(links
    .map((item: JsonObject) => {
      const linkView = item?.channelExternalLinkViewModel ?? item;
      return normalizeExternalUrl(
        textContent(linkView?.link),
        findFirstHttpUrl(linkView?.link ?? linkView),
      );
    })
    .filter((value: string | null): value is string => value !== null))];

  const joinedText = textContent(about.joinedDateText);
  return {
    subscriberText: textContent(about.subscriberCountText),
    videoCountText: textContent(about.videoCountText),
    totalViewsText: textContent(about.viewCountText),
    joinDate: joinedText?.replace(/^joined\s+/i, '') ?? null,
    country: textContent(about.country),
    description: textContent(about.description),
    socialLinks,
    canonicalUrl: typeof about.canonicalChannelUrl === 'string' ? about.canonicalChannelUrl : null,
  };
}

export function extractPlayerResponse(html: string): JsonObject {
  const markers = [
    'var ytInitialPlayerResponse =',
    'var ytInitialPlayerResponse=',
    'window["ytInitialPlayerResponse"] =',
    'window["ytInitialPlayerResponse"]=',
    'ytInitialPlayerResponse =',
    'ytInitialPlayerResponse=',
    '"ytInitialPlayerResponse":',
  ];
  let bestResponse: JsonObject | null = null;
  let bestScore = -1;

  for (const marker of markers) {
    let markerIndex = html.indexOf(marker);
    while (markerIndex >= 0) {
      const objectStart = html.indexOf('{', markerIndex + marker.length);
      if (objectStart < 0) break;
      const objectEnd = findJsonObjectEnd(html, objectStart);
      if (objectEnd > objectStart) {
        try {
          const candidate = JSON.parse(html.slice(objectStart, objectEnd + 1)) as JsonObject;
          const score = scorePlayerResponse(candidate);
          if (score > bestScore) {
            bestResponse = candidate;
            bestScore = score;
          }
        } catch {
          // Another marker occurrence may contain the serialized player payload.
        }
      }
      markerIndex = html.indexOf(marker, markerIndex + marker.length);
    }
  }

  if (bestResponse) return bestResponse;
  throw new Error('YouTube player response was not found');
}

export function extractVideoDetails(
  initialData: JsonObject,
  html: string,
  suppliedPlayerResponse?: JsonObject,
): VideoDetailMetadata {
  let playerResponse: JsonObject = suppliedPlayerResponse ?? {};
  if (!suppliedPlayerResponse) {
    try {
      playerResponse = extractPlayerResponse(html);
    } catch {
      // Some video pages still expose useful engagement fields in ytInitialData.
    }
  }

  let primaryInfo: JsonObject | null = null;
  let secondaryInfo: JsonObject | null = null;
  let likeEntity: JsonObject | null = null;
  let commentsHeader: JsonObject | null = null;
  walkObjects(initialData, (object) => {
    if (!primaryInfo && object.videoPrimaryInfoRenderer) primaryInfo = object.videoPrimaryInfoRenderer;
    if (!secondaryInfo && object.videoSecondaryInfoRenderer) secondaryInfo = object.videoSecondaryInfoRenderer;
    if (!likeEntity && object.likeCountEntity) likeEntity = object.likeCountEntity;
    if (!commentsHeader && object.commentsHeaderRenderer) commentsHeader = object.commentsHeaderRenderer;
  });

  const primary = primaryInfo as JsonObject | null;
  const secondary = secondaryInfo as JsonObject | null;
  const likes = likeEntity as JsonObject | null;
  const comments = commentsHeader as JsonObject | null;
  const embeddedVideoDetails = extractBestEmbeddedObject(html, '"videoDetails":', scoreVideoDetails) ?? {};
  const embeddedMicroformat = extractBestEmbeddedObject(
    html,
    '"playerMicroformatRenderer":',
    scoreMicroformat,
  ) ?? {};
  const videoDetails = { ...embeddedVideoDetails, ...(playerResponse.videoDetails ?? {}) };
  const microformat = {
    ...embeddedMicroformat,
    ...(playerResponse.microformat?.playerMicroformatRenderer ?? {}),
  };
  const metaTitle = extractMetaContent(html, 'name', 'title');
  const metaDescription = extractMetaContent(html, 'name', 'description');
  const genericYouTubeTags = new Set(['video', 'sharing', 'camera phone', 'video phone', 'free', 'upload']);
  const metaKeywords = extractMetaContents(html, 'name', 'keywords')
    .map((value) => value.split(',').map((tag) => tag.trim()).filter(Boolean))
    .map((tags) => tags.filter((tag) => !genericYouTubeTags.has(tag.toLowerCase())))
    .filter((tags) => tags.length > 0)
    .sort((left, right) => right.length - left.length)[0] ?? [];
  const metaCategory = extractMetaContent(html, 'itemprop', 'genre')
    ?? extractMetaContent(html, 'name', 'genre');
  const metaPublishedDate = extractMetaContent(html, 'itemprop', 'datePublished')
    ?? extractMetaContent(html, 'itemprop', 'uploadDate')
    ?? extractMetaContent(html, 'property', 'article:published_time');
  const metaDurationSeconds = parseIsoDuration(extractMetaContent(html, 'itemprop', 'duration'));

  const playerViewCount = parseCountValue(videoDetails.viewCount ?? microformat.viewCount);
  const viewCount = textContent(primary?.viewCount?.videoViewCountRenderer?.originalViewCount)
    ?? (playerViewCount === null ? null : `${playerViewCount.toLocaleString('en-US')} views`);
  const likeCountNumber = parseCountValue(
    likes?.likeCountIfIndifferentNumber
      ?? microformat.likeCount
      ?? likes?.likeCountIfLikedNumber,
  );
  const likeCount = textContent(likes?.expandedLikeCountIfIndifferent)
    ?? textContent(likes?.likeCountIfIndifferent)
    ?? (likeCountNumber === null ? null : `${likeCountNumber.toLocaleString('en-US')} likes`);
  const rawCommentCount = textContent(comments?.countText)
    ?? textContent(comments?.commentsCount)
    ?? textContent(comments?.countTextViewModel);
  const commentCountNumber = rawCommentCount && /\d/.test(rawCommentCount)
    ? parseCountValue(rawCommentCount)
    : null;
  const thumbnails = videoDetails.thumbnail?.thumbnails ?? microformat.thumbnail?.thumbnails ?? [];
  const rawDuration = Number.parseInt(String(videoDetails.lengthSeconds ?? microformat.lengthSeconds ?? ''), 10);
  const keywordValues: unknown[] = Array.isArray(videoDetails.keywords) ? videoDetails.keywords : [];
  const tags = keywordValues.length
    ? [...new Set(keywordValues
      .filter((tag: unknown): tag is string => typeof tag === 'string')
      .map((tag: string) => tag.trim())
      .filter(Boolean))].slice(0, 100)
    : [...new Set(metaKeywords)].slice(0, 100);

  return {
    title: typeof videoDetails.title === 'string'
      ? videoDetails.title
      : textContent(microformat.title) ?? metaTitle,
    viewCount,
    likeCount,
    likeCountNumber,
    commentCount: commentCountNumber === null ? null : rawCommentCount,
    commentCountNumber,
    durationSeconds: Number.isSafeInteger(rawDuration) && rawDuration >= 0 ? rawDuration : metaDurationSeconds,
    publishedDate: typeof microformat.publishDate === 'string'
      ? microformat.publishDate
      : typeof microformat.uploadDate === 'string' ? microformat.uploadDate : metaPublishedDate,
    thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1]?.url ?? null : null,
    description: typeof videoDetails.shortDescription === 'string'
      ? videoDetails.shortDescription
      : textContent(secondary?.attributedDescription) ?? textContent(microformat.description) ?? metaDescription,
    tags,
    category: typeof microformat.category === 'string'
      ? microformat.category
      : textContent(microformat.category) ?? metaCategory,
  };
}

export function extractVideos(initialData: JsonObject) {
  const output: Array<{
    videoId: string;
    title: string | null;
    viewText: string | null;
    publishedText: string | null;
    lengthText: string | null;
    thumbnailUrl: string | null;
    navigationUrl: string | null;
  }> = [];
  const seen = new Set<string>();

  walkObjects(initialData, (object) => {
    const videoRenderer = object.videoRenderer;
    if (videoRenderer?.videoId && !seen.has(videoRenderer.videoId)) {
      seen.add(videoRenderer.videoId);
      const thumbnails = videoRenderer.thumbnail?.thumbnails ?? [];
      output.push({
        videoId: videoRenderer.videoId,
        title: videoRenderer.title?.runs?.[0]?.text ?? null,
        viewText: videoRenderer.viewCountText?.simpleText
          ?? videoRenderer.viewCountText?.runs?.map((run: JsonObject) => run.text).join('')
          ?? null,
        publishedText: videoRenderer.publishedTimeText?.simpleText ?? null,
        lengthText: videoRenderer.lengthText?.simpleText ?? null,
        thumbnailUrl: thumbnails.length ? thumbnails[thumbnails.length - 1].url : null,
        navigationUrl: findNavigationUrl(videoRenderer, videoRenderer.videoId),
      });
    }

    const lockup = object.lockupViewModel;
    if (lockup?.contentId && /VIDEO/i.test(lockup.contentType ?? '') && !seen.has(lockup.contentId)) {
      seen.add(lockup.contentId);
      const metadata = lockup.metadata?.lockupMetadataViewModel;
      const rows = metadata?.metadata?.contentMetadataViewModel?.metadataRows ?? [];
      let viewText: string | null = null;
      let publishedText: string | null = null;
      for (const row of rows) {
        for (const part of row.metadataParts ?? []) {
          const text: string = part.text?.content ?? '';
          if (/view/i.test(text) && !viewText) viewText = text;
          else if (/(ago|stream|premiere)/i.test(text) && !publishedText) publishedText = text;
        }
      }
      const thumbnailSources = lockup.contentImage?.thumbnailViewModel?.image?.sources ?? [];
      output.push({
        videoId: lockup.contentId,
        title: metadata?.title?.content ?? null,
        viewText,
        publishedText,
        lengthText: findText(lockup.contentImage, /^\d{1,2}:\d{2}(?::\d{2})?$/),
        thumbnailUrl: thumbnailSources.length ? thumbnailSources[thumbnailSources.length - 1].url : null,
        navigationUrl: findNavigationUrl(lockup, lockup.contentId),
      });
    }
  });

  return output;
}

export function extractSearchChannelUrls(initialData: JsonObject, maximum: number): string[] {
  const urls = new Set<string>();

  const addUrl = (rawUrl: unknown): void => {
    if (urls.size >= maximum || typeof rawUrl !== 'string') return;
    if (!/^\/(?:@|channel\/|c\/|user\/)/i.test(rawUrl)) return;
    urls.add(`https://www.youtube.com${rawUrl.split(/[?#]/)[0]}`);
  };

  walkObjects(initialData, (object) => {
    const channel = object.channelRenderer;
    if (channel) {
      addUrl(channel.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url);
      if (channel.channelId) addUrl(`/channel/${channel.channelId}`);
    }
  }, () => urls.size >= maximum);

  return [...urls].slice(0, maximum);
}

function walkObjects(
  value: unknown,
  visitor: (object: JsonObject) => void,
  stop = () => false,
): void {
  if (stop() || !value || typeof value !== 'object') return;
  visitor(value as JsonObject);
  if (stop()) return;
  for (const child of Object.values(value as JsonObject)) {
    walkObjects(child, visitor, stop);
    if (stop()) return;
  }
}

function findText(value: unknown, pattern: RegExp): string | null {
  let result: string | null = null;
  walkObjects(value, (object) => {
    if (result) return;
    if (typeof object.text === 'string' && pattern.test(object.text)) result = object.text;
    else if (typeof object.content === 'string' && pattern.test(object.content)) result = object.content;
  }, () => result !== null);
  return result;
}

function findNavigationUrl(value: unknown, videoId: string): string | null {
  let shortsUrl: string | null = null;
  let watchUrl: string | null = null;
  walkObjects(value, (object) => {
    for (const [key, child] of Object.entries(object)) {
      if (typeof child !== 'string' || !/url/i.test(key)) continue;
      if (child.includes(`/shorts/${videoId}`)) shortsUrl = child;
      else if (!watchUrl && child.includes(`/watch?v=${videoId}`)) watchUrl = child;
    }
  }, () => shortsUrl !== null);
  return shortsUrl ?? watchUrl;
}

function textContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    const combined = value.map(textContent).filter(Boolean).join('');
    return combined || null;
  }

  const object = value as JsonObject;
  for (const key of ['content', 'simpleText', 'text']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  if (Array.isArray(object.runs)) {
    const combined = object.runs.map((run: JsonObject) => textContent(run)).filter(Boolean).join('');
    if (combined) return combined;
  }
  return null;
}

function parseCountValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const text = textContent(value);
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  let number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number) || number < 0) return null;
  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'B') number *= 1_000_000_000;
  else if (suffix === 'M') number *= 1_000_000;
  else if (suffix === 'K') number *= 1_000;
  return Math.round(number);
}

function scorePlayerResponse(candidate: JsonObject): number {
  let score = 0;
  if (candidate.videoDetails) score += 4;
  if (candidate.microformat?.playerMicroformatRenderer) score += 4;
  if (Array.isArray(candidate.videoDetails?.keywords)) score += 2;
  if (candidate.videoDetails?.shortDescription) score += 1;
  return score;
}

function scoreVideoDetails(candidate: JsonObject): number {
  let score = 0;
  if (candidate.videoId) score += 2;
  if (candidate.title) score += 1;
  if (candidate.lengthSeconds) score += 1;
  if (candidate.shortDescription) score += 2;
  if (Array.isArray(candidate.keywords)) score += 2;
  return score;
}

function scoreMicroformat(candidate: JsonObject): number {
  let score = 0;
  if (candidate.publishDate || candidate.uploadDate) score += 2;
  if (candidate.category) score += 2;
  if (candidate.description) score += 1;
  if (candidate.lengthSeconds) score += 1;
  return score;
}

function extractBestEmbeddedObject(
  html: string,
  marker: string,
  score: (candidate: JsonObject) => number,
): JsonObject | null {
  let best: JsonObject | null = null;
  let bestScore = -1;
  let markerIndex = html.indexOf(marker);
  while (markerIndex >= 0) {
    const objectStart = html.indexOf('{', markerIndex + marker.length);
    if (objectStart < 0) break;
    const objectEnd = findJsonObjectEnd(html, objectStart);
    if (objectEnd > objectStart) {
      try {
        const candidate = JSON.parse(html.slice(objectStart, objectEnd + 1)) as JsonObject;
        const candidateScore = score(candidate);
        if (candidateScore > bestScore) {
          best = candidate;
          bestScore = candidateScore;
        }
      } catch {
        // The same marker can occur inside an escaped string; keep scanning.
      }
    }
    markerIndex = html.indexOf(marker, markerIndex + marker.length);
  }
  return best;
}

function extractMetaContent(html: string, attributeName: string, attributeValue: string): string | null {
  return extractMetaContents(html, attributeName, attributeValue).at(-1) ?? null;
}

function extractMetaContents(html: string, attributeName: string, attributeValue: string): string[] {
  const output: string[] = [];
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const identity = readHtmlAttribute(tag, attributeName);
    if (identity?.toLowerCase() !== attributeValue.toLowerCase()) continue;
    const content = readHtmlAttribute(tag, 'content');
    if (content) output.push(decodeHtmlEntities(content));
  }
  return output;
}

function readHtmlAttribute(tag: string, attributeName: string): string | null {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseIsoDuration(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  return Number.parseInt(match[1] ?? '0', 10) * 3600
    + Number.parseInt(match[2] ?? '0', 10) * 60
    + Number.parseInt(match[3] ?? '0', 10);
}

function extractJsonStringSetting(html: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function findFirstHttpUrl(value: unknown): string | null {
  let result: string | null = null;
  walkObjects(value, (object) => {
    for (const child of Object.values(object)) {
      if (typeof child === 'string' && /^(?:https?:\/\/|\/redirect\?)/i.test(child)) {
        result = child;
        return;
      }
    }
  }, () => result !== null);
  return result;
}

function normalizeExternalUrl(displayValue: string | null, endpointValue: string | null): string | null {
  for (const rawValue of [displayValue, endpointValue]) {
    if (!rawValue) continue;
    let candidate = rawValue.trim();
    try {
      const redirectUrl = new URL(candidate, 'https://www.youtube.com');
      if (/^(?:www\.)?youtube\.com$/i.test(redirectUrl.hostname) && redirectUrl.pathname === '/redirect') {
        candidate = redirectUrl.searchParams.get('q') ?? redirectUrl.searchParams.get('u') ?? '';
      }
      if (!candidate) continue;
      if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate.replace(/^\/+/, '')}`;
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      return parsed.toString();
    } catch {
      // Try the next available representation of the public link.
    }
  }
  return null;
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function readHtmlTitle(html: string): string {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
}

function stripMarkup(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}
