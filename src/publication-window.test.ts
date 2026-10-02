import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePublicationWindow, normalizeDateWindow, observePublicationDate } from './publication-window.js';

const observedAt = '2026-10-02T12:00:00.000Z';

test('date-only boundaries include the complete UTC day and equal bounds are valid', () => {
    assert.deepEqual(normalizeDateWindow('2024-02-29', '2024-02-29'), {
        publishedAfter: '2024-02-29T00:00:00.000Z',
        publishedBefore: '2024-02-29T23:59:59.999Z',
    });
    assert.deepEqual(normalizeDateWindow(), { publishedAfter: null, publishedBefore: null });
    assert.deepEqual(normalizeDateWindow(null, ' '), { publishedAfter: null, publishedBefore: null });
    assert.deepEqual(normalizeDateWindow('2026-10-02T05:30:00+05:30'), {
        publishedAfter: '2026-10-02T00:00:00.000Z', publishedBefore: null,
    });
});

test('strict input rejects invalid calendar dates, ambiguous timestamps, and inverted boundaries', () => {
    for (const invalid of ['2025-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01',
        '2026-10-00', '10/02/2026', '2026-10-02T12:00:00', '2026-10-02T24:00:00Z',
        '2026-10-02T12:60:00Z', '2026-10-02T12:00:60Z', '2026-10-02T12:00:00+24:00',
        '2026-10-02T12:00:00+05:60', 0, false, {}]) {
        assert.throws(() => normalizeDateWindow(invalid), Error, String(invalid));
    }
    assert.throws(() => normalizeDateWindow('2026-10-03', '2026-10-02'));
    assert.throws(() => normalizeDateWindow('2026-10-02T12:00:01Z', '2026-10-02T12:00:00Z'));
});

