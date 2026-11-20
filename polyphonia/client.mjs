/* Polyphonia · 汇声 — 为 Folia 打造的自定义音源壳插件：六平台（网易云/QQ/酷狗/酷我/咪咕/汽水）发现页 + 聚合搜索 + 播放联动。
 * 网易云/QQ/酷狗 的搜索与歌词委托宿主内置平台（folium.omni），酷我/咪咕/汽水 由 main 进程直连接口；
 * 播放链接统一经 rpc 交给 main 里的 LX 脚本解析，失败时可自动在其他已启用平台换源重试。 */

const L = (zh, en) => ({ 'zh-CN': zh, en });

const PLATFORMS = {
    wy: { host: 'netease', label: '网易云音乐', short: '网易云' },
    tx: { host: 'qq', label: 'QQ音乐', short: 'QQ' },
    kg: { host: 'kugou', label: '酷狗音乐', short: '酷狗' },
    kw: { host: null, label: '酷我音乐', short: '酷我' },
    mg: { host: null, label: '咪咕音乐', short: '咪咕' },
    qs: { host: null, label: '汽水音乐', short: '汽水' },
};
const SRC_ORDER = ['wy', 'tx', 'kg', 'kw', 'mg', 'qs'];
const PROVIDER_SOURCE = 'folium.polyphonia.lx';
const QUALITY_CHAIN = ['master', 'hires', 'atmos_plus', 'atmos', 'spatial', 'flac24bit', 'flac', '320k', '192k', '128k'];

