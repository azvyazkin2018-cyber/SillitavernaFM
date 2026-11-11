import { analysisPrompt, catalogQueries, describeAnalysis, parseAnalysis, rankTracks, recentMessages, soundcloudUrl } from './scene.mjs';
import { SoundCloudPlayer } from './player.mjs';

const key = 'scene_soundtrack';
const modes = ['playlist', 'nature', 'instrumental', 'songs'];
const context = () => SillyTavern.getContext();
const trackChangeInterval = 45000;

function trackInfo(sound, index) {
    const url = soundcloudUrl(sound.permalink_url ?? sound.url, 'track');
    return {
        index,
        id: String(sound.urn ?? sound.id ?? url ?? index),
        title: String(sound.title ?? 'Без названия'),
        artist: String(sound.metadata_artist || sound.user?.username || (typeof sound.artist === 'string' ? sound.artist : '')),
        tags: [sound.genre, sound.tag_list, sound.tags].flat().filter(Boolean).join(' '),
        description: String(sound.description ?? ''),
        url: soundcloudUrl(sound.permalink_url ?? sound.url, 'track'),
    };
}

async function searchCatalog(queries, signal) {
    const tracks = new Map();
    for (const query of queries) {
        const response = await fetch('/api/plugins/scene-soundtrack/search', {
            method: 'POST',
            headers: context().getRequestHeaders(),
            body: JSON.stringify({ query }),
            signal,
        });
        if (response.status === 404) throw new Error('Для автопоиска установи серверный модуль или открой ручной поиск.');
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Каталог SoundCloud сейчас недоступен.');
        for (const item of result.tracks ?? []) {
            const track = trackInfo(item);
            if (track.url) tracks.set(track.url, track);
        }
    }
    return [...tracks.values()];
}

