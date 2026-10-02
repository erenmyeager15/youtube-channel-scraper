export type DetailFailureCategory =
    | 'request-limit' | 'time-limit' | 'response-size'
    | 'player-config-missing' | 'source-http-status' | 'invalid-source-json'
    | 'player-metadata-missing' | 'video-identity-mismatch' | 'video-identity-unconfirmed'
    | 'source-automation-check'
    | 'source-automation-check'
    | 'source-unavailable';

const CATEGORIES: ReadonlySet<string> = new Set([
    'request-limit', 'time-limit', 'response-size', 'player-config-missing',
    'source-http-status', 'invalid-source-json', 'player-metadata-missing',
    'video-identity-mismatch', 'video-identity-unconfirmed', 'source-unavailable',
    'source-automation-check',
    'source-automation-check',
]);

/** Only fixed codes reach public summaries; never errors, bodies, keys or proxy URLs. */
export function detailFailureCategory(error: unknown): DetailFailureCategory {
    const reason = typeof error === 'object' && error !== null && 'reason' in error
        ? (error as { reason?: unknown }).reason : null;
    return typeof reason === 'string' && CATEGORIES.has(reason)
        ? reason as DetailFailureCategory : 'source-unavailable';
}

export type PublicPlayerStatus = 'OK' | 'ERROR' | 'UNPLAYABLE' | 'LOGIN_REQUIRED'
    | 'CONTENT_CHECK_REQUIRED' | 'AGE_CHECK_REQUIRED' | 'LIVE_STREAM_OFFLINE';

const PLAYER_STATUSES: ReadonlySet<string> = new Set([
    'OK', 'ERROR', 'UNPLAYABLE', 'LOGIN_REQUIRED', 'CONTENT_CHECK_REQUIRED',
    'AGE_CHECK_REQUIRED', 'LIVE_STREAM_OFFLINE',
]);

function publicPlayerStatus(value: unknown): PublicPlayerStatus | null {
    return typeof value === 'string' && PLAYER_STATUSES.has(value) ? value as PublicPlayerStatus : null;
}

export function detailFailureDiagnostics(error: unknown): {
    category: DetailFailureCategory; playerStatus?: PublicPlayerStatus;
} {
    const status = publicPlayerStatus(typeof error === 'object' && error !== null && 'playerStatus' in error
        ? (error as { playerStatus?: unknown }).playerStatus : null);
    return { category: detailFailureCategory(error), ...(status ? { playerStatus: status } : {}) };
}

export function detailFailure(message: string, reason: DetailFailureCategory, playerStatus?: unknown): Error {
    const status = publicPlayerStatus(playerStatus);
    return Object.assign(new Error(message), { reason, ...(status ? { playerStatus: status } : {}) });
}
