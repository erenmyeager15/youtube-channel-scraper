import type { ProxyConfiguration } from 'apify';
import { gotScraping } from 'crawlee';

import { classifyYouTubeDocument } from './youtube-utils.js';

type JsonObject = Record<string, any>;

export interface YouTubePage {
  initialData: JsonObject;
  html: string;
  finalUrl: string;
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
