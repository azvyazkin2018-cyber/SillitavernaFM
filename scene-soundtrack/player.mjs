const playerOrigin = 'https://w.soundcloud.com';
let widgetScript;

function loadWidgetApi() {
    if (window.SC?.Widget) return Promise.resolve(window.SC.Widget);
    widgetScript ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timeout = setTimeout(fail, 12000);
        function fail() {
            clearTimeout(timeout);
            script.remove();
            reject(new Error('Не удалось загрузить API плеера SoundCloud.'));
        }
        script.src = `${playerOrigin}/player/api.js`;
        script.addEventListener('error', fail, { once: true });
        script.addEventListener('load', () => {
            if (!window.SC?.Widget) return fail();
            clearTimeout(timeout);
            resolve(window.SC.Widget);
        }, { once: true });
        document.head.append(script);
    }).catch(error => {
        widgetScript = null;
        throw error;
    });
    return widgetScript;
}

export class SoundCloudPlayer {
    constructor(container, onError, onPlay) {
        this.container = container;
        this.onError = onError;
        this.onPlay = onPlay;
        this.volume = 35;
        this.clear();
    }

    clear() {
        const previous = this.session;
        this.session = null;
        this.resumePlayback = false;
        previous?.cancel?.();
        if (previous?.widget) {
            for (const event of previous.events) previous.widget.unbind(event);
        }
        this.container.replaceChildren();
    }

    setVolume(volume) {
        this.volume = volume;
        this.session?.widget?.setVolume(volume);
    }

    async open(source, autoPlay = false, playlist = false) {
        this.clear();
        const session = { events: [] };
        this.session = session;
        try {
            const Widget = await loadWidgetApi();
            if (this.session !== session) return null;
            const frame = document.createElement('iframe');
            const url = new URL(`${playerOrigin}/player/`);
            url.search = new URLSearchParams({ url: source, auto_play: String(autoPlay), show_artwork: 'false', visual: 'false' });
            frame.title = 'Плеер SoundCloud';
            frame.allow = 'autoplay';
            frame.referrerPolicy = 'no-referrer';
            frame.src = url.href;
            this.container.replaceChildren(frame);
            const widget = Widget(frame);
            session.widget = widget;
            const { READY, PLAY, PAUSE, ERROR } = Widget.Events;
            const bind = (event, callback) => {
                session.events.push(event);
                widget.bind(event, (...args) => {
                    if (this.session === session) callback(...args);
                });
            };
            const sounds = await new Promise((resolve, reject) => {
                const finish = (error, result) => {
                    clearTimeout(timeout);
                    session.cancel = null;
                    if (error) reject(error);
                    else resolve(result);
                };
                const timeout = setTimeout(() => finish(new Error('Плеер SoundCloud не ответил. Проверь ссылку и подключение.')), 16000);
                session.cancel = () => finish(null, null);
                bind(ERROR, () => {
                    const error = new Error('SoundCloud не смог воспроизвести этот трек или плейлист.');
                    if (session.cancel) finish(error);
                    else this.onError(error);
                });
                bind(PLAY, () => {
                    this.resumePlayback = true;
                    if (playlist) widget.getCurrentSoundIndex(index => {
                        if (this.session === session) this.onPlay(index);
                    });
                });
                bind(PAUSE, () => { this.resumePlayback = false; });
                bind(READY, () => {
                    widget.setVolume(this.volume);
                    if (playlist) widget.getSounds(tracks => finish(null, Array.isArray(tracks) ? tracks : []));
                    else finish(null, []);
                });
            });
            return this.session === session ? sounds : null;
        } catch (error) {
            if (this.session !== session) return null;
            this.clear();
            throw error;
        }
    }

    select(index, resume) {
        const widget = this.session?.widget;
        if (!widget) return;
        widget.skip(index);
        if (resume) widget.play();
        else widget.pause();
    }
}
