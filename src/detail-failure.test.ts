import assert from 'node:assert/strict';
import test from 'node:test';
import { detailFailure, detailFailureCategory } from './detail-failure.js';

test('detail failure categories retain only approved fixed codes, not raw messages or causes', () => {
    for (const reason of ['request-limit', 'time-limit', 'response-size', 'player-config-missing',
        'source-http-status', 'invalid-source-json', 'player-metadata-missing',
        'video-identity-mismatch', 'video-identity-unconfirmed', 'source-unavailable', 'source-automation-check'] as const) {
        assert.equal(detailFailureCategory(detailFailure('PRIVATE_ERROR_WITH_TOKEN', reason)), reason);
    }
    for (const error of [null, 'PRIVATE_TOKEN', new Error('PRIVATE_TOKEN'),
        { reason: 'PRIVATE_PROXY_URL', cause: new Error('PRIVATE_TOKEN') }, { reason: 1 }]) {
        assert.equal(detailFailureCategory(error), 'source-unavailable');
    }
});