test('absolute timestamps retain exact precision and explicit dates retain day precision', () => {
    assert.deepEqual(observePublicationDate('2026-10-01', observedAt), {
        publishedAt: '2026-10-01T00:00:00.000Z', publishedAtPrecision: 'day',
        publishedAtEarliest: '2026-10-01T00:00:00.000Z', publishedAtLatest: '2026-10-01T23:59:59.999Z',
        sourceDateText: '2026-10-01',
    });
    const exact = observePublicationDate('2 days ago', observedAt, '2026-10-01T05:30:00+05:30');
    assert.equal(exact.publishedAtPrecision, 'exact');
    assert.equal(exact.publishedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(exact.publishedAtEarliest, exact.publishedAtLatest);
    assert.equal(exact.sourceDateText, '2 days ago');
    assert.equal(observePublicationDate(null, observedAt, '2026-10-01').publishedAtPrecision, 'day');
});

test('relative ages and streamed/premiered labels expose conservative intervals, never exact dates', () => {
    const labels = ['2 minutes ago', '2 hours ago', '2 days ago', '2 weeks ago', '2 months ago',
        '2 years ago', 'Streamed 2 weeks ago', 'Premiered 2 weeks ago', '0 minutes ago'];
    for (const label of labels) {
        const observation = observePublicationDate(label, observedAt);
        assert.equal(observation.publishedAtPrecision, 'relative', label);
        assert.equal(observation.publishedAt, null, label);
        assert.ok(observation.publishedAtEarliest && observation.publishedAtLatest, label);
        assert.ok(Date.parse(observation.publishedAtEarliest) < Date.parse(observation.publishedAtLatest), label);
        assert.ok(Date.parse(observation.publishedAtLatest) <= Date.parse(observedAt), label);
    }
    const twoDays = observePublicationDate('2 days ago', observedAt);
    assert.equal(twoDays.publishedAtEarliest, '2026-09-29T12:00:00.000Z');
    assert.equal(twoDays.publishedAtLatest, '2026-10-01T12:00:00.000Z');
    const years = observePublicationDate('2 years ago', observedAt);
    assert.equal(years.publishedAt, null);
    assert.ok(Date.parse(years.publishedAtLatest!) - Date.parse(years.publishedAtEarliest!) > 365 * 86_400_000);
});

test('null, invalid, localized and ambiguous dates stay unknown without becoming the epoch', () => {
    for (const label of [null, '', 'yesterday', '2日前', '2 months', 'Oct 1, 2026', '2026-02-30',
        '999999999999999999999999 years ago']) {
        const observation = observePublicationDate(label, observedAt);
        assert.equal(observation.publishedAtPrecision, 'unknown', String(label));
        assert.equal(observation.publishedAt, null);
        assert.equal(observation.publishedAtEarliest, null);
        assert.equal(observation.publishedAtLatest, null);
    }
    assert.equal(observePublicationDate('2 days ago', '2026-10-02').publishedAtPrecision, 'unknown');
    assert.equal(observePublicationDate('2 days ago', 'invalid').publishedAtPrecision, 'unknown');
    assert.equal(observePublicationDate('2 days ago', observedAt, '2026-02-30').publishedAtPrecision, 'relative');
});

test('window inclusion is inclusive and supports a single requested boundary', () => {
    const window = normalizeDateWindow('2026-10-01', '2026-10-01');
    for (const date of ['2026-10-01', '2026-10-01T00:00:00Z', '2026-10-01T23:59:59.999Z']) {
        assert.equal(evaluatePublicationWindow(observePublicationDate(date, observedAt), window), 'in-window');
    }
    for (const date of ['2026-09-30', '2026-10-02']) {
        assert.equal(evaluatePublicationWindow(observePublicationDate(date, observedAt), window), 'outside-window');
    }
    assert.equal(evaluatePublicationWindow(observePublicationDate('2026-10-01', observedAt),
        normalizeDateWindow('2026-09-01')), 'in-window');
    assert.equal(evaluatePublicationWindow(observePublicationDate('2026-10-01', observedAt),
        normalizeDateWindow(undefined, '2026-09-30')), 'outside-window');
});

test('overlapping/unknown intervals remain uncertain and may not be dropped', () => {
    const relative = observePublicationDate('2 days ago', observedAt);
    assert.equal(evaluatePublicationWindow(relative, normalizeDateWindow('2026-10-01', '2026-10-01')), 'uncertain');
    assert.equal(evaluatePublicationWindow(relative, normalizeDateWindow('2026-09-28', '2026-10-02')), 'in-window');
    assert.equal(evaluatePublicationWindow(relative, normalizeDateWindow('2026-10-02')), 'outside-window');
    assert.equal(evaluatePublicationWindow(relative, normalizeDateWindow(undefined, '2026-09-28')), 'outside-window');
    const unknown = observePublicationDate(null, observedAt);
    assert.equal(evaluatePublicationWindow(unknown, normalizeDateWindow(undefined, '1970-01-01')), 'uncertain');
    assert.equal(evaluatePublicationWindow(unknown, normalizeDateWindow()), 'not-requested');
    const day = observePublicationDate('2026-10-01', observedAt);
    assert.equal(evaluatePublicationWindow(day, normalizeDateWindow('2026-10-01T12:00:00Z')), 'uncertain');
});

test('compact source ages retain conservative intervals without inventing exact dates', () => {
    for (const [compact, expanded] of [['1d ago', '1 day ago'], ['3d ago', '3 days ago'],
        ['2h ago', '2 hours ago'], ['2w ago', '2 weeks ago'], ['2mo ago', '2 months ago'],
        ['2y ago', '2 years ago'], ['2 min ago', '2 minutes ago'],
        ['Streamed 2w ago', 'Streamed 2 weeks ago']]) {
        const actual = observePublicationDate(compact, observedAt);
        const expected = observePublicationDate(expanded, observedAt);
        assert.equal(actual.publishedAtPrecision, 'relative', compact);
        assert.equal(actual.publishedAt, null, compact);
        assert.equal(actual.publishedAtEarliest, expected.publishedAtEarliest, compact);
        assert.equal(actual.publishedAtLatest, expected.publishedAtLatest, compact);
        assert.equal(evaluatePublicationWindow(actual, normalizeDateWindow('2005-01-01', '2026-10-02')), 'in-window', compact);
    }
    for (const ambiguous of ['2m ago', '2mon ago', '2d', '2d before', '2q ago']) {
        assert.equal(observePublicationDate(ambiguous, observedAt).publishedAtPrecision, 'unknown', ambiguous);
    }
});
