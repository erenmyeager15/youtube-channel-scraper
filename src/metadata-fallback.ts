import type { ProxyConfiguration } from 'apify';
import { fetchBoundedHttp, transportLimitReason } from './bounded-http.js';
import { detailFailure, detailFailureCategory } from './detail-failure.js';
import { BudgetLimitError, RequestBudget } from './request-budget.js';
import { fetchYouTubePlayerData } from './youtube-http.js';

interface ChannelFallbackState { attempts: number; responseBytes: number; stopped: boolean }
export const METADATA_PROXY_LIMITS = Object.freeze({ attemptsPerChannel: 5, responseBytes: 32_768, channelBytes: 65_536 });

/** Explicit opt-in, lazy, compact public player requests only. Never page or media downloads. */
export function createMetadataFallback(options: {
    enabled: boolean;
    primaryProxy?: ProxyConfiguration;
    createResidentialProxy: () => Promise<ProxyConfiguration | undefined>;
    transport?: typeof fetchBoundedHttp;
}) {
    const transport = options.transport ?? fetchBoundedHttp;
    const channels = new WeakMap<RequestBudget, ChannelFallbackState>();
    const stats = { enabled: options.enabled, requests: 0, successful: 0, failed: 0, skipped: 0,
        decodedResponseBytes: 0, setupFailed: false };
    let proxyPromise: Promise<ProxyConfiguration | undefined> | undefined;

    async function proxyWithinDeadline(budget: RequestBudget): Promise<ProxyConfiguration> {
        budget.check();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const remaining = budget.remainingTimeMs();
            proxyPromise ??= options.createResidentialProxy();
            const proxy = await Promise.race([proxyPromise, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(remaining <= 30_000
                    ? new BudgetLimitError('time-limit') : new Error('Metadata proxy setup timed out.')),
                Math.min(30_000, remaining));
            })]);
            budget.check();
            if (!proxy) throw new Error('Metadata proxy unavailable.');
            return proxy;
        } catch (error) {
            stats.setupFailed = true;
            if (transportLimitReason(error)) throw error;
            throw detailFailure('Metadata proxy initialization failed.', 'source-unavailable');
        } finally { if (timer) clearTimeout(timer); }
    }

    async function fetchPlayer(videoId: string, html: string, budget: RequestBudget): Promise<Record<string, any>> {
        try { return await fetchYouTubePlayerData(videoId, html, options.primaryProxy, 1, budget, transport); }
        catch (error) {
            if (!options.enabled || options.primaryProxy || detailFailureCategory(error) !== 'source-automation-check') throw error;
        }
        budget.check();
        let state = channels.get(budget);
        if (!state) { state = { attempts: 0, responseBytes: 0, stopped: false }; channels.set(budget, state); }
        const bytesRemaining = METADATA_PROXY_LIMITS.channelBytes - state.responseBytes;
        if (stats.setupFailed || state.stopped || state.attempts >= METADATA_PROXY_LIMITS.attemptsPerChannel || bytesRemaining <= 0) {
            stats.skipped += 1;
            throw detailFailure('The bounded metadata fallback stopped for this channel.', 'source-automation-check', 'LOGIN_REQUIRED');
        }
        try {
            const proxy = await proxyWithinDeadline(budget);
            const data = await fetchYouTubePlayerData(videoId, html, proxy, 1, budget, async (request, activeBudget) => {
                state.attempts += 1; stats.requests += 1;
                const response = await transport(request, activeBudget);
                const size = Buffer.byteLength(response.body);
                state.responseBytes += size; stats.decodedResponseBytes += size;
                return response;
            }, { metadataOnlyProxy: true, maximumResponseBytes: Math.min(bytesRemaining, METADATA_PROXY_LIMITS.responseBytes) });
            if (data.videoDetails?.videoId !== videoId) {
                throw detailFailure('Metadata fallback returned a different or unidentified video.',
                    data.videoDetails?.videoId ? 'video-identity-mismatch' : 'video-identity-unconfirmed');
            }
            stats.successful += 1;
            return data;
        } catch (error) {
            state.stopped = true; stats.failed += 1;
            throw error;
        }
    }
    return { fetchPlayer, snapshot: () => ({ ...stats, limits: METADATA_PROXY_LIMITS }) };
}
