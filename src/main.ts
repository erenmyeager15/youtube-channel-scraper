import { Actor, log } from 'apify';

import { normalizeActorInput } from './run-config.js';
import { runYouTube, CHANNEL_SCRAPED_EVENT } from './runner.js';
import type { ActorInput } from './types.js';
import { fetchYouTubePage, fetchYouTubeContinuation } from './youtube-http.js';
import { createMetadataFallback } from './metadata-fallback.js';

await Actor.init();
try {
  const input = await Actor.getInput<ActorInput>() ?? {};
  const normalized = normalizeActorInput(input);
  const proxy = normalized.proxyOptions ? await Actor.createProxyConfiguration(normalized.proxyOptions) : undefined;
  const metadataFallback = createMetadataFallback({ enabled: normalized.metadataProxyFallback,
    primaryProxy: proxy,
    createResidentialProxy: () => Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] }),
  });
  await runYouTube(input, {
    fetchPage: (url, budget) => fetchYouTubePage(url, proxy, 4, budget),
    fetchPlayer: metadataFallback.fetchPlayer,
    fetchContinuation: (token, html, budget) => fetchYouTubeContinuation(token, html, proxy, budget),
    saveChannel: (channelRecord) => Actor.pushData(channelRecord, CHANNEL_SCRAPED_EVENT),
    saveRows: (records) => Actor.pushData(records),
    saveSummary: (summary) => Actor.setValue('RUN-SUMMARY', { ...summary, metadataFallback: metadataFallback.snapshot() }),
    log,
  });
} catch (error) {
  await Actor.fail(error instanceof Error ? error.message : 'YouTube run failed.');
}
await Actor.exit();
