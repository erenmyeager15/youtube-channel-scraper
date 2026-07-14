export type YouTubeDocumentState = 'normal' | 'blocked' | 'no-results' | 'unavailable';

export function classifyYouTubeDocument(
  title: string,
  bodyText: string,
  hasCaptcha = false,
): YouTubeDocumentState {
  const text = `${title}\n${bodyText}`.toLowerCase();

  if (
    hasCaptcha
    || /unusual traffic|automated quer(?:y|ies)|verify (?:that )?you are not a robot|captcha|recaptcha/.test(text)
  ) {
    return 'blocked';
  }
  if (/no results found|try different keywords|did not match any channels/.test(text)) {
    return 'no-results';
  }
  if (/this page isn['’]t available|this channel does not exist|404 not found/.test(text)) {
    return 'unavailable';
  }
  return 'normal';
}

export function parseCompactCount(text: string | null): number | null {
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;

  let value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = (match[2] ?? '').toUpperCase();
  if (suffix === 'B') value *= 1_000_000_000;
  else if (suffix === 'M') value *= 1_000_000;
  else if (suffix === 'K') value *= 1_000;
  return Math.round(value);
}

export function parseDurationToSeconds(text: string | null): number | null {
  if (!text) return null;

  const isoMatch = text.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (isoMatch) {
    return Number.parseInt(isoMatch[1] ?? '0', 10) * 3600
      + Number.parseInt(isoMatch[2] ?? '0', 10) * 60
      + Number.parseInt(isoMatch[3] ?? '0', 10);
  }

  const parts = text.trim().split(':').map(Number);
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

export function detectShorts(navigationUrl: string | null, durationSeconds: number | null): boolean {
  if (navigationUrl) {
    if (/\/shorts\//i.test(navigationUrl)) return true;
    if (/\/watch(?:\?|\/)/i.test(navigationUrl)) return false;
  }

  // Duration alone is only a fallback. YouTube now supports Shorts longer than 60 seconds,
  // while some ordinary videos are shorter than 60 seconds.
  return durationSeconds !== null && durationSeconds <= 60;
}

export function truncate(text: string | null, maxLength: number): string | null {
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function redactContactInfo(text: string | null): string | null {
  if (!text) return null;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/(?:\+?\d[\s().-]?){8,}\d/g, '[redacted]');
}