function mount() {
    const settingsHost = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!settingsHost || document.getElementById('scene-soundtrack')) return;

    const panel = document.createElement('details');
    panel.className = 'scene-soundtrack';
    panel.id = 'scene-soundtrack';
    panel.innerHTML = `
        <summary><b>Scene Soundtrack</b></summary>
        <div class="scene-soundtrack-options">
            <label class="checkbox_label"><input type="checkbox" data-field="enabled"> Подбирать саундтрек после ответов</label>
            <label class="scene-soundtrack-field">Источник
                <select data-field="mode" class="text_pole">
                    <option value="playlist">Мой плейлист SoundCloud</option>
                    <option value="nature">Звуки природы</option>
                    <option value="instrumental">Инструментал без слов</option>
                    <option value="songs">Песни из каталога</option>
                </select>
            </label>
            <label class="scene-soundtrack-field" data-ui="playlistField">Ссылка на плейлист SoundCloud
                <input type="url" class="text_pole" data-field="playlist" placeholder="https://soundcloud.com/…/sets/…" spellcheck="false" autocomplete="off">
            </label>
            <label class="scene-soundtrack-field">Последние сообщения
                <select class="text_pole" data-field="count">
                    <option>5</option><option>6</option><option>7</option><option>8</option><option>9</option><option>10</option>
                </select>
            </label>
            <label class="scene-soundtrack-field">Громкость <input type="range" data-field="volume" min="0" max="100"></label>
            <div class="scene-soundtrack-actions">
                <button class="menu_button" type="button" data-ui="select">Подобрать</button>
                <button class="menu_button" type="button" data-ui="next" disabled>Другой трек</button>
                <a data-ui="search" target="_blank" rel="noopener noreferrer" hidden>Найти на SoundCloud</a>
            </div>
            <p data-ui="analysis" hidden></p>
            <p data-ui="status" role="status" aria-live="polite"></p>
            <p data-ui="track" hidden></p>
            <div data-ui="player"></div>
        </div>`;
    settingsHost.append(panel);

    const settings = context().extensionSettings[key] ??= {};
    settings.enabled = settings.enabled === true;
    settings.mode = modes.includes(settings.mode) ? settings.mode : 'playlist';
    settings.playlist = typeof settings.playlist === 'string' ? settings.playlist : '';
    settings.count = [5, 6, 7, 8, 9, 10].includes(settings.count) ? settings.count : 8;
    settings.volume = Number.isInteger(settings.volume) ? Math.max(0, Math.min(100, settings.volume)) : 35;
    const fields = Object.fromEntries([...panel.querySelectorAll('[data-field]')].map(element => [element.dataset.field, element]));
    const ui = Object.fromEntries([...panel.querySelectorAll('[data-ui]')].map(element => [element.dataset.ui, element]));
    const status = text => { ui.status.textContent = text; };
    let revision = 0;
    let timer;
    let switchTimer;
    let searchController;
    let analyzing = false;
    let waitingAnalysis;
    let playlistSource;
    let playlistTracks = [];
    let candidates = [];
    let selected;
    let profile;
    let lastSwitch = 0;
    let played = [];

    function showTrack(track) {
        selected = track;
        ui.track.hidden = !track;
        ui.track.textContent = track ? [track.title, track.artist].filter(Boolean).join(' — ') : '';
        ui.next.disabled = candidates.length < 2;
    }

    const player = new SoundCloudPlayer(ui.player, error => status(error.message), index => {
        const track = playlistTracks.find(item => item.index === Number(index));
        if (track) showTrack(track);
    });

    function invalidate() {
        revision++;
        clearTimeout(timer);
        clearTimeout(switchTimer);
        searchController?.abort();
        waitingAnalysis = null;
        return revision;
    }

    function reset() {
        invalidate();
        player.clear();
        playlistSource = null;
        playlistTracks = [];
        candidates = [];
        played = [];
        profile = null;
        lastSwitch = 0;
        showTrack(null);
        ui.analysis.hidden = true;
        ui.search.hidden = true;
        status(settings.enabled ? 'Открой чат или нажми «Подобрать».' : 'Включи автоподбор или нажми «Подобрать».');
    }

    async function playTrack(track, job) {
        const resume = player.resumePlayback;
        if (settings.mode === 'playlist') {
            player.select(track.index, resume);
        } else {
            try {
                if (await player.open(track.url, resume) === null) return;
            } catch (error) {
                if (job === revision) showTrack(null);
                throw error;
            }
        }
        if (job !== revision) return;
        showTrack(track);
        lastSwitch = Date.now();
        played = [track.id, ...played.filter(id => id !== track.id)].slice(0, 5);
        const readyMessage = resume ? 'Саундтрек обновлён.' : 'Саундтрек выбран. Нажми Play в плеере.';
        status(!track.match && settings.mode === 'playlist' ? `${readyMessage} В плейлисте мало подходящих тегов.` : readyMessage);
    }

    async function choose(analysis, job, nextProfile, manual) {
        if (job !== revision) return;
        const mode = settings.mode;
        let tracks;
        try {
            if (mode === 'playlist') {
                const source = soundcloudUrl(settings.playlist.trim(), 'playlist');
                if (!source) throw new Error('Вставь полную ссылку на плейлист SoundCloud или ссылку из вкладки Embed.');
                if (playlistSource !== source) {
                    status('Открываю плейлист SoundCloud…');
                    const sounds = await player.open(source, false, true);
                    if (sounds === null) return;
                    playlistTracks = sounds.flatMap((sound, index) => sound && sound.streamable !== false && sound.playable !== false && sound.access !== 'blocked'
                        ? [trackInfo(sound, index)] : []);
                    playlistSource = source;
                }
                tracks = playlistTracks;
            } else {
                const queries = catalogQueries(analysis, mode);
                const url = new URL('https://soundcloud.com/search/sounds');
                url.searchParams.set('q', queries[0]);
                ui.search.href = url.href;
                ui.search.hidden = false;
                status('Ищу треки в каталоге SoundCloud…');
                searchController = new AbortController();
                tracks = await searchCatalog(queries, searchController.signal);
            }
            if (job !== revision) return;
            const ranked = rankTracks(tracks, analysis, mode);
            if (ranked.length === 0) throw new Error('SoundCloud не вернул доступных треков для этого режима.');
            candidates = ranked;
            const best = candidates[0];
            const freshMatch = candidates.find(track => track.score >= best.score - 2 && !played.includes(track.id));
            const other = manual && candidates.find(track => track.id !== selected?.id);
            await playTrack(freshMatch || other || best, job);
            if (job === revision) profile = nextProfile;
        } catch (error) {
            if (job === revision) status(error.message);
        }
    }

    async function analyze(job, manual) {
        if (job !== revision) return;
        if (analyzing) {
            waitingAnalysis = { job, manual };
            return;
        }
        const current = context();
        const messages = recentMessages(current.chat, settings.count);
        if (!messages.length) {
            status('В чате пока нет сообщений для анализа.');
            return;
        }
        analyzing = true;
        status('Определяю настроение сцены…');
        let analysis;
        try {
            const output = await current.generateRaw({ systemPrompt: analysisPrompt, prompt: JSON.stringify(messages), trimNames: false });
            analysis = parseAnalysis(output);
        } catch {
            if (job === revision) status('Не удалось разобрать сцену. Проверь подключение модели в SillyTavern и попробуй ещё раз.');
        } finally {
            analyzing = false;
            if (waitingAnalysis) {
                const waiting = waitingAnalysis;
                waitingAnalysis = null;
                queueMicrotask(() => analyze(waiting.job, waiting.manual));
            }
        }
        if (!analysis || job !== revision) return;
        ui.analysis.textContent = describeAnalysis(analysis);
        ui.analysis.hidden = false;
        const relevantScene = settings.mode === 'nature' || settings.mode === 'playlist' ? analysis.scene : '';
        const nextProfile = `${settings.mode}:${analysis.mood}:${relevantScene}`;
        if (!manual && profile === nextProfile && selected) {
            status('Текущий саундтрек подходит сцене.');
            return;
        }
        const delay = !manual && selected ? Math.max(0, trackChangeInterval - (Date.now() - lastSwitch)) : 0;
        if (delay) {
            status('Настроение изменилось. Переключу саундтрек после паузы между сменами.');
            switchTimer = setTimeout(() => choose(analysis, job, nextProfile, false), delay);
        } else {
            await choose(analysis, job, nextProfile, manual);
        }
    }

    function schedule(manual = false) {
        if (!settings.enabled && !manual) return;
        if (settings.mode === 'playlist' && !soundcloudUrl(settings.playlist.trim(), 'playlist')) {
            status('Вставь полную ссылку на плейлист SoundCloud или ссылку из вкладки Embed.');
            return;
        }
        const job = invalidate();
        timer = setTimeout(() => analyze(job, manual), manual ? 0 : 1250);
    }

    for (const [name, input] of Object.entries(fields)) {
        if (name === 'enabled') input.checked = settings.enabled;
        else input.value = String(settings[name]);
        input.addEventListener('change', () => {
            settings[name] = input.type === 'checkbox' ? input.checked : name === 'count' || name === 'volume' ? Number(input.value) : input.value.trim();
            context().saveSettingsDebounced();
            if (name === 'volume') return;
            ui.playlistField.hidden = settings.mode !== 'playlist';
            if (name !== 'count') reset();
            schedule();
        });
    }
    fields.volume.addEventListener('input', () => player.setVolume(Number(fields.volume.value)));
    player.setVolume(settings.volume);
    ui.playlistField.hidden = settings.mode !== 'playlist';
    ui.select.addEventListener('click', () => schedule(true));
    ui.next.addEventListener('click', () => {
        const currentIndex = candidates.findIndex(track => track.id === selected?.id);
        const next = candidates[(currentIndex + 1) % candidates.length];
        if (!next) return;
        const job = invalidate();
        playTrack(next, job).catch(error => { if (job === revision) status(error.message); });
    });

    const { eventSource, event_types: events } = context();
    for (const event of [events.MESSAGE_RECEIVED, events.MESSAGE_EDITED, events.MESSAGE_DELETED, events.MESSAGE_SWIPED]) {
        if (event) eventSource.on(event, () => schedule());
    }
    eventSource.on(events.CHAT_CHANGED, () => {
        reset();
        schedule();
    });
    reset();
    schedule();
}

const { eventSource, event_types } = context();
eventSource.on(event_types.APP_INITIALIZED, mount);
