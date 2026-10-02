type PublicCard = Record<string, any>;

/** SHOW cards are playlist collections only when their public destination confirms the same ID. */
export function isPlaylistLockup(card: PublicCard): boolean {
    if (typeof card.contentId !== 'string' || !card.contentId) return false;
    if (/PLAYLIST/i.test(String(card.contentType ?? ''))) return true;
    if (card.contentType !== 'LOCKUP_CONTENT_TYPE_SHOW' || !/^PL[A-Za-z0-9_-]+$/.test(card.contentId)) return false;
    const command = card.rendererContext?.commandContext?.onTap?.innertubeCommand ?? card.navigationEndpoint;
    if (command?.browseEndpoint?.browseId === `VL${card.contentId}`) return true;
    const rawUrl = command?.commandMetadata?.webCommandMetadata?.url;
    if (typeof rawUrl !== 'string') return false;
    try {
        const url = new URL(rawUrl, 'https://www.youtube.com');
        return url.origin === 'https://www.youtube.com' && url.pathname === `/show/VL${card.contentId}`;
    } catch {
        return false;
    }
}
