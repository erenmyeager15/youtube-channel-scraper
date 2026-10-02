import { randomBytes } from 'node:crypto';
import type { ProxyConfiguration } from 'apify';
import { BudgetLimitError, RequestBudget } from './request-budget.js';

interface YouTubeSession {
    readonly proxySessionId: string;
    readonly headerToken: object;
}

// One anonymous transport session per channel/search budget, released with that budget.
// These are local connection identifiers, not YouTube login/session cookies.
const sessions = new WeakMap<RequestBudget, YouTubeSession>();

export function getYouTubeSession(budget: RequestBudget): YouTubeSession {
    let session = sessions.get(budget);
    if (!session) {
        session = Object.freeze({ proxySessionId: `yt_${randomBytes(16).toString('hex')}`,
            headerToken: Object.freeze({}) });
        sessions.set(budget, session);
    }
    return session;
}

/** An explicitly selected proxy must not silently fall back to a direct request. */
export async function resolveYouTubeProxyUrl(
    proxy: ProxyConfiguration | undefined,
    budget: RequestBudget,
): Promise<string | undefined> {
    budget.check();
    if (!proxy) return undefined;
    const remainingMs = budget.remainingTimeMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const setupDeadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(remainingMs <= 30_000
                ? new BudgetLimitError('time-limit') : new Error('YouTube proxy setup timed out.')),
            Math.min(30_000, remainingMs));
        });
        const url = await Promise.race([proxy.newUrl(getYouTubeSession(budget).proxySessionId), setupDeadline]);
        budget.check();
        if (typeof url !== 'string' || !url) throw new Error('YouTube proxy URL was unavailable.');
        return url;
    } catch (error) {
        if (error instanceof BudgetLimitError) throw error;
        // Proxy SDK/custom-provider errors can contain credentials. Never copy their message/cause.
        throw new Error('YouTube proxy setup failed.');
    } finally {
        if (timer) clearTimeout(timer);
    }
}