const lrcTime = (seconds) => {
    const s = Math.max(0, Number(seconds) || 0);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    const xx = String(Math.round((s % 1) * 100)).padStart(2, '0');
    return `[${mm}:${ss}.${xx}]`;
};
const fmtDuration = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtCount = (n) => {
    const v = Number(n) || 0;
    if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
    if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
    return String(v);
};
const normText = (s) => String(s || '').toLowerCase().replace(/[\s()（）\[\]【】{}'’"“”,.，!！?？·\-_/\\|&:：;；]/g, '');
const dedupeKey = (title, artists) => `${normText(title)}|${(artists || []).map(a => normText(a)).sort().join(',')}`;
const tokenize = (q) => String(q || '').split(/[\s　]+/).map(t => t.trim()).filter(Boolean).slice(0, 6);
// 多关键词时按「命中词数 → 标题/歌手匹配强度」排序，支持「歌名 歌手」任意顺序
const songScore = (song, tokens) => {
    const title = normText(song.title);
    const artist = normText((song.artists || []).join(' '));
    const album = normText(song.album || '');
    let score = 0, matched = 0;
    for (const t of tokens) {
        const n = normText(t);
        if (!n) continue;
        if (title === n) { score += 4; matched++; }
        else if (title.includes(n)) { score += 2; matched++; }
        else if (artist === n) { score += 3; matched++; }
        else if (artist.includes(n)) { score += 2; matched++; }
        else if (album.includes(n)) { score += 0.5; }
    }
    return matched * 10 + score;
};

// 主题色可能是任意明度（dark 主题 primary 常为纯白），按钮文字按底色亮度取反色
const colorLum = (c) => {
    const s = String(c || '').trim();
    let r, g, b;
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split('').map(x => x + x).join('');
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else {
        m = /^rgba?\(([^)]+)\)$/i.exec(s);
        if (!m) return 0.5;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        [r, g, b] = p;
    }
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export default async function activate(folium) {
    if (!folium.host || !folium.host.folium || folium.host.folium.minor < 7) {
        folium.log.error('需要 Folium 1.7+（Folia 0.7.20+）');
        return;
    }

    const scripts = await folium.rpc.call('listScripts').catch(() => []);
    const scriptOptionsOf = (list) => list.length
        ? list.map(s => ({ value: s.file, label: L(`${s.name}${s.version ? ` v${s.version}` : ''}`, s.name) }))
        : [{ value: '', label: L('未找到脚本（到「音源」页导入本地 .js）', 'No script found') }];

    const QUALITY_OPTIONS = [
        { value: '128k', label: '128k' },
        { value: '320k', label: '320k' },
        { value: 'flac', label: L('FLAC 无损', 'FLAC') },
        { value: 'flac24bit', label: 'FLAC 24bit' },
        { value: 'hires', label: 'Hi-Res' },
        { value: 'master', label: L('母带', 'Master') },
    ];
    const SETTING_DEFAULTS = {
        enabled: true, script: '',
        searchWy: true, searchTx: true, searchKg: true, searchKw: true, searchMg: true, searchQs: true,
        autoSwitch: true, quality: 'flac',
    };
    const hostSchema = (options) => [
        { key: 'enabled', type: 'boolean', label: L('启用自定义源', 'Enable custom source'), defaultValue: true },
        { key: 'script', type: 'select', label: L('源脚本', 'Source script'), options },
        { key: 'searchWy', type: 'boolean', label: L('搜索包含网易云', 'Search NetEase'), defaultValue: true },
        { key: 'searchTx', type: 'boolean', label: L('搜索包含QQ音乐', 'Search QQ Music'), defaultValue: true },
        { key: 'searchKg', type: 'boolean', label: L('搜索包含酷狗', 'Search Kugou'), defaultValue: true },
        { key: 'searchKw', type: 'boolean', label: L('搜索包含酷我', 'Search Kuwo'), defaultValue: true },
        { key: 'searchMg', type: 'boolean', label: L('搜索包含咪咕', 'Search Migu'), defaultValue: true },
        { key: 'searchQs', type: 'boolean', label: L('搜索包含汽水', 'Search Qishui'), defaultValue: true },
        { key: 'autoSwitch', type: 'boolean', label: L('播放失败自动换源', 'Auto switch source on failure'), defaultValue: true },
        { key: 'quality', type: 'select', label: L('首选音质', 'Preferred quality'), options: QUALITY_OPTIONS, defaultValue: 'flac' },
    ];

    // 设置不再注册宿主 settingsSections（其卡片头与外框无法去除，和模组信息重复），
    // 改为插件页「设置」视图 + 模组存储持久化。
    let scriptOptions = scriptOptionsOf(scripts);
    const ownSettings = await folium.rpc.call('settingsGet').catch(() => null);
    let savedSettings = ownSettings;
    if (!ownSettings) {
        // 一次性迁移：旧版宿主分区名为 settings:lx-source，临时注册读旧值后立即注销
        try {
            const tmp = folium.registries.settingsSections.register({
                id: 'lx-source',
                label: L('Polyphonia · 汇声', 'Polyphonia'),
                settings: hostSchema(scriptOptions),
            });
            savedSettings = tmp.settings.get();
            tmp.unregister();
        } catch (e) { folium.log.error(`迁移旧设置失败：${e && e.message}`); }
    }
    let settingValues = { ...SETTING_DEFAULTS, ...(savedSettings || {}) };
    if (!ownSettings) void folium.rpc.call('settingsSet', settingValues).catch(() => {});
    const settingCbs = new Set();
    const settings = {
        get: () => settingValues,
        set: (patch) => {
            settingValues = { ...settingValues, ...patch };
            void folium.rpc.call('settingsSet', patch).catch(e => folium.log.error(`保存设置失败：${e && e.message}`));
            for (const cb of [...settingCbs]) cb();
        },
        onChange: (cb) => { settingCbs.add(cb); return () => settingCbs.delete(cb); },
    };

    // 「未选择脚本」是全新安装的预期状态，记 error 会被 Folium 2 当成界面出错弹红条
    const logScriptStatus = (s) => {
        if (!s || !s.error) return;
        if (s.error === '未选择脚本') folium.log.info(`脚本加载：${s.error}`);
        else folium.log.error(`脚本加载：${s.error}`);
    };
    const onSettingsChange = () => {
        const values = settings.get();
        void (async () => {
            if (values.script !== (status && status.scriptFile)) {
                status = await folium.rpc.call('reload', { script: values.script }).catch(e => ({ error: String(e) }));
                logScriptStatus(status);
            }
            syncProvider();
            if (uiRerender) uiRerender();
        })();
    };
    const disposeSettings = settings.onChange(onSettingsChange);

    const refreshScriptOptions = async () => {
        const list = await folium.rpc.call('listScripts').catch(() => []);
        scriptOptions = scriptOptionsOf(list);
        return list;
    };

    let status = await folium.rpc.call('reload', { script: settings.get().script }).catch(e => ({ error: String(e) }));
    logScriptStatus(status);
    if (status && status.dataDir) folium.log.info(`脚本目录：${status.dataDir}`);

    // myId = `${lxSource}:${platformMediaId}`
    const songCache = new Map();   // myId → {key, hostSong|null, song, txMid}
    const metaCache = new Map();   // myId → 平台歌曲完整元数据（含平台专有字段）
    const searchSessions = new Map();

    const splitId = (id) => {
        const i = String(id).indexOf(':');
        return i > 0 ? { src: String(id).slice(0, i), hostId: String(id).slice(i + 1) } : null;
    };

    const enabledSrcs = () => {
        const v = settings.get();
        const on = SRC_ORDER.filter(s => v[`search${s[0].toUpperCase()}${s.slice(1)}`] !== false);
        return on.length ? on : [];
    };

    const toProviderSong = (src, hostSong) => {
        const id = `${src}:${hostSong.id}`;
        const details = folium.omni.describeSong(hostSong);
        const song = {
            id,
            title: hostSong.title,
            artists: hostSong.artist ? hostSong.artist.split(' / ').filter(Boolean) : [],
            ...(hostSong.album ? { album: hostSong.album } : {}),
            ...(details && details.coverUrl ? { coverUrl: details.coverUrl } : {}),
            ...(details && details.durationMs ? { durationMs: details.durationMs } : {}),
        };
        let txMid = null;
        if (src === 'tx' && details && details.pageUrl) {
            const m = /songDetail\/([A-Za-z0-9]+)/.exec(details.pageUrl);
            if (m) txMid = m[1];
        }
        songCache.set(id, { key: { source: hostSong.source, id: hostSong.id }, hostSong, song, txMid });
        return song;
    };

    const platformToProviderSong = (src, s) => {
        const id = `${src}:${s.id}`;
        const song = {
            id,
            title: s.name,
            artists: s.singer ? s.singer.split(' / ').filter(Boolean) : [],
            ...(s.albumName ? { album: s.albumName } : {}),
            ...(s.picUrl ? { coverUrl: s.picUrl } : {}),
            ...(s.intervalSec ? { durationMs: s.intervalSec * 1000 } : {}),
        };
        metaCache.set(id, s);
        const host = PLATFORMS[src].host;
        songCache.set(id, { key: { source: host || src, id: s.id }, hostSong: null, song, txMid: (s.meta && s.meta.songmid) || null });
        return song;
    };

    const resolveHostSong = async (parsed) => {
        const host = PLATFORMS[parsed.src] && PLATFORMS[parsed.src].host;
        if (!host) return null;
        const resolutions = await folium.omni.resolveSongs([{ source: host, id: parsed.hostId }]).catch(() => null);
        const r = resolutions && resolutions[0];
        return r && r.status === 'found' ? r.song : null;
    };

    const buildMusicInfo = async (parsed, providerSong) => {
        const cached = songCache.get(providerSong.id);
        const chart = metaCache.get(providerSong.id);
        const durationMs = providerSong.durationMs || (cached && cached.song.durationMs) || 0;
        const base = chart ? {
            name: chart.name,
            singer: chart.singer,
            albumName: chart.albumName,
            albumId: chart.albumId || '',
            interval: chart.intervalSec || Math.round(durationMs / 1000),
            picUrl: chart.picUrl || '',
        } : {
            name: providerSong.title,
            singer: (providerSong.artists || []).join(' / '),
            albumName: providerSong.album || '',
            interval: Math.round(durationMs / 1000),
            albumId: '',
            picUrl: providerSong.coverUrl || '',
        };
        if (parsed.src === 'wy') {
            const numeric = Number(parsed.hostId);
            return { ...base, id: Number.isFinite(numeric) && String(numeric) === parsed.hostId ? numeric : parsed.hostId, songmid: parsed.hostId };
        }
        if (parsed.src === 'tx') {
            let mid = (chart && chart.meta && chart.meta.songmid) || (cached && cached.txMid) || (/^[A-Za-z0-9]{10,}$/.test(parsed.hostId) ? parsed.hostId : null);
            if (!mid) mid = await folium.rpc.call('txMid', { id: parsed.hostId }).catch(() => null);
            const strMediaMid = (chart && chart.meta && chart.meta.strMediaMid) || mid || '';
            return { ...base, songmid: mid || parsed.hostId, strMediaMid, id: parsed.hostId };
        }
        if (parsed.src === 'kg') {
            const m = (chart && chart.meta) || {};
            return { ...base, hash: parsed.hostId, album_audio_id: m.album_audio_id || '', albumAudioId: m.album_audio_id || '', mixsongid: m.audio_id || '', songmid: m.audio_id || '' };
        }
        if (parsed.src === 'kw') {
            return { ...base, id: parsed.hostId, songmid: parsed.hostId, hash: parsed.hostId };
        }
        if (parsed.src === 'mg') {
            const m = (chart && chart.meta) || {};
            return { ...base, id: parsed.hostId, songmid: parsed.hostId, copyrightId: m.copyrightId || '', meta: m };
        }
        if (parsed.src === 'qs') {
            return { ...base, id: parsed.hostId, songmid: parsed.hostId, interval: String(base.interval || '') };
        }
        return { ...base, id: parsed.hostId };
    };

    const pickQuality = (src) => {
        const wanted = String(settings.get().quality || 'flac');
        const supported = (status && status.sources && status.sources[src] && status.sources[src].qualitys) || [];
        const start = Math.max(0, QUALITY_CHAIN.indexOf(wanted));
        for (let i = start; i < QUALITY_CHAIN.length; i++) {
            if (!supported.length || supported.includes(QUALITY_CHAIN[i])) return QUALITY_CHAIN[i];
        }
        return supported[0] || '128k';
    };

    const requestUrl = async (src, providerSong) => {
        const parsed = splitId(providerSong.id);
        const url = await folium.rpc.call('musicUrl', {
            source: src,
            type: pickQuality(src),
            musicInfo: await buildMusicInfo(parsed, providerSong),
        });
        return url || null;
    };

    // 自动换源：在其他已启用平台按 标题+歌手 找同一首歌
    const findAlternative = async (failedSrc, song) => {
        const title = song.title || (metaCache.get(song.id) || {}).name || '';
        const artists = song.artists || [];
        if (!title) return null;
        const q = `${title} ${artists[0] || ''}`.trim();
        const nt = normText(title);
        const na = artists.map(normText).filter(Boolean);
        for (const src of enabledSrcs()) {
            if (src === failedSrc) continue;
            let candidates = [];
            try {
                if (PLATFORMS[src].host) {
                    const r = await folium.omni.searchSongs(q, { providerId: PLATFORMS[src].host, limit: 8 });
                    candidates = (r.items || []).map(x => toProviderSong(src, x));
                } else {
                    const r = await folium.rpc.call('platformSearch', { source: src, str: q, page: 1, limit: 8 });
                    candidates = (r.songs || []).map(x => platformToProviderSong(src, x));
                }
            } catch { continue; }
            const scored = candidates.map(c => {
                const ct = normText(c.title);
                const titleHit = ct === nt || (nt.length > 3 && (ct.includes(nt) || nt.includes(ct)));
                if (!titleHit) return null;
                const ca = (c.artists || []).map(normText);
                const artistHit = na.length && ca.some(a => na.includes(a));
                return { c, score: (ct === nt ? 2 : 1) + (artistHit ? 2 : 0) };
            }).filter(Boolean).sort((a, b) => b.score - a.score);
            if (!scored.length) continue;
            try {
                const url = await requestUrl(src, scored[0].c);
                if (url) {
                    folium.log.info(`自动换源：${PLATFORMS[failedSrc].short} → ${PLATFORMS[src].short}「${title}」`);
                    return url;
                }
            } catch { /* 尝试下一个平台 */ }
        }
        return null;
    };

    // ---- 多平台聚合搜索：每平台独立游标，结果按 标题+歌手 去重后合并 ----
    const mergedSearch = async (query, page) => {
        const srcs = enabledSrcs();
        const q = String(query || '').trim().slice(0, 200);
        if (!q || !srcs.length) return { items: [], hasMore: false };
        const limit = Math.min(Math.max(1, page.limit || 30), 50);
        const offset = Math.max(0, page.offset || 0);
        const key = `${q}|${srcs.join(',')}`;
        const tokens = tokenize(q);
        let session = searchSessions.get(key);
        if (!session) {
            session = { items: [], seen: new Set(), perSrc: Object.fromEntries(srcs.map(s => [s, { cursor: undefined, page: 1, done: false }])) };
            searchSessions.set(key, session);
            if (searchSessions.size > 20) searchSessions.delete(searchSessions.keys().next().value);
        }
        while (session.items.length < offset + limit && srcs.some(s => !session.perSrc[s].done)) {
            const batches = await Promise.all(srcs.filter(s => !session.perSrc[s].done).map(async (s) => {
                const st = session.perSrc[s];
                try {
                    if (PLATFORMS[s].host) {
                        const r = await folium.omni.searchSongs(q, { providerId: PLATFORMS[s].host, limit, ...(st.cursor ? { cursor: st.cursor } : {}) });
                        st.cursor = r.nextCursor || undefined;
                        st.done = !r.nextCursor;
                        return (r.items || []).filter(x => x.id != null).map(x => toProviderSong(s, x));
                    }
                    const r = await folium.rpc.call('platformSearch', { source: s, str: q, page: st.page, limit });
                    st.page += 1;
                    st.done = !r.hasMore;
                    return (r.songs || []).map(x => platformToProviderSong(s, x));
                } catch (e) {
                    folium.log.error(`搜索 ${PLATFORMS[s].label} 失败：${e && e.message}`);
                    st.done = true;
                    return [];
                }
            }));
            let added = 0;
            for (const song of batches.flat()) {
                const dk = dedupeKey(song.title, song.artists);
                if (session.seen.has(dk)) continue;
                session.seen.add(dk);
                session.items.push(song);
                added++;
            }
            if (tokens.length) session.items.sort((a, b) => songScore(b, tokens) - songScore(a, tokens));
            if (!added && srcs.every(s => session.perSrc[s].done)) break;
            if (!added) break;
        }
        const items = session.items.slice(offset, offset + limit);
        const hasMore = session.items.length > offset + limit || srcs.some(s => !session.perSrc[s].done);
        return { items, hasMore };
    };

    const providerDef = {
        id: 'lx',
        displayName: 'Polyphonia · 汇声',
        shortName: '汇声',
        search: mergedSearch,
        getSong: async (id) => {
            const cached = songCache.get(id);
            if (cached) return cached.song;
            const parsed = splitId(id);
            if (!parsed) return null;
            const hostSong = await resolveHostSong(parsed);
            return hostSong ? toProviderSong(parsed.src, hostSong) : null;
        },
        getAudioUrl: async (song) => {
            if (!settings.get().enabled) return null;
            const parsed = splitId(song.id);
            if (!parsed || !PLATFORMS[parsed.src]) return null;
            try {
                const url = await requestUrl(parsed.src, song);
                if (url) return { url };
            } catch (e) {
                folium.log.error(`解析 ${PLATFORMS[parsed.src].short}「${song.title}」失败：${e && e.message}`);
            }
            if (settings.get().autoSwitch !== false) {
                const alt = await findAlternative(parsed.src, song).catch(() => null);
                if (alt) return { url: alt };
            }
            return null;
        },
        getLyrics: async (song) => {
            const parsed = splitId(song.id);
            if (!parsed) return null;
            if (!PLATFORMS[parsed.src].host) {
                try {
                    const r = await folium.rpc.call('platformLyric', { source: parsed.src, musicInfo: await buildMusicInfo(parsed, song) });
                    if (r && r.lrc) return { main: { format: 'lrc', text: r.lrc, ...(r.tlyric ? { translationText: r.tlyric } : {}) } };
                } catch { /* 无歌词 */ }
                return null;
            }
            let hostSong = (songCache.get(song.id) || {}).hostSong || null;
            if (!hostSong) {
                hostSong = await resolveHostSong(parsed);
                if (!hostSong) return null;
                const cached = songCache.get(song.id);
                if (cached) cached.hostSong = hostSong;
            }
            const lyrics = await folium.omni.getLyrics(hostSong).catch(() => null);
            if (!lyrics) return null;
            if (lyrics.isPureMusic) return { isPureMusic: true };
            const lines = lyrics.lines || [];
            if (!lines.length) return null;
            const text = lines.map(l => `${lrcTime(l.startTime)}${l.fullText}`).join('\n');
            const translated = lines.filter(l => l.translation);
            const romanized = lines.filter(l => l.romanization);
            return {
                main: {
                    format: 'lrc',
                    text,
                    ...(translated.length ? { translationText: translated.map(l => `${lrcTime(l.startTime)}${l.translation}`).join('\n') } : {}),
                    ...(romanized.length ? { romanizationText: romanized.map(l => `${lrcTime(l.startTime)}${l.romanization}`).join('\n') } : {}),
                },
            };
        },
    };

    let providerHandle = null;
    const syncProvider = () => {
        const want = Boolean(settings.get().enabled) && Boolean(status && status.ready);
        if (want && !providerHandle) {
            providerHandle = folium.experimental['omni.providers'].register(providerDef);
        } else if (!want && providerHandle) {
            providerHandle.unregister();
            providerHandle = null;
        }
    };
    syncProvider();

    // ---- 播放联动：myId → 宿主 ref → playSong / enqueue / replaceQueue ----
    const resolveMyIds = async (ids) => {
        const out = [];
        for (let i = 0; i < ids.length; i += 50) {
            const chunk = ids.slice(i, i + 50);
            const rs = await folium.omni.resolveSongs(chunk.map(id => ({ source: PROVIDER_SOURCE, id }))).catch(() => []);
            for (const r of rs || []) if (r && r.status === 'found' && r.song && r.song.ref) out.push(r.song);
        }
        return out;
    };

    // ---- 发现首页 ----
    const boardsCache = new Map();
    const chartSongsCache = new Map();
    const catsCache = new Map();
    let uiRerender = null;
    let renderImpl = null;
    let uiState = null;
    let uiInited = false;
    let uiScroll = [];

    const mountHome = (container, ctx) => {
        const state = uiState || (uiState = {
            view: 'charts', src: 'wy',
            boards: [], boardId: null, boardName: '', songs: [], loading: false, error: '',
            cats: [], cat: '', lists: [], listPage: 1, listHasMore: false, listLoading: false, unsupported: '',
            col: null, colSrc: '', colSongs: [], colTotal: 0, colLoading: false,
            qsKeyword: '热门', feedSongs: [], feedLoading: false,
            query: '', searchItems: [], searchOffset: 0, searchHasMore: false, searching: false,
            searchSrcFilter: [], searchSingerFilter: '',
            importText: '', importing: false,
            myLists: [], myMerge: false, mySel: [], merging: false, renamingKey: '', renameText: '', colMyKey: null,
            creatingList: false, newListName: '',
            scripts: [], scriptsLoading: false, editor: null,
        });
        state.loading = false; state.listLoading = false; state.colLoading = false;
        state.feedLoading = false; state.searching = false; state.importing = false; state.scriptsLoading = false;
        if (state.editor) state.editor.saving = false;
        if (state.view === 'settings') state.view = 'sources';
        listsGetter = () => state.myLists;
        listsSync = (l) => { state.myLists = l; render(); };

        const root = document.createElement('div');
        root.className = 'lx-root';
        const style = document.createElement('style');
        style.textContent = `
.lx-root{display:flex;flex-direction:column;height:100%;min-height:0;font-family:var(--folium-font,sans-serif);color:var(--lx-text);background:var(--lx-bg);font-size:14px;position:relative}
.lx-root *{box-sizing:border-box}
.lx-head{display:flex;align-items:center;gap:12px;padding:14px 20px 10px;flex-wrap:wrap}
.lx-title{font-size:18px;font-weight:700}
.lx-chip{font-size:12px;padding:2px 10px;border-radius:999px;background:color-mix(in srgb,var(--lx-primary) 18%,transparent);color:var(--lx-primary)}
.lx-chip.bad{background:color-mix(in srgb,#e5484d 18%,transparent);color:#e5484d}
.lx-tabs{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.lx-tab{border:none;cursor:pointer;padding:6px 16px;border-radius:8px;background:transparent;color:var(--lx-text);opacity:.65;font-size:14px}
.lx-tab.on{background:var(--lx-accent,#4f8ef7);color:var(--lx-on-accent,#fff);opacity:1}
.lx-plats{display:flex;gap:6px;padding:0 20px 10px;flex-wrap:wrap}
.lx-plat{border:1px solid color-mix(in srgb,var(--lx-text) 20%,transparent);cursor:pointer;padding:4px 14px;border-radius:999px;background:transparent;color:var(--lx-text);font-size:13px}
.lx-plat.on{border-color:var(--lx-primary);color:var(--lx-primary);background:color-mix(in srgb,var(--lx-primary) 12%,transparent)}
.lx-body{display:flex;flex:1;min-height:0;gap:0}
.lx-boards{width:190px;overflow-y:auto;padding:0 10px 16px 20px;display:flex;flex-direction:column;gap:4px;flex-shrink:0}
.lx-board{border:none;text-align:left;cursor:pointer;padding:8px 12px;border-radius:8px;background:transparent;color:var(--lx-text);font-size:13px;opacity:.8}
.lx-board:hover{background:color-mix(in srgb,var(--lx-text) 8%,transparent)}
.lx-board.on{background:color-mix(in srgb,var(--lx-primary) 16%,transparent);color:var(--lx-primary);opacity:1;font-weight:600}
.lx-main{flex:1;min-width:0;display:flex;flex-direction:column;padding:0 20px 12px}
.lx-toolbar{display:flex;align-items:center;gap:10px;padding:4px 0 10px;flex-wrap:wrap}
.lx-boardname{font-weight:600;font-size:15px}
.lx-count{opacity:.55;font-size:12px}
.lx-btn{border:none;cursor:pointer;padding:6px 14px;border-radius:8px;background:var(--lx-accent,#4f8ef7);color:var(--lx-on-accent,#fff);font-size:13px}
.lx-btn.ghost{background:color-mix(in srgb,var(--lx-text) 10%,transparent);color:var(--lx-text)}
.lx-btn:disabled{opacity:.45;cursor:default}
.lx-btn.sm{padding:3px 9px;font-size:12px;border-radius:6px}
.lx-list{flex:1;overflow-y:auto;min-height:0;border-radius:10px;background:color-mix(in srgb,var(--lx-text) 4%,transparent)}
.lx-row{display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid color-mix(in srgb,var(--lx-text) 7%,transparent)}
.lx-row:hover{background:color-mix(in srgb,var(--lx-primary) 8%,transparent)}
.lx-idx{width:28px;text-align:right;opacity:.45;font-size:12px;flex-shrink:0}
.lx-cover{width:38px;height:38px;border-radius:6px;object-fit:cover;flex-shrink:0;background:color-mix(in srgb,var(--lx-text) 10%,transparent)}
.lx-meta{flex:1;min-width:0}
.lx-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13.5px}
.lx-artist{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;opacity:.55}
.lx-album{width:20%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;opacity:.55;flex-shrink:0}
.lx-dur{width:44px;font-size:12px;opacity:.55;flex-shrink:0}
.lx-src{font-size:11px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--lx-primary) 14%,transparent);color:var(--lx-primary);flex-shrink:0}
.lx-acts{display:flex;gap:6px;flex-shrink:0}
.lx-msg{padding:24px;text-align:center;opacity:.6}
.lx-msg.err{color:#e5484d;opacity:1}
.lx-searchbar{display:flex;gap:8px;padding:0 0 12px}
.lx-input{flex:1;padding:8px 14px;border-radius:8px;border:1px solid color-mix(in srgb,var(--lx-text) 22%,transparent);background:color-mix(in srgb,var(--lx-text) 5%,transparent);color:var(--lx-text);font-size:14px;outline:none;min-width:0}
.lx-input:focus{border-color:var(--lx-primary)}
.lx-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:color-mix(in srgb,var(--lx-text) 88%,var(--lx-bg));color:var(--lx-bg);padding:8px 18px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;max-width:80%;z-index:5}
.lx-toast.show{opacity:.95}
.lx-foot{padding:8px 0 0;text-align:center}
.lx-cats{display:flex;gap:6px;padding:0 0 10px;overflow-x:auto;flex-shrink:0}
.lx-select{flex:0 0 auto;width:auto;max-width:200px;padding:3px 12px;font-size:12px;border-radius:999px;border:1px solid color-mix(in srgb,var(--lx-text) 22%,transparent);background:color-mix(in srgb,var(--lx-text) 5%,transparent);color:var(--lx-text);outline:none;cursor:pointer}
.lx-select option{background:var(--lx-bg);color:var(--lx-text)}
.lx-cat{border:1px solid color-mix(in srgb,var(--lx-text) 18%,transparent);cursor:pointer;padding:3px 12px;border-radius:999px;background:transparent;color:var(--lx-text);font-size:12px;white-space:nowrap;opacity:.8}
.lx-cat.on{border-color:var(--lx-primary);color:var(--lx-primary);background:color-mix(in srgb,var(--lx-primary) 12%,transparent);opacity:1}
.lx-grid{flex:1;overflow-y:auto;min-height:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;align-content:start;padding:2px}
.lx-card{cursor:pointer;border-radius:10px;overflow:hidden;background:color-mix(in srgb,var(--lx-text) 5%,transparent);border:none;padding:0;text-align:left;color:var(--lx-text)}
.lx-card:hover{background:color-mix(in srgb,var(--lx-primary) 12%,transparent)}
.lx-card img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:color-mix(in srgb,var(--lx-text) 10%,transparent)}
.lx-cardname{font-size:12.5px;padding:7px 9px 2px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.lx-cardsub{font-size:11px;opacity:.55;padding:0 9px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lx-colhead{display:flex;align-items:center;gap:12px;padding:0 0 12px}
.lx-colhead img{width:64px;height:64px;border-radius:8px;object-fit:cover;flex-shrink:0}
.lx-colinfo{flex:1;min-width:0}
.lx-colname{font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lx-colsub{font-size:12px;opacity:.55;margin-top:3px}
.lx-import{display:flex;gap:8px;padding:0 0 12px;align-items:center}
.lx-import .lx-input{font-size:13px;padding:6px 12px}
.lx-reninput{flex:none;width:100%;font-size:13px;padding:4px 10px;margin:0 0 4px}
.lx-hint{font-size:12px;opacity:.5;white-space:nowrap}
.lx-myitem{border-bottom:1px solid color-mix(in srgb,var(--lx-text) 7%,transparent)}
.lx-myrow{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer}
.lx-check{flex:none;width:16px;height:16px;margin:0 2px;cursor:pointer}
.lx-myrow:hover{background:color-mix(in srgb,var(--lx-primary) 8%,transparent)}
.lx-mycover{width:44px;height:44px;border-radius:6px;object-fit:cover;flex-shrink:0;background:color-mix(in srgb,var(--lx-text) 10%,transparent)}
.lx-note{font-size:12px;opacity:.55;padding:0 0 10px;line-height:1.5}
.lx-script{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,var(--lx-text) 7%,transparent)}
.lx-script:hover{background:color-mix(in srgb,var(--lx-primary) 8%,transparent)}
.lx-scriptmeta{flex:1;min-width:0}
.lx-scriptname{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lx-scriptsub{font-size:12px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.lx-editor{flex:1;min-height:0;width:100%;resize:none;border-radius:10px;border:1px solid color-mix(in srgb,var(--lx-text) 22%,transparent);background:color-mix(in srgb,var(--lx-text) 5%,transparent);color:var(--lx-text);font-family:ui-monospace,Consolas,monospace;font-size:12.5px;padding:12px;outline:none;line-height:1.55}
.lx-editor:focus{border-color:var(--lx-primary)}
`;
        root.appendChild(style);

        const applyTheme = () => {
            const t = ctx.getTheme();
            const accent = t.accentColor || t.primaryColor || '#4f8ef7';
            root.style.setProperty('--lx-bg', t.backgroundColor || 'transparent');
            root.style.setProperty('--lx-primary', t.primaryColor || '#4f8ef7');
            root.style.setProperty('--lx-accent', accent);
            root.style.setProperty('--lx-on-accent', colorLum(accent) > 0.45 ? '#101014' : '#ffffff');
            root.style.setProperty('--lx-text', t.isDaylight ? '#1c1c1e' : '#f2f2f7');
        };
        applyTheme();
        const offTheme = ctx.onChange(applyTheme);

        let toastTimer = null;
        const toastEl = document.createElement('div');
        toastEl.className = 'lx-toast';
        const toast = (msg) => {
            toastEl.textContent = msg;
            toastEl.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
        };

        const el = (tag, cls, text) => {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (text != null) n.textContent = text;
            return n;
        };

        const requireReady = () => {
            if (!settings.get().enabled || !(status && status.ready)) {
                toast('自定义源未启用或脚本未就绪，请到「发现 → 音源」检查');
                return false;
            }
            return true;
        };

        const playOne = async (id) => {
            if (!requireReady()) return;
            const songs = await resolveMyIds([id]);
            if (!songs.length) { toast('歌曲解析失败'); return; }
            const ok = await folium.playback.playSong(songs[0]);
            if (!ok) toast('播放失败');
        };
        const enqueueOne = async (id) => {
            if (!requireReady()) return;
            const songs = await resolveMyIds([id]);
            if (!songs.length) { toast('歌曲解析失败'); return; }
            folium.playback.enqueue(songs[0]);
            toast('已加入队列');
        };
        const playAll = async (ids) => {
            if (!requireReady() || !ids.length) return;
            toast(`正在解析 ${ids.length} 首…`);
            const songs = await resolveMyIds(ids);
            if (!songs.length) { toast('没有可播放的歌曲'); return; }
            const q = folium.playback.getQueue({ limit: 1 });
            const res = await folium.playback.replaceQueue(songs, { expectedVersion: q.version }).catch(e => ({ status: 'refused', reason: String(e && e.message) }));
            if (res.status !== 'replaced') { toast(`替换队列失败：${res.reason || '未知'}`); return; }
            await folium.playback.playSong(songs[0]);
            toast(`已播放全部（${songs.length} 首）`);
        };

        const songRow = (song, idx, onRemove) => {
            const row = el('div', 'lx-row');
            row.appendChild(el('span', 'lx-idx', String(idx + 1)));
            if (song.coverUrl) {
                const img = el('img', 'lx-cover');
                img.loading = 'lazy';
                img.src = song.coverUrl;
                img.onerror = () => img.remove();
                row.appendChild(img);
            } else row.appendChild(el('span', 'lx-cover'));
            const meta = el('div', 'lx-meta');
            meta.appendChild(el('div', 'lx-name', song.title));
            meta.appendChild(el('div', 'lx-artist', (song.artists || []).join(' / ')));
            row.appendChild(meta);
            const parsed = splitId(song.id);
            if (parsed && PLATFORMS[parsed.src]) row.appendChild(el('span', 'lx-src', PLATFORMS[parsed.src].short));
            row.appendChild(el('span', 'lx-album', song.album || ''));
            row.appendChild(el('span', 'lx-dur', song.durationMs ? fmtDuration(song.durationMs / 1000) : ''));
            const acts = el('div', 'lx-acts');
            const bPlay = el('button', 'lx-btn sm', '播放');
            bPlay.onclick = () => playOne(song.id);
            const bAdd = el('button', 'lx-btn sm ghost', '＋');
            bAdd.title = '加入队列';
            bAdd.onclick = () => enqueueOne(song.id);
            acts.appendChild(bPlay);
            acts.appendChild(bAdd);
            if (onRemove) {
                const bRm = el('button', 'lx-btn sm ghost', '移出');
                bRm.title = '从本收藏移出';
                bRm.onclick = () => onRemove(song);
                acts.appendChild(bRm);
            }
            row.appendChild(acts);
            return row;
        };

        const songListEl = (songs, loading, error, emptyText, onRemove) => {
            const list = el('div', 'lx-list');
            if (loading && !songs.length) list.appendChild(el('div', 'lx-msg', '加载中…'));
            else if (error && !songs.length) list.appendChild(el('div', 'lx-msg err', error));
            else if (!songs.length) list.appendChild(el('div', 'lx-msg', emptyText));
            else songs.forEach((s, i) => list.appendChild(songRow(s, i, onRemove)));
            return list;
        };

        // ---- 榜单 ----
        const loadBoards = async (src) => {
            if (!boardsCache.has(src)) {
                const list = await folium.rpc.call('chartLists', { source: src });
                boardsCache.set(src, list);
            }
            return boardsCache.get(src);
        };
        const loadChart = async (src, boardId, boardName) => {
            state.loading = true; state.error = ''; state.boardId = boardId; state.boardName = boardName; state.songs = [];
            render();
            try {
                const key = `${src}:${boardId}`;
                if (!chartSongsCache.has(key)) {
                    const r = await folium.rpc.call('chartSongs', { source: src, boardId });
                    chartSongsCache.set(key, r.songs.map(s => platformToProviderSong(src, s)));
                }
                if (state.boardId !== boardId || state.src !== src) return;
                state.songs = chartSongsCache.get(key);
            } catch (e) {
                state.error = `榜单加载失败：${e && e.message}`;
            }
            state.loading = false;
            render();
        };

        // ---- 发现（推荐/歌单/专辑）----
        const discoverKind = () => state.view === 'recommend' ? 'recommend' : state.view;
        const loadCats = async (src, kind) => {
            const key = `${src}:${kind}`;
            if (!catsCache.has(key)) {
                const cats = await folium.rpc.call('discoverCats', { source: src, kind }).catch(() => []);
                catsCache.set(key, cats || []);
            }
            return catsCache.get(key);
        };
        const loadMyLists = async () => {
            state.listLoading = true; state.error = '';
            render();
            try { state.myLists = (await folium.rpc.call('myLists')) || []; }
            catch (e) { state.error = `加载失败：${e && e.message}`; }
            state.listLoading = false;
            render();
        };
        const loadLists = async (reset) => {
            const src = state.src, kind = discoverKind();
            const cat = state.cat;
            if (reset) { state.lists = []; state.listPage = 1; state.listHasMore = false; state.unsupported = ''; }
            state.listLoading = true; state.error = '';
            render();
            try {
                const r = await folium.rpc.call('discoverLists', { source: src, kind, cat, page: state.listPage });
                if (state.src !== src || discoverKind() !== kind) return;
                if (r.unsupported) { state.unsupported = r.unsupported; state.listHasMore = false; }
                else {
                    state.lists = reset ? (r.items || []) : state.lists.concat(r.items || []);
                    state.listHasMore = Boolean(r.hasMore);
                    state.listPage += 1;
                }
            } catch (e) {
                state.error = `加载失败：${e && e.message}`;
            }
            state.listLoading = false;
            render();
        };
        const loadFeed = async () => {
            state.feedLoading = true; state.error = ''; state.feedSongs = [];
            render();
            try {
                const r = await folium.rpc.call('qsFeed', { count: 30 });
                state.feedSongs = (r.songs || []).map(s => platformToProviderSong('qs', s));
                if (!state.feedSongs.length) state.error = '暂无推荐';
            } catch (e) {
                state.error = `推荐加载失败：${e && e.message}`;
            }
            state.feedLoading = false;
            render();
        };
        const openCol = async (item, kind, srcArg) => {
            const src = srcArg || state.src;
            state.colSrc = src;
            state.colMyKey = item.key || null;
            state.col = { ...item, kind };
            state.colSongs = []; state.colTotal = 0; state.colLoading = true; state.error = '';
            render();
            if (Array.isArray(item.songs)) {
                state.colSongs = item.songs.map(s => platformToProviderSong(s.source, s));
                state.colTotal = state.colSongs.length;
                state.colLoading = false;
                if (!state.colSongs.length) state.error = '该列表暂无歌曲';
                render();
                return;
            }
            try {
                const r = await folium.rpc.call('discoverSongs', { source: src, kind, id: item.id });
                if (!state.col || state.col.id !== item.id) return;
                state.colSongs = (r.songs || []).map(s => platformToProviderSong(src, s));
                state.colTotal = r.total || state.colSongs.length;
                const myEntry = state.colMyKey ? state.myLists.find(x => x.key === state.colMyKey) : null;
                const rem = new Set((myEntry && myEntry.removed) || []);
                if (rem.size) {
                    state.colSongs = state.colSongs.filter(s => !rem.has(s.id));
                    state.colTotal = state.colSongs.length;
                }
                const add = (myEntry && myEntry.added) || [];
                if (add.length) {
                    const have = new Set(state.colSongs.map(s => s.id));
                    for (const s of add) {
                        const p = platformToProviderSong(s.source, s);
                        if (!have.has(p.id)) { have.add(p.id); state.colSongs.push(p); }
                    }
                    state.colTotal = state.colSongs.length;
                }
                if (r.name) state.col.name = r.name;
                if (r.picUrl) state.col.picUrl = r.picUrl;
                if (!state.colSongs.length) state.error = '该列表暂无歌曲';
            } catch (e) {
                state.error = `歌曲加载失败：${e && e.message}`;
            }
            state.colLoading = false;
            render();
        };
        const myListsEl = () => {
            const list = el('div', 'lx-list');
            if (state.listLoading && !state.myLists.length) { list.appendChild(el('div', 'lx-msg', '加载中…')); return list; }
            if (state.error && !state.myLists.length) { list.appendChild(el('div', 'lx-msg err', state.error)); return list; }
            if (!state.myLists.length) { list.appendChild(el('div', 'lx-msg', '还没有收藏：上方粘贴链接导入、新建歌单，或在播放页收藏当前歌曲')); return list; }
            const ordered = state.myLists.slice().sort((a, b) => (a.kind === 'like' ? 0 : 1) - (b.kind === 'like' ? 0 : 1));
            for (const item of ordered) {
                const wrap = el('div', 'lx-myitem');
                const row = el('div', 'lx-myrow');
                if (state.myMerge) {
                    const ck = el('input', 'lx-check');
                    ck.type = 'checkbox';
                    ck.checked = state.mySel.includes(item.key);
                    ck.onclick = (e) => { e.stopPropagation(); toggleSel(item.key); };
                    row.appendChild(ck);
                }
                if (item.picUrl) {
                    const img = el('img', 'lx-mycover');
                    img.loading = 'lazy';
                    img.src = item.picUrl;
                    img.onerror = () => img.remove();
                    row.appendChild(img);
                } else row.appendChild(el('span', 'lx-mycover'));
                const meta = el('div', 'lx-meta');
                if (state.renamingKey === item.key) {
                    const inp = el('input', 'lx-input lx-reninput');
                    inp.value = state.renameText;
                    inp.oninput = () => { state.renameText = inp.value; };
                    inp.onkeydown = (e) => {
                        if (e.key === 'Enter') void commitRename(item);
                        else if (e.key === 'Escape') { state.renamingKey = ''; render(); }
                    };
                    meta.appendChild(inp);
                } else {
                    meta.appendChild(el('div', 'lx-name', item.name || `${item.source}:${item.id}`));
                }
                const plat = item.kind === 'merged' ? '合并' : item.kind === 'like' ? '喜欢' : item.kind === 'local' ? '本地' : (PLATFORMS[item.source] ? PLATFORMS[item.source].short : item.source);
                const shownTotal = shownTotalOf(item);
                meta.appendChild(el('div', 'lx-artist', `${plat} · ${item.kind === 'album' ? '专辑' : '歌单'}${shownTotal ? ` · ${shownTotal} 首` : ''}`));
                row.appendChild(meta);
                const acts = el('div', 'lx-acts');
                const bOpen = el('button', 'lx-btn sm ghost', '进入');
                bOpen.onclick = (e) => { e.stopPropagation(); void openCol(item, item.kind, item.source); };
                const bDel = el('button', 'lx-btn sm ghost', '删除');
                bDel.onclick = async (e) => {
                    e.stopPropagation();
                    await folium.rpc.call('removeMyList', { key: item.key }).catch(() => {});
                    state.myLists = state.myLists.filter(x => x.key !== item.key);
                    if (state.renamingKey === item.key) state.renamingKey = '';
                    if (state.colMyKey === item.key) { state.colMyKey = null; state.col = null; state.colSongs = []; }
                    render();
                    toast('已移除收藏');
                };
                if (!state.myMerge) {
                    if (state.renamingKey === item.key) {
                        const bSave = el('button', 'lx-btn sm', '保存');
                        bSave.onclick = (e) => { e.stopPropagation(); void commitRename(item); };
                        const bCancel = el('button', 'lx-btn sm ghost', '取消');
                        bCancel.onclick = (e) => { e.stopPropagation(); state.renamingKey = ''; render(); };
                        acts.appendChild(bSave);
                        acts.appendChild(bCancel);
                    } else {
                        acts.appendChild(bOpen);
                        const bExp = el('button', 'lx-btn sm ghost', '导出');
                        bExp.onclick = (e) => {
                            e.stopPropagation();
                            void (async () => {
                                try {
                                    const r = await folium.rpc.call('exportMyList', { key: item.key });
                                    toast(`已导出 ${r.total} 首：${r.file}`);
                                } catch (err) { toast(`导出失败：${err && err.message}`); }
                            })();
                        };
                        acts.appendChild(bExp);
                        const bRen = el('button', 'lx-btn sm ghost', '重命名');
                        bRen.onclick = (e) => { e.stopPropagation(); state.renamingKey = item.key; state.renameText = item.name || ''; render(); };
                        acts.appendChild(bRen);
                        acts.appendChild(bDel);
                    }
                    row.appendChild(acts);
                }
                row.onclick = () => {
                    if (state.myMerge) { toggleSel(item.key); return; }
                    if (state.renamingKey === item.key) return;
                    void openCol(item, item.kind, item.source);
                };
                wrap.appendChild(row);
                list.appendChild(wrap);
            }
            return list;
        };

        const toggleSel = (key) => {
            state.mySel = state.mySel.includes(key) ? state.mySel.filter(k => k !== key) : state.mySel.concat(key);
            render();
        };
        const commitRename = async (item) => {
            const name = state.renameText.trim();
            if (!name) { toast('名称不能为空'); return; }
            try {
                const entry = await folium.rpc.call('updateMyList', { key: item.key, name });
                state.myLists = state.myLists.map(x => x.key === item.key ? entry : x);
                if (state.colMyKey === item.key && state.col) state.col.name = entry.name;
                state.renamingKey = '';
                toast('已重命名');
            } catch (e) { toast(`重命名失败：${e && e.message}`); }
            render();
        };
        const commitCreateList = async () => {
            const name = state.newListName.trim();
            if (!name) { toast('名称不能为空'); return; }
            try {
                const entry = await folium.rpc.call('createMyList', { name });
                state.myLists = [entry].concat(state.myLists.filter(x => x.key !== entry.key));
                state.creatingList = false; state.newListName = '';
                toast(`已新建「${entry.name}」`);
            } catch (e) { toast(`新建失败：${e && e.message}`); }
            render();
        };
        const removeSongFromCol = async (p) => {
            const entry = state.myLists.find(x => x.key === state.colMyKey);
            if (!entry || state.colLoading) return;
            try {
                let upd, msg;
                if (Array.isArray(entry.songs)) {
                    const songs = entry.songs.filter(s => `${s.source}:${s.id}` !== p.id);
                    upd = await folium.rpc.call('updateMyList', { key: entry.key, songs });
                    msg = `已移出「${p.title}」`;
                } else if ((entry.added || []).some(s => `${s.source}:${s.id}` === p.id)) {
                    const added = entry.added.filter(s => `${s.source}:${s.id}` !== p.id);
                    upd = await folium.rpc.call('updateMyList', { key: entry.key, added });
                    msg = `已移出「${p.title}」（本地加歌）`;
                } else {
                    const removed = (entry.removed || []).concat(p.id);
                    upd = await folium.rpc.call('updateMyList', { key: entry.key, removed });
                    msg = `已移出「${p.title}」（仅本收藏，不影响平台原歌单）`;
                }
                state.myLists = state.myLists.map(x => x.key === entry.key ? upd : x);
                state.colSongs = state.colSongs.filter(s => s.id !== p.id);
                state.colTotal = state.colSongs.length;
                state.error = state.colSongs.length ? '' : '该列表暂无歌曲';
                toast(msg);
            } catch (e) { toast(`移出失败：${e && e.message}`); }
            render();
        };
        const doMerge = async () => {
            if (state.merging || state.mySel.length < 2) return;
            const picked = state.mySel.map(k => state.myLists.find(x => x.key === k)).filter(Boolean);
            if (picked.length < 2) { toast('请先勾选至少两个收藏'); return; }
            state.merging = true; state.error = '';
            render();
            try {
                const seenId = new Set(), seenSong = new Set();
                const songs = [];
                let removed = 0;
                const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
                for (const entry of picked) {
                    let raw;
                    if (Array.isArray(entry.songs)) raw = entry.songs;
                    else {
                        const r = await folium.rpc.call('discoverSongs', { source: entry.source, kind: entry.kind, id: entry.id });
                        raw = (r.songs || []).map(s => ({ ...s, source: entry.source })).concat(entry.added || []);
                    }
                    for (const s of raw) {
                        const src = s.source || entry.source;
                        const p = platformToProviderSong(src, s);
                        const t = norm(p.title), a = norm((p.artists || []).join(','));
                        const k2 = t && a ? `${t}|${a}` : '';
                        if (seenId.has(p.id) || (k2 && seenSong.has(k2))) { removed += 1; continue; }
                        seenId.add(p.id); if (k2) seenSong.add(k2);
                        songs.push({ ...s, source: src });
                    }
                }
                if (!songs.length) throw new Error('所选收藏里没有歌曲');
                const name = picked.map(x => x.name || x.id).join(' + ');
                const entry = await folium.rpc.call('saveMergedList', { name, picUrl: picked[0].picUrl || '', songs });
                state.myLists = [entry].concat(state.myLists.filter(x => x.key !== entry.key));
                state.myMerge = false; state.mySel = [];
                toast(`已合并为「${entry.name}」：${entry.total} 首，去掉 ${removed} 首重复`);
            } catch (e) {
                toast(`合并失败：${e && e.message}`);
            }
            state.merging = false;
            render();
        };
        const doImport = async () => {
            const text = state.importText.trim();
            if (!text || state.importing) return;
            state.importing = true; state.error = '';
            render();
            try {
                const r = await folium.rpc.call('importPlaylist', { url: text });
                if (!r || !r.source || !r.id) throw new Error('无法识别该链接');
                state.src = r.source;
                if (state.view !== 'my') state.view = r.kind === 'album' ? 'album' : 'playlist';
                state.col = null; state.importText = '';
                state.cats = []; state.cat = '';
                state.lists = []; state.listPage = 1; state.listHasMore = false; state.unsupported = '';
                render();
                void (async () => {
                    const kind = r.kind === 'album' ? 'album' : 'playlist';
                    const cats = await loadCats(r.source, kind);
                    if (state.src !== r.source || state.view !== (kind === 'album' ? 'album' : 'playlist')) return;
                    state.cats = cats;
                    state.cat = cats.length ? cats[0].id : '';
                    render();
                    await loadLists(true);
                })();
                await openCol({ id: r.id, name: '', picUrl: '' }, r.kind === 'album' ? 'album' : 'playlist');
                try {
                    const entry = await folium.rpc.call('saveMyList', {
                        source: r.source, kind: r.kind, id: r.id,
                        name: (state.col && state.col.name) || '', picUrl: (state.col && state.col.picUrl) || '', total: state.colTotal,
                    });
                    state.myLists = [entry].concat(state.myLists.filter(x => x.key !== entry.key));
                    state.colMyKey = entry.key;
                } catch { /* 收藏失败不影响导入 */ }
                toast(`已导入 ${PLATFORMS[r.source].label}${r.kind === 'album' ? '专辑' : '歌单'}，可在「我的」找到`);
            } catch (e) {
                toast(`导入失败：${e && e.message}`);
            }
            state.importing = false;
            render();
        };

        const resetDiscover = () => {
            state.col = null; state.colSongs = []; state.colMyKey = null; state.cats = []; state.cat = '';
            state.lists = []; state.listPage = 1; state.listHasMore = false; state.unsupported = ''; state.error = '';
        };
        const enterView = async () => {
            const src = state.src, view = state.view;
            state.myMerge = false; state.mySel = []; state.renamingKey = '';
            if (view === 'my') {
                state.col = null; state.colSongs = []; state.colMyKey = null; state.error = '';
                render();
                await loadMyLists();
                return;
            }
            if (view === 'charts') {
                state.boardId = null; state.songs = []; state.error = '';
                render();
                try {
                    const boards = await loadBoards(src);
                    if (state.src !== src || state.view !== 'charts') return;
                    state.boards = boards;
                    if (boards.length) await loadChart(src, boards[0].id, boards[0].name);
                } catch (e) {
                    state.error = `榜单列表加载失败：${e && e.message}`;
                    render();
                }
                return;
            }
            if (view === 'search') { render(); return; }
            if (view === 'sources') {
                state.scriptsLoading = true; state.editor = null;
                render();
                state.scripts = await refreshScriptOptions();
                state.scriptsLoading = false;
                render();
                return;
            }
            resetDiscover();
            render();
            if (view === 'recommend' && src === 'qs') { await loadFeed(); return; }
            try {
                const kind = discoverKind();
                const cats = await loadCats(src, kind);
                if (state.src !== src || state.view !== view) return;
                state.cats = cats;
                state.cat = cats.length ? cats[0].id : '';
            } catch { /* 分类失败仍可加载默认列表 */ }
            await loadLists(true);
        };

        const filteredSearchItems = () => state.searchItems.filter(s => {
            if (state.searchSrcFilter.length) {
                const p = splitId(s.id);
                if (!p || !state.searchSrcFilter.includes(p.src)) return false;
            }
            if (state.searchSingerFilter && !(s.artists || []).includes(state.searchSingerFilter)) return false;
            return true;
        });

        const doSearch = async (reset) => {
            const q = state.query.trim();
            if (!q) return;
            if (reset) { state.searchItems = []; state.searchOffset = 0; state.searchHasMore = false; state.searchSrcFilter = []; state.searchSingerFilter = ''; }
            state.searching = true; state.error = '';
            render();
            try {
                const r = await mergedSearch(q, { limit: 30, offset: state.searchOffset });
                state.searchItems = reset ? r.items : state.searchItems.concat(r.items);
                state.searchOffset += r.items.length;
                state.searchHasMore = r.hasMore;
                if (!state.searchItems.length) state.error = '没有搜索到结果';
            } catch (e) {
                state.error = `搜索失败：${e && e.message}`;
            }
            state.searching = false;
            render();
        };

        const cardEl = (item) => {
            const card = el('button', 'lx-card');
            if (item.picUrl) {
                const img = el('img');
                img.loading = 'lazy';
                img.src = item.picUrl;
                img.onerror = () => img.remove();
                card.appendChild(img);
            }
            card.appendChild(el('div', 'lx-cardname', item.name || '未命名'));
            const sub = item.playCount ? `${fmtCount(item.playCount)}播放` : (item.trackCount ? `${item.trackCount}首` : (item.desc || item.tag || ''));
            card.appendChild(el('div', 'lx-cardsub', sub));
            card.onclick = () => openCol(item, state.view === 'album' ? 'album' : 'playlist');
            return card;
        };

        const renderNow = () => {
            for (const n of Array.from(root.children)) if (n !== style && n !== toastEl) n.remove();

            const head = el('div', 'lx-head');
            head.appendChild(el('span', 'lx-title', 'Polyphonia · 汇声'));
            const ready = Boolean(settings.get().enabled) && Boolean(status && status.ready);
            // 脚本名称只在音源页露出；其他页仅保留不含名称的未就绪警告
            if (state.view === 'sources' || !ready) {
                head.appendChild(el('span', `lx-chip${ready ? '' : ' bad'}`, ready ? `脚本：${status.scriptName || '就绪'}` : '脚本未就绪'));
            }
            const tabs = el('div', 'lx-tabs');
            for (const [v, label] of [['my', '我的'], ['charts', '榜单'], ['recommend', '推荐'], ['playlist', '歌单'], ['album', '专辑'], ['search', '搜索'], ['sources', '音源']]) {
                const b = el('button', `lx-tab${state.view === v ? ' on' : ''}`, label);
                b.onclick = () => { if (state.view === v) return; state.view = v; void enterView(); };
                tabs.appendChild(b);
            }
            head.appendChild(tabs);
            root.appendChild(head);

            if (state.view !== 'search' && state.view !== 'sources' && state.view !== 'my') {
                const plats = el('div', 'lx-plats');
                for (const s of SRC_ORDER) {
                    const b = el('button', `lx-plat${state.src === s ? ' on' : ''}`, PLATFORMS[s].label);
                    b.onclick = () => { if (state.src === s) return; state.src = s; void enterView(); };
                    plats.appendChild(b);
                }
                root.appendChild(plats);
            }

            if (state.view === 'charts') {
                const body = el('div', 'lx-body');
                const boardsCol = el('div', 'lx-boards');
                for (const b of state.boards || []) {
                    const btn = el('button', `lx-board${state.boardId === b.id ? ' on' : ''}`, b.name);
                    btn.onclick = () => loadChart(state.src, b.id, b.name);
                    boardsCol.appendChild(btn);
                }
                body.appendChild(boardsCol);
                const main = el('div', 'lx-main');
                const toolbar = el('div', 'lx-toolbar');
                toolbar.appendChild(el('span', 'lx-boardname', state.boardName || '选择榜单'));
                toolbar.appendChild(el('span', 'lx-count', state.songs.length ? `${state.songs.length} 首` : ''));
                const spacer = el('span'); spacer.style.flex = '1'; toolbar.appendChild(spacer);
                const bAll = el('button', 'lx-btn', '播放全部');
                bAll.disabled = !state.songs.length;
                bAll.onclick = () => playAll(state.songs.map(s => s.id));
                toolbar.appendChild(bAll);
                main.appendChild(toolbar);
                main.appendChild(songListEl(state.songs, state.loading, state.error, '暂无歌曲'));
                body.appendChild(main);
                root.appendChild(body);
            } else if (state.view === 'search') {
                const main = el('div', 'lx-main');
                const bar = el('div', 'lx-searchbar');
                const input = el('input', 'lx-input');
                input.placeholder = `聚合搜索（${enabledSrcs().map(s => PLATFORMS[s].short).join(' + ') || '未启用任何平台'}）`;
                input.value = state.query;
                input.onkeydown = (e) => { if (e.key === 'Enter') { state.query = input.value; doSearch(true); } };
                const bGo = el('button', 'lx-btn', '搜索');
                bGo.onclick = () => { state.query = input.value; doSearch(true); };
                bar.appendChild(input);
                bar.appendChild(bGo);
                main.appendChild(bar);
                const fItems = filteredSearchItems();
                const toolbar = el('div', 'lx-toolbar');
                toolbar.appendChild(el('span', 'lx-count', state.searchItems.length
                    ? `${fItems.length}${fItems.length !== state.searchItems.length ? `/${state.searchItems.length}` : ''} 首结果`
                    : ''));
                const spacer = el('span'); spacer.style.flex = '1'; toolbar.appendChild(spacer);
                const bAll = el('button', 'lx-btn', '播放全部');
                bAll.disabled = !fItems.length;
                bAll.onclick = () => playAll(fItems.map(s => s.id));
                toolbar.appendChild(bAll);
                main.appendChild(toolbar);
                if (state.searchItems.length) {
                    const fbar = el('div', 'lx-cats');
                    const srcCounts = {};
                    for (const s of state.searchItems) {
                        const p = splitId(s.id);
                        if (p) srcCounts[p.src] = (srcCounts[p.src] || 0) + 1;
                    }
                    const bAllSrc = el('button', `lx-cat${state.searchSrcFilter.length ? '' : ' on'}`, '全部平台');
                    bAllSrc.onclick = () => { state.searchSrcFilter = []; render(); };
                    fbar.appendChild(bAllSrc);
                    for (const s of SRC_ORDER) {
                        if (!srcCounts[s]) continue;
                        const on = state.searchSrcFilter.includes(s);
                        const b = el('button', `lx-cat${on ? ' on' : ''}`, `${PLATFORMS[s].short} ${srcCounts[s]}`);
                        b.onclick = () => {
                            state.searchSrcFilter = on ? state.searchSrcFilter.filter(x => x !== s) : state.searchSrcFilter.concat(s);
                            render();
                        };
                        fbar.appendChild(b);
                    }
                    const singerCounts = new Map();
                    for (const s of state.searchItems) for (const a of s.artists || []) singerCounts.set(a, (singerCounts.get(a) || 0) + 1);
                    const singers = [...singerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
                    if (state.searchSingerFilter && !singers.includes(state.searchSingerFilter)) singers.unshift(state.searchSingerFilter);
                    const sel = el('select', 'lx-select');
                    const oAll = el('option');
                    oAll.value = ''; oAll.textContent = '全部歌手';
                    sel.appendChild(oAll);
                    for (const a of singers) {
                        const o = el('option');
                        o.value = a; o.textContent = `${a} (${singerCounts.get(a) || 0})`;
                        sel.appendChild(o);
                    }
                    sel.value = state.searchSingerFilter;
                    sel.onchange = () => { state.searchSingerFilter = sel.value; render(); };
                    fbar.appendChild(sel);
                    main.appendChild(fbar);
                }
                const list = songListEl(fItems, state.searching, state.error,
                    state.searchItems.length ? '没有符合筛选条件的结果' : '输入关键词，同时搜索多个平台；支持「歌名 歌手」组合提高准确度');
                if (state.searchHasMore && state.searchItems.length) {
                    const foot = el('div', 'lx-foot');
                    const more = el('button', 'lx-btn ghost', state.searching ? '加载中…' : '加载更多');
                    more.disabled = state.searching;
                    more.onclick = () => doSearch(false);
                    foot.appendChild(more);
                    list.appendChild(foot);
                }
                main.appendChild(list);
                root.appendChild(main);
            } else if (state.view === 'sources') {
                const main = el('div', 'lx-main');
                if (state.editor) {
                    const tb = el('div', 'lx-toolbar');
                    const bCancel = el('button', 'lx-btn ghost', '取消');
                    bCancel.onclick = () => { state.editor = null; render(); };
                    tb.appendChild(bCancel);
                    tb.appendChild(el('span', 'lx-boardname', `编辑：${state.editor.file}`));
                    const sp = el('span'); sp.style.flex = '1'; tb.appendChild(sp);
                    const bSave = el('button', 'lx-btn', state.editor.saving ? '保存中…' : '保存');
                    bSave.disabled = state.editor.saving;
                    bSave.onclick = async () => {
                        state.editor.saving = true; render();
                        try {
                            const r = await folium.rpc.call('saveScript', { file: state.editor.file, content: state.editor.content });
                            if (r.status) { status = r.status; syncProvider(); }
                            state.editor = null;
                            state.scripts = await refreshScriptOptions();
                            toast(r.status ? '已保存并重载当前音源' : '已保存');
                        } catch (e) {
                            toast(`保存失败：${e && e.message}`);
                            if (state.editor) state.editor.saving = false;
                        }
                        render();
                    };
                    tb.appendChild(bSave);
                    main.appendChild(tb);
                    const ta = el('textarea', 'lx-editor');
                    ta.value = state.editor.content;
                    ta.spellcheck = false;
                    ta.oninput = () => { if (state.editor) state.editor.content = ta.value; };
                    main.appendChild(ta);
                } else {
                    const tb = el('div', 'lx-toolbar');
                    tb.appendChild(el('span', 'lx-boardname', '音源管理'));
                    tb.appendChild(el('span', 'lx-count', state.scripts.length ? `${state.scripts.length} 个脚本` : ''));
                    const sp = el('span'); sp.style.flex = '1'; tb.appendChild(sp);
                    const fileInput = el('input');
                    fileInput.type = 'file';
                    fileInput.accept = '.js,.txt,text/javascript';
                    fileInput.style.display = 'none';
                    fileInput.onchange = () => {
                        const f = fileInput.files && fileInput.files[0];
                        fileInput.value = '';
                        if (!f) return;
                        const reader = new FileReader();
                        reader.onload = async () => {
                            try {
                                const r = await folium.rpc.call('importScript', { fileName: f.name, content: String(reader.result) });
                                state.scripts = await refreshScriptOptions();
                                toast(`已导入音源：${r.file}，点「设为当前」启用`);
                            } catch (e) { toast(`导入失败：${e && e.message}`); }
                            render();
                        };
                        reader.onerror = () => toast('读取文件失败');
                        reader.readAsText(f);
                    };
                    const bImport = el('button', 'lx-btn', '导入本地脚本');
                    bImport.onclick = () => fileInput.click();
                    tb.appendChild(bImport);
                    main.appendChild(tb);
                    main.appendChild(el('div', 'lx-note', '插件本体不含任何音源，脚本单独保存在模组数据目录（可单独分享插件）。导入后点「设为当前」启用；「编辑」可直接修改脚本内容，保存后自动重载。'));
                    main.appendChild(fileInput);
                    const list = el('div', 'lx-list');
                    if (state.scriptsLoading && !state.scripts.length) list.appendChild(el('div', 'lx-msg', '加载中…'));
                    else if (!state.scripts.length) list.appendChild(el('div', 'lx-msg', '还没有音源脚本：点右上角「导入本地脚本」选择 .js 文件'));
                    else for (const s of state.scripts) {
                        const row = el('div', 'lx-script');
                        const meta = el('div', 'lx-scriptmeta');
                        meta.appendChild(el('div', 'lx-scriptname', `${s.name}${s.version ? ` v${s.version}` : ''}`));
                        meta.appendChild(el('div', 'lx-scriptsub', `${s.file}${s.author ? ` · ${s.author}` : ''}${s.description ? ` · ${s.description}` : ''}`));
                        row.appendChild(meta);
                        const isCurrent = Boolean(status && status.scriptFile === s.file);
                        if (isCurrent) row.appendChild(el('span', 'lx-src', '当前'));
                        const acts = el('div', 'lx-acts');
                        const bUse = el('button', 'lx-btn sm', isCurrent ? '使用中' : '设为当前');
                        bUse.disabled = isCurrent;
                        bUse.onclick = () => { settings.set({ script: s.file }); toast(`已切换音源：${s.name}`); };
                        const bEdit = el('button', 'lx-btn sm ghost', '编辑');
                        bEdit.onclick = async () => {
                            try {
                                const r = await folium.rpc.call('readScript', { file: s.file });
                                state.editor = { file: r.file, content: r.content, saving: false };
                                render();
                            } catch (e) { toast(`读取失败：${e && e.message}`); }
                        };
                        const bDel = el('button', 'lx-btn sm ghost', '删除');
                        bDel.onclick = async () => {
                            if (!confirm(`删除音源「${s.name}」（${s.file}）？此操作不可恢复。`)) return;
                            try {
                                const r = await folium.rpc.call('deleteScript', { file: s.file });
                                if (r.status) { status = r.status; syncProvider(); }
                                if (settings.get().script === s.file) settings.set({ script: '' });
                                state.scripts = await refreshScriptOptions();
                                toast('已删除');
                            } catch (e) { toast(`删除失败：${e && e.message}`); }
                            render();
                        };
                        acts.appendChild(bUse);
                        acts.appendChild(bEdit);
                        acts.appendChild(bDel);
                        row.appendChild(acts);
                        list.appendChild(row);
                    }
                    main.appendChild(list);
                    const stb = el('div', 'lx-toolbar');
                    stb.appendChild(el('span', 'lx-boardname', '偏好设置'));
                    main.appendChild(stb);
                    main.appendChild(el('div', 'lx-note', '设置保存在模组数据目录，旧版设置页的选项已自动迁移到这里。'));
                    const slist = el('div', 'lx-list');
                    const row = (name, sub, control) => {
                        const r = el('div', 'lx-script');
                        const meta = el('div', 'lx-scriptmeta');
                        meta.appendChild(el('div', 'lx-scriptname', name));
                        if (sub) meta.appendChild(el('div', 'lx-scriptsub', sub));
                        r.appendChild(meta);
                        const acts = el('div', 'lx-acts');
                        acts.appendChild(control);
                        r.appendChild(acts);
                        slist.appendChild(r);
                    };
                    const toggle = (key) => {
                        const on = settings.get()[key] !== false;
                        const b = el('button', `lx-btn sm${on ? '' : ' ghost'}`, on ? '开' : '关');
                        b.onclick = () => settings.set({ [key]: !on });
                        return b;
                    };
                    const selOf = (key, options) => {
                        const sel = el('select', 'lx-select');
                        for (const o of options) {
                            const opt = el('option');
                            opt.value = o.value;
                            opt.textContent = o.label && typeof o.label === 'object' ? (o.label['zh-CN'] || o.label.en || '') : String(o.label);
                            sel.appendChild(opt);
                        }
                        sel.value = settings.get()[key];
                        sel.onchange = () => settings.set({ [key]: sel.value });
                        return sel;
                    };
                    row('启用自定义源', '关闭后聚合搜索与播放不再使用自定义音源', toggle('enabled'));
                    row('首选音质', '脚本不支持时自动降档：母带 → Hi-Res → FLAC 24bit → FLAC → 320k → 128k', selOf('quality', QUALITY_OPTIONS));
                    row('播放失败自动换源', '当前平台解析失败时，自动在其他已启用平台搜索同名歌曲重试', toggle('autoSwitch'));
                    for (const s of SRC_ORDER) row(`搜索包含${PLATFORMS[s].label}`, '', toggle(`search${s[0].toUpperCase()}${s.slice(1)}`));
                    main.appendChild(slist);
                }
                root.appendChild(main);
            } else if (state.col) {
                const main = el('div', 'lx-main');
                const ch = el('div', 'lx-colhead');
                const back = el('button', 'lx-btn ghost', '← 返回');
                back.onclick = () => { state.col = null; state.colSongs = []; state.colMyKey = null; state.error = ''; render(); };
                ch.appendChild(back);
                if (state.col.picUrl) {
                    const img = el('img');
                    img.src = state.col.picUrl;
                    img.onerror = () => img.remove();
                    ch.appendChild(img);
                }
                const info = el('div', 'lx-colinfo');
                const csrc = state.colSrc || state.src;
                info.appendChild(el('div', 'lx-colname', state.col.name || '列表'));
                const kindLabel = state.col.kind === 'merged' ? '合并歌单' : state.col.kind === 'like' ? '我喜欢' : state.col.kind === 'local' ? '本地歌单' : (PLATFORMS[csrc] ? PLATFORMS[csrc].label : csrc);
                info.appendChild(el('div', 'lx-colsub', `${kindLabel}${state.colTotal ? ` · ${state.colTotal} 首` : ''}`));
                ch.appendChild(info);
                const myKey = `${csrc}:${state.col.kind}:${state.col.id}`;
                const saved = state.myLists.some(x => x.key === myKey);
                const bFav = el('button', 'lx-btn ghost', saved ? '已收藏 ✓' : '收藏');
                bFav.onclick = async () => {
                    if (saved) {
                        await folium.rpc.call('removeMyList', { key: myKey }).catch(() => {});
                        state.myLists = state.myLists.filter(x => x.key !== myKey);
                        if (state.colMyKey === myKey) state.colMyKey = null;
                        toast('已取消收藏');
                    } else {
                        try {
                            const entry = await folium.rpc.call('saveMyList', {
                                source: csrc, kind: state.col.kind, id: state.col.id,
                                name: state.col.name || '', picUrl: state.col.picUrl || '', total: state.colTotal,
                            });
                            state.myLists = [entry].concat(state.myLists.filter(x => x.key !== entry.key));
                            toast('已收藏到「我的」');
                        } catch (e) { toast(`收藏失败：${e && e.message}`); }
                    }
                    render();
                };
                ch.appendChild(bFav);
                const bAll = el('button', 'lx-btn', '播放全部');
                bAll.disabled = !state.colSongs.length;
                bAll.onclick = () => playAll(state.colSongs.map(s => s.id));
                ch.appendChild(bAll);
                main.appendChild(ch);
                main.appendChild(songListEl(state.colSongs, state.colLoading, state.error, '暂无歌曲', state.colMyKey ? (s) => void removeSongFromCol(s) : null));
                root.appendChild(main);
            } else {
                const main = el('div', 'lx-main');
                const isPlaylistTab = state.view === 'playlist';
                const isAlbumTab = state.view === 'album';
                if (isPlaylistTab || isAlbumTab || state.view === 'my') {
                    const imp = el('div', 'lx-import');
                    const input = el('input', 'lx-input');
                    input.placeholder = '粘贴歌单/专辑链接或分享口令（网易云/QQ/酷狗/酷我/咪咕/汽水）';
                    input.value = state.importText;
                    input.oninput = () => { state.importText = input.value; };
                    input.onkeydown = (e) => { if (e.key === 'Enter') doImport(); };
                    const bImp = el('button', 'lx-btn', state.importing ? '导入中…' : '导入');
                    bImp.disabled = state.importing;
                    bImp.onclick = () => doImport();
                    imp.appendChild(input);
                    imp.appendChild(bImp);
                    main.appendChild(imp);
                }
                if (state.view === 'my') {
                    const mt = el('div', 'lx-toolbar');
                    const bNew = el('button', 'lx-btn sm ghost', '新建歌单');
                    bNew.onclick = () => { state.creatingList = !state.creatingList; state.newListName = ''; render(); };
                    mt.appendChild(bNew);
                    const bMerge = el('button', `lx-btn sm${state.myMerge ? '' : ' ghost'}`, state.myMerge ? '退出合并' : '合并歌单');
                    bMerge.onclick = () => { state.myMerge = !state.myMerge; state.mySel = []; state.renamingKey = ''; render(); };
                    mt.appendChild(bMerge);
                    if (state.myMerge) {
                        mt.appendChild(el('span', 'lx-note', '勾选至少两个收藏，去重后合并为一个新收藏（原收藏保留）'));
                        const bDo = el('button', 'lx-btn sm', state.merging ? '合并中…' : `合并所选（${state.mySel.length}）`);
                        bDo.disabled = state.merging || state.mySel.length < 2;
                        bDo.onclick = () => void doMerge();
                        mt.appendChild(bDo);
                    }
                    main.appendChild(mt);
                    if (state.creatingList) {
                        const cr = el('div', 'lx-import');
                        const inp = el('input', 'lx-input');
                        inp.placeholder = '新建歌单名称';
                        inp.value = state.newListName;
                        inp.oninput = () => { state.newListName = inp.value; };
                        inp.onkeydown = (e) => { if (e.key === 'Enter') void commitCreateList(); };
                        const bOk = el('button', 'lx-btn', '创建');
                        bOk.onclick = () => void commitCreateList();
                        const bNo = el('button', 'lx-btn ghost', '取消');
                        bNo.onclick = () => { state.creatingList = false; render(); };
                        cr.appendChild(inp);
                        cr.appendChild(bOk);
                        cr.appendChild(bNo);
                        main.appendChild(cr);
                    }
                    main.appendChild(myListsEl());
                    root.appendChild(main);
                } else if (state.view === 'recommend' && state.src === 'qs') {
                    const toolbar = el('div', 'lx-toolbar');
                    toolbar.appendChild(el('span', 'lx-boardname', '每日推荐'));
                    toolbar.appendChild(el('span', 'lx-count', state.feedSongs.length ? `${state.feedSongs.length} 首` : ''));
                    const spacer = el('span'); spacer.style.flex = '1'; toolbar.appendChild(spacer);
                    const bRefresh = el('button', 'lx-btn ghost', '换一批');
                    bRefresh.disabled = state.feedLoading;
                    bRefresh.onclick = () => loadFeed();
                    toolbar.appendChild(bRefresh);
                    const bAll = el('button', 'lx-btn', '播放全部');
                    bAll.disabled = !state.feedSongs.length;
                    bAll.onclick = () => playAll(state.feedSongs.map(s => s.id));
                    toolbar.appendChild(bAll);
                    main.appendChild(toolbar);
                    main.appendChild(songListEl(state.feedSongs, state.feedLoading, state.error, '暂无推荐'));
                    root.appendChild(main);
                } else {
                    if (state.cats.length > 1) {
                        const catsRow = el('div', 'lx-cats');
                        for (const c of state.cats) {
                            const b = el('button', `lx-cat${state.cat === c.id ? ' on' : ''}`, c.name);
                            b.title = c.group || '';
                            b.onclick = () => { if (state.cat === c.id) return; state.cat = c.id; void loadLists(true); };
                            catsRow.appendChild(b);
                        }
                        main.appendChild(catsRow);
                    }
                    if (state.view === 'playlist' && state.src === 'qs') {
                        const bar = el('div', 'lx-searchbar');
                        const input = el('input', 'lx-input');
                        input.placeholder = '搜索歌单关键词，如：热门 / 粤语 / 周杰伦';
                        input.value = state.qsKeyword;
                        input.onkeydown = (e) => { if (e.key === 'Enter') { state.qsKeyword = input.value.trim() || '热门'; state.cat = state.qsKeyword; void loadLists(true); } };
                        const bGo = el('button', 'lx-btn', '搜索歌单');
                        bGo.onclick = () => { state.qsKeyword = input.value.trim() || '热门'; state.cat = state.qsKeyword; void loadLists(true); };
                        bar.appendChild(input);
                        bar.appendChild(bGo);
                        main.appendChild(bar);
                    }
                    if (state.unsupported) {
                        main.appendChild(el('div', 'lx-msg', state.unsupported));
                    } else {
                        const grid = el('div', 'lx-grid');
                        if (state.listLoading && !state.lists.length) grid.appendChild(el('div', 'lx-msg', '加载中…'));
                        else if (state.error && !state.lists.length) grid.appendChild(el('div', 'lx-msg err', state.error));
                        else if (!state.lists.length) grid.appendChild(el('div', 'lx-msg', '暂无内容'));
                        else {
                            for (const item of state.lists) grid.appendChild(cardEl(item));
                            if (state.listHasMore) {
                                const foot = el('div', 'lx-foot');
                                foot.style.gridColumn = '1 / -1';
                                const more = el('button', 'lx-btn ghost', state.listLoading ? '加载中…' : '加载更多');
                                more.disabled = state.listLoading;
                                more.onclick = () => loadLists(false);
                                foot.appendChild(more);
                                grid.appendChild(foot);
                            }
                        }
                        main.appendChild(grid);
                    }
                    root.appendChild(main);
                }
            }
            root.appendChild(toastEl);
            if (uiScroll.length) {
                const applyScroll = (n) => {
                    for (const s of uiScroll) if (n.className === s.cls) n.scrollTop = s.top;
                    for (const c of n.children || []) applyScroll(c);
                };
                applyScroll(root);
                uiScroll = [];
            }
        };
        renderImpl = renderNow;
        const render = () => { if (renderImpl) renderImpl(); };

        container.appendChild(root);
        uiRerender = render;
        render();
        void folium.rpc.call('myLists').then(v => { state.myLists = Array.isArray(v) ? v : []; render(); }).catch(() => {});
        if (!uiInited) { uiInited = true; void enterView(); }

        return () => {
            uiScroll = [];
            listsGetter = null; listsSync = null;
            const collect = (n) => {
                if (n.scrollTop > 0) uiScroll.push({ cls: n.className, top: n.scrollTop });
                for (const c of n.children || []) collect(c);
            };
            collect(root);
            if (typeof offTheme === 'function') offTheme();
            renderImpl = null;
            uiRerender = null;
            clearTimeout(toastTimer);
            root.remove();
        };
    };

    // ---- 播放页收藏（进度条按钮 + 播放器面板标签）----
    let listsGetter = null, listsSync = null;
    const readLists = async () => {
        if (listsGetter) return listsGetter();
        const v = await folium.rpc.call('myLists');
        return Array.isArray(v) ? v : [];
    };
    const refreshLists = async () => {
        const v = await folium.rpc.call('myLists');
        const lists = Array.isArray(v) ? v : [];
        if (listsSync) listsSync(lists);
        return lists;
    };
    const hostToast = (msg) => { try { folium.ui.toast(msg); } catch { /* 旧宿主无 ui.toast */ } };
    const currentRawSong = async () => {
        try {
            const st = await folium.playback.getState();
            const s = st && st.song;
            if (!s) return null;
            // 旧宿主 ref 是 {source,id} 的 JSON 串；现宿主 ref 为 song-xxx 不透明句柄，需靠 source+id 识别
            let pid = null;
            if (typeof s.ref === 'string' && s.ref.charAt(0) === '{') {
                const ref = JSON.parse(s.ref);
                if (ref && ref.source === PROVIDER_SOURCE) pid = String(ref.id);
            } else if (s.source === PROVIDER_SOURCE && s.id !== undefined && s.id !== null) {
                pid = String(s.id);
            }
            if (!pid) return null;
            const p = splitId(pid);
            if (!p || !PLATFORMS[p.src]) return null;
            const cached = metaCache.get(pid);
            if (cached) return { ...cached, source: p.src };
            return {
                id: p.hostId, name: s.title || '', singer: s.artist || (s.artists || []).join(' / '),
                picUrl: s.coverUrl || '', intervalSec: s.durationMs ? Math.round(s.durationMs / 1000) : 0,
                albumName: s.album || '', source: p.src,
            };
        } catch { return null; }
    };
    const shownTotalOf = (item) => Array.isArray(item.songs) ? (item.total || 0)
        : Math.max(0, (item.total || 0) - (item.removed || []).length) + (item.added || []).length;
    const collectCurrent = async (key) => {
        const raw = await currentRawSong();
        if (!raw) { hostToast('当前没有正在播放的汇声音源歌曲'); return null; }
        try {
            const r = await folium.rpc.call('addSongToList', { key, song: raw });
            await refreshLists();
            hostToast(r.inserted ? `已收藏到「${r.entry.name}」` : `已在「${r.entry.name}」中`);
            return r;
        } catch (e) { hostToast(`收藏失败：${e && e.message}`); return null; }
    };
    const toggleLikeCurrent = async () => {
        const raw = await currentRawSong();
        if (!raw) { hostToast('当前没有正在播放的汇声音源歌曲'); return; }
        try {
            const like = await folium.rpc.call('ensureLikeList');
            const k = `${raw.source}:${raw.id}`;
            if ((like.songs || []).some(s => `${s.source}:${s.id}` === k)) {
                await folium.rpc.call('updateMyList', { key: like.key, songs: like.songs.filter(s => `${s.source}:${s.id}` !== k) });
                hostToast('已从我喜欢移除');
            } else {
                await folium.rpc.call('addSongToList', { key: like.key, song: raw });
                hostToast('已加入我喜欢');
            }
            await refreshLists();
        } catch (e) { hostToast(`操作失败：${e && e.message}`); }
    };
    const mountProgressButton = (container, ctx, kind) => {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const btn = document.createElement('button');
        btn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:transparent;border:0;cursor:pointer;padding:4px 6px;font-size:12px;font-weight:500;line-height:1;opacity:.6;transition:opacity .15s ease,color .2s ease,transform .1s ease;';
        const icon = document.createElementNS(SVG_NS, 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('width', '15');
        icon.setAttribute('height', '15');
        icon.style.cssText = 'display:block;flex:none;';
        const shape = document.createElementNS(SVG_NS, 'path');
        shape.setAttribute('d', kind === 'like'
            ? 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z'
            : 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z');
        shape.setAttribute('fill', 'none');
        shape.setAttribute('stroke', 'currentColor');
        shape.setAttribute('stroke-width', '2');
        shape.setAttribute('stroke-linecap', 'round');
        shape.setAttribute('stroke-linejoin', 'round');
        icon.appendChild(shape);
        btn.appendChild(icon);
        if (kind === 'collect') btn.appendChild(document.createElement('span')).textContent = '收藏';
        container.appendChild(btn);
        let alive = true, liked = false, hovered = false;
        const getColors = () => { try { return (ctx && ctx.getColors && ctx.getColors()) || {}; } catch { return {}; } };
        const paintOpacity = () => { btn.style.opacity = hovered || liked ? '1' : '.6'; };
        const paint = async () => {
            if (!alive) return;
            const c = getColors();
            const text = c.text || 'inherit';
            if (kind === 'collect') {
                btn.style.color = text;
                btn.title = '收藏当前歌曲到指定歌单';
                paintOpacity();
                return;
            }
            const raw = await currentRawSong();
            const lists = await readLists();
            const like = lists.find(x => x.kind === 'like');
            liked = Boolean(raw && like && (like.songs || []).some(s => `${s.source}:${s.id}` === `${raw.source}:${raw.id}`));
            shape.setAttribute('fill', liked ? 'currentColor' : 'none');
            btn.style.color = liked ? (c.fill || text) : text;
            btn.title = liked ? '从我喜欢移除' : '加入我喜欢';
            paintOpacity();
        };
        btn.onmouseenter = () => { hovered = true; paintOpacity(); };
        btn.onmouseleave = () => { hovered = false; paintOpacity(); };
        btn.onmousedown = () => { btn.style.transform = 'scale(.92)'; };
        btn.onmouseup = () => { btn.style.transform = ''; };
        btn.onclick = () => {
            if (kind === 'collect') {
                try {
                    // 宿主面板只在播放页渲染，首页开面板会隐藏首页却看不到面板；navigateToPlayer 无幂等守卫，仅在非播放页时跳转
                    if (window.location.hash !== '#player') folium.ui.navigate('player');
                    folium.ui.openPlayerPanel('collect');
                } catch { /* 旧宿主无面板接口 */ }
                return;
            }
            void toggleLikeCurrent().then(paint);
        };
        // Folium 2 移除了 ctx.subscribe（调用会弹弃用警告），优先 onChange；1.7 无 onChange 时回退，另有 1.5s 轮询兜底
        const listen = ctx && (ctx.onChange || ctx.subscribe);
        const unsub = listen ? listen.call(ctx, () => void paint()) : null;
        const timer = setInterval(() => void paint(), 1500);
        void paint();
        return () => {
            alive = false; clearInterval(timer);
            if (typeof unsub === 'function') unsub();
            btn.remove();
        };
    };
    const mountCollectPanel = (container) => {
        const root = document.createElement('div');
        root.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:8px;color:inherit;font-size:13px;';
        container.appendChild(root);
        let alive = true, painting = false;
        const rowBtn = (label, sub) => {
            const b = document.createElement('button');
            b.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;text-align:left;font-size:13px;';
            b.appendChild(document.createElement('span')).textContent = label;
            b.appendChild(document.createElement('span')).textContent = sub || '';
            return b;
        };
        const paint = async () => {
            if (!alive || painting) return;
            painting = true;
            try {
                const raw = await currentRawSong();
                const lists = await readLists();
                while (root.children.length) root.children[0].remove();
                const head = document.createElement('div');
                head.style.cssText = 'font-size:14px;font-weight:600;';
                head.textContent = raw ? `${raw.name} - ${raw.singer || '未知歌手'}` : '当前没有正在播放的汇声音源歌曲';
                root.appendChild(head);
                root.appendChild(document.createElement('div')).textContent = '收藏当前歌曲到：';
                const like = lists.find(x => x.kind === 'like');
                const bLike = rowBtn('我喜欢', like ? `${shownTotalOf(like)} 首` : '首次收藏时自动创建');
                bLike.onclick = () => void (async () => {
                    const target = like || await folium.rpc.call('ensureLikeList');
                    await collectCurrent(target.key);
                    void paint();
                })();
                root.appendChild(bLike);
                for (const item of lists.filter(x => x.kind !== 'like')) {
                    const b = rowBtn(item.name || item.id, `${shownTotalOf(item)} 首`);
                    b.onclick = () => void collectCurrent(item.key).then(paint);
                    root.appendChild(b);
                }
                const createRow = document.createElement('div');
                createRow.style.cssText = 'display:flex;gap:6px;';
                const inp = document.createElement('input');
                inp.placeholder = '新建歌单名称';
                inp.style.cssText = 'flex:1;min-width:0;padding:6px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font-size:13px;outline:none;';
                const bCreate = document.createElement('button');
                bCreate.textContent = '新建并收藏';
                bCreate.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;cursor:pointer;font-size:13px;';
                bCreate.onclick = () => void (async () => {
                    const name = inp.value.trim();
                    if (!name) { hostToast('名称不能为空'); return; }
                    try {
                        const entry = await folium.rpc.call('createMyList', { name });
                        await collectCurrent(entry.key);
                        await refreshLists();
                        void paint();
                    } catch (e) { hostToast(`新建失败：${e && e.message}`); }
                })();
                createRow.appendChild(inp);
                createRow.appendChild(bCreate);
                root.appendChild(createRow);
                root.appendChild(document.createElement('div')).textContent = '本地增删只影响本插件收藏，不修改平台歌单';
            } finally { painting = false; }
        };
        const timer = setInterval(() => void paint(), 1500);
        void paint();
        return () => { alive = false; clearInterval(timer); root.remove(); };
    };

    const homeTabHandle = folium.registries.homeTabs.register({
        id: 'lx-home',
        label: L('发现', 'Discover'),
        order: 10,
        mount: mountHome,
    });
    const progressLikeHandle = folium.registries.progressButtons && folium.registries.progressButtons.register({
        id: 'like', slot: 'progress.trailing', order: 40, hideWhenCollapsed: true,
        mount: (c, ctx) => mountProgressButton(c, ctx, 'like'),
    });
    const progressCollectHandle = folium.registries.progressButtons && folium.registries.progressButtons.register({
        id: 'collect', slot: 'progress.trailing', order: 41, hideWhenCollapsed: true,
        mount: (c, ctx) => mountProgressButton(c, ctx, 'collect'),
    });
    const panelHandle = folium.registries.playerPanelTabs && folium.registries.playerPanelTabs.register({
        id: 'collect', label: L('汇声收藏', 'Collect'), order: 40,
        mount: mountCollectPanel,
    });

    return () => {
        disposeSettings();
        if (providerHandle) providerHandle.unregister();
        homeTabHandle.unregister();
        if (progressLikeHandle) progressLikeHandle.unregister();
        if (progressCollectHandle) progressCollectHandle.unregister();
        if (panelHandle) panelHandle.unregister();
    };
}