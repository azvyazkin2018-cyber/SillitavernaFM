const tokenUrl = 'https://secure.soundcloud.com/oauth/token';
const trackUrl = 'https://api.soundcloud.com/tracks';
const accept = 'application/json; charset=utf-8';

export const info = {
    id: 'scene-soundtrack',
    name: 'Scene Soundtrack Catalog',
    description: 'Searches the public SoundCloud catalog for the Scene Soundtrack UI extension.',
};

class CatalogError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export async function init(router) {
    const clientId = process.env.SCENE_SOUNDTRACK_CLIENT_ID;
    const clientSecret = process.env.SCENE_SOUNDTRACK_CLIENT_SECRET;
    let credentials;
    let tokenRequest;
    let rateLimitedUntil = 0;
    let tokenRetryAt = 0;

    function rateLimit(response) {
        const retryAfter = response.headers.get('Retry-After');
        const seconds = Number(retryAfter);
        const delay = retryAfter && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        rateLimitedUntil = Date.now() + (delay > 0 ? Math.max(1000, delay) : 60000);
        throw new CatalogError(429, 'SoundCloud ограничил частоту запросов. Попробуй чуть позже.');
    }

    function tokenExchange(body, headers = {}) {
        return fetch(tokenUrl, {
            method: 'POST',
            headers: { Accept: accept, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
            body: new URLSearchParams(body),
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
        });
    }

    async function requestToken() {
        let response;
        if (credentials?.refreshToken) {
            response = await tokenExchange({
                grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret,
                refresh_token: credentials.refreshToken,
            });
        }
        if (!response || response.status === 400 || response.status === 401) {
            const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            response = await tokenExchange({ grant_type: 'client_credentials' }, { Authorization: `Basic ${basic}` });
        }
        if (response.status === 429) rateLimit(response);
        if (!response.ok) throw new CatalogError(503, 'Не удалось авторизовать приложение SoundCloud. Проверь ключи на сервере.');
        const data = await response.json();
        if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Invalid token response');
        credentials = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            renewAt: Date.now() + Math.max(1000, (Number(data.expires_in) || 3600) * 1000 - 60000),
        };
        return credentials.accessToken;
    }

    function accessToken(rejectedToken) {
        if (credentials?.renewAt > Date.now() && credentials.accessToken !== rejectedToken) return credentials.accessToken;
        if (tokenRetryAt > Date.now()) throw new CatalogError(503, 'Авторизация SoundCloud временно недоступна. Попробуй чуть позже.');
        tokenRequest ??= requestToken().catch(error => {
            tokenRetryAt = Date.now() + 30000;
            throw error;
        }).finally(() => { tokenRequest = null; });
        return tokenRequest;
    }

    function fetchTracks(query, token) {
        const url = new URL(trackUrl);
        url.search = new URLSearchParams({ q: query, access: 'playable', limit: '20', linked_partitioning: 'true' });
        return fetch(url, {
            headers: { Accept: accept, Authorization: `OAuth ${token}` },
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
        });
    }

    router.post('/search', async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const query = typeof request.body?.query === 'string' ? request.body.query.trim() : '';
        if (!/^[a-zA-Z][a-zA-Z0-9 -]{2,79}$/.test(query)) {
            return response.status(400).json({ error: 'Некорректный запрос к каталогу SoundCloud.' });
        }
        if (!clientId || !clientSecret) {
            return response.status(503).json({ error: 'Для автопоиска настрой ключи SoundCloud на сервере SillyTavern.' });
        }
        if (rateLimitedUntil > Date.now()) {
            return response.status(429).json({ error: 'SoundCloud ограничил частоту запросов. Попробуй чуть позже.' });
        }
        try {
            const token = await accessToken();
            let found = await fetchTracks(query, token);
            if (found.status === 401) found = await fetchTracks(query, await accessToken(token));
            if (found.status === 429) rateLimit(found);
            if (!found.ok) throw new CatalogError(502, 'SoundCloud отклонил запрос к каталогу.');
            const result = await found.json();
            const tracks = (Array.isArray(result) ? result : result.collection ?? [])
                .filter(track => track?.permalink_url && (!track.access || track.access === 'playable'))
                .map(track => ({
                    id: track.urn ?? track.id,
                    title: track.title,
                    artist: track.metadata_artist || track.user?.username,
                    permalink_url: track.permalink_url,
                    genre: track.genre,
                    tag_list: track.tag_list,
                    description: String(track.description ?? '').slice(0, 600),
                }));
            return response.json({ tracks });
        } catch (error) {
            const known = error instanceof CatalogError;
            return response.status(known ? error.status : 502).json({ error: known ? error.message : 'Каталог SoundCloud сейчас недоступен.' });
        }
    });
}
