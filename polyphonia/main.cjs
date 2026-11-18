/* Polyphonia · 汇声 — main 入口：在 vm 沙箱里运行 LX Music 格式的自定义源脚本。 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const nodeCrypto = require('node:crypto');

const ALL_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'qs', 'local'];
const SUPPORT_QUALITYS = ['128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'spatial'];
const REQUEST_TIMEOUT_MS = 30000;

module.exports = function activate(api) {
    const dataDir = api.storage.paths.data;
    const logFile = path.join(dataDir, 'polyphonia.log');

    const debug = (...args) => {
        const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
        try { fs.appendFileSync(logFile, line); } catch { /* 日志失败不影响功能 */ }
    };

    const state = {
        scriptFile: null,
        scriptInfo: null,
        sources: null,
        requestHandler: null,
        ready: false,
        error: null,
        timers: new Set(),
        intervals: new Set(),
        pendingCancels: new Set(),
    };

    const parseScriptInfo = (raw) => {
        const header = /^\/\*[\S\s]+?\*\//.exec(raw);
        if (!header) throw new Error('无效的自定义源文件：缺少头部注释');
        const info = { name: '', description: '', version: '', author: '', homepage: '' };
        for (const line of header[0].split(/\r?\n/)) {
            const m = /^\s?\*\s?@(\w+)\s(.+)$/.exec(line);
            if (m && m[1] in info) info[m[1]] = m[2].trim();
        }
        if (!info.name) info.name = '未命名音源';
        return info;
    };

    const listScripts = () => {
        let files = [];
        try { files = fs.readdirSync(dataDir).filter(f => f.toLowerCase().endsWith('.js')); } catch { return []; }
        const out = [];
        for (const file of files) {
            try {
                const raw = fs.readFileSync(path.join(dataDir, file), 'utf8');
                const info = parseScriptInfo(raw);
                out.push({ file, name: info.name, version: info.version, description: info.description, author: info.author });
            } catch (e) {
                out.push({ file, name: file, version: '', description: `无法解析：${e.message}`, author: '' });
            }
        }
        return out;
    };

    const hasHeader = (headers, name) => Object.keys(headers).some(k => k.toLowerCase() === name);

    const decodeBody = (raw, encoding) => {
        const enc = String(encoding || '').toLowerCase();
        try {
            if (enc === 'gzip') return zlib.gunzipSync(raw);
            if (enc === 'deflate') return zlib.inflateSync(raw);
            if (enc === 'br') return zlib.brotliDecompressSync(raw);
        } catch { /* 解压失败按原文处理 */ }
        return raw;
    };

    // needle 风格的 HTTP 请求：自动跟随重定向、解压 gzip/deflate/br、JSON 自动解析。
    const lxRequest = (url, options, callback) => {
        options = options || {};
        let aborted = false;
        let currentReq = null;
        const finish = (err, resp, body) => {
            if (aborted) return;
            try { callback(err, resp, body); } catch (e) { debug('request callback threw:', e.message); }
        };
        const doRequest = (targetUrl, redirectsLeft) => {
            let u;
            try { u = new URL(targetUrl); } catch (e) { return finish(e, null, null); }
            const lib = u.protocol === 'https:' ? https : http;
            const method = String(options.method || 'get').toUpperCase();
            const headers = Object.assign({}, options.headers || {});
            let body = null;
            if (options.body != null) {
                if (Buffer.isBuffer(options.body)) body = options.body;
                else if (typeof options.body === 'object') {
                    body = Buffer.from(JSON.stringify(options.body));
                    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
                } else body = Buffer.from(String(options.body));
            } else if (options.form) {
                body = Buffer.from(new URLSearchParams(options.form).toString());
                if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
            } else if (options.formData) {
                const boundary = '----lxform' + nodeCrypto.randomBytes(8).toString('hex');
                const parts = [];
                for (const [k, v] of Object.entries(options.formData)) {
                    if (v && typeof v === 'object' && v.value != null) {
                        const filename = (v.options && v.options.filename) || 'file';
                        const contentType = (v.options && v.options.contentType) || 'application/octet-stream';
                        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
                        parts.push(Buffer.isBuffer(v.value) ? v.value : Buffer.from(String(v.value)));
                        parts.push(Buffer.from('\r\n'));
                    } else {
                        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
                    }
                }
                parts.push(Buffer.from(`--${boundary}--\r\n`));
                body = Buffer.concat(parts);
                headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
            }
            if (body && !hasHeader(headers, 'content-length')) headers['Content-Length'] = body.length;
            if (!hasHeader(headers, 'accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate, br';
            const timeout = typeof options.timeout === 'number' && options.timeout > 0 ? Math.min(options.timeout, 60000) : 60000;
            const req = lib.request(u, { method, headers }, (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
                    res.resume();
                    const next = new URL(res.headers.location, u).toString();
                    // 重定向时按浏览器惯例丢弃 body，方法改 GET（307/308 除外）
                    if (status !== 307 && status !== 308) { options = Object.assign({}, options, { body: null, form: null, formData: null, method: 'get' }); }
                    doRequest(next, redirectsLeft - 1);
                    return;
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('error', (e) => finish(e, null, null));
                res.on('end', () => {
                    const raw = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']);
                    let parsed = raw.toString();
                    try { parsed = JSON.parse(parsed); } catch { /* 保留文本 */ }
                    finish(null, {
                        statusCode: status,
                        statusMessage: res.statusMessage,
                        headers: res.headers,
                        bytes: raw.length,
                        raw,
                        body: parsed,
                    }, parsed);
                });
            });
            currentReq = req;
            req.on('error', (e) => finish(e, null, null));
            req.setTimeout(timeout, () => req.destroy(new Error(`request timeout after ${timeout}ms`)));
            if (body) req.write(body);
            req.end();
        };
        doRequest(url, 5);
        const cancel = () => { aborted = true; if (currentReq) currentReq.destroy(); };
        state.pendingCancels.add(cancel);
        return () => { state.pendingCancels.delete(cancel); cancel(); };
    };

    const teardownScript = () => {
        for (const t of state.timers) clearTimeout(t);
        for (const t of state.intervals) clearInterval(t);
        for (const c of state.pendingCancels) { try { c(); } catch { /* ignore */ } }
        state.timers.clear();
        state.intervals.clear();
        state.pendingCancels.clear();
        state.requestHandler = null;
        state.sources = null;
        state.ready = false;
    };

    const loadScript = async (file) => {
        teardownScript();
        state.scriptFile = file || null;
        state.error = null;
        state.scriptInfo = null;
        if (!file) { state.error = '未选择脚本'; return status(); }
        const full = path.join(dataDir, file);
        let raw;
        try { raw = fs.readFileSync(full, 'utf8'); } catch (e) {
            state.error = `读取脚本失败：${e.message}`;
            debug(state.error);
            return status();
        }
        let info;
        try { info = parseScriptInfo(raw); } catch (e) {
            state.error = e.message;
            debug(state.error);
            return status();
        }
        state.scriptInfo = info;
        debug('loading script', file, info.name, info.version);

        const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
        let inited = false;
        let updateAlertShown = false;
        let resolveInit;
        const initPromise = new Promise((r) => { resolveInit = r; });

        const lx = {
            EVENT_NAMES,
            version: '2.0.0',
            env: 'desktop',
            currentScriptInfo: {
                name: info.name,
                description: info.description,
                version: info.version,
                author: info.author,
                homepage: info.homepage,
                rawScript: raw,
            },
            request: lxRequest,
            send(eventName, data) {
                return new Promise((resolve, reject) => {
                    if (eventName === EVENT_NAMES.inited) {
                        if (inited) return reject(new Error('Script is inited'));
                        inited = true;
                        try {
                            const sources = {};
                            for (const key of ALL_SOURCES) {
                                const s = data && data.sources && data.sources[key];
                                if (!s || s.type !== 'music') continue;
                                const qualitys = key === 'local' ? [] : SUPPORT_QUALITYS.filter(q => Array.isArray(s.qualitys) && s.qualitys.includes(q));
                                const allowedActions = key === 'local' ? ['musicUrl', 'lyric', 'pic'] : ['musicUrl'];
                                sources[key] = {
                                    type: 'music',
                                    name: s.name || key,
                                    actions: allowedActions.filter(a => Array.isArray(s.actions) && s.actions.includes(a)),
                                    qualitys,
                                };
                            }
                            state.sources = sources;
                            state.ready = true;
                            debug('inited, sources:', Object.keys(sources).map(k => `${k}(${sources[k].qualitys.join(',')})`).join(' '));
                            resolveInit(true);
                            resolve();
                        } catch (e) {
                            state.error = `inited 处理失败：${e.message}`;
                            debug(state.error);
                            resolveInit(false);
                            reject(e);
                        }
                    } else if (eventName === EVENT_NAMES.updateAlert) {
                        if (updateAlertShown) return reject(new Error('The update alert can only be called once.'));
                        updateAlertShown = true;
                        debug('updateAlert:', data && data.log);
                        api.log.info(`源更新提示：${(data && data.log) || ''}`);
                        resolve();
                    } else {
                        reject(new Error('The event is not supported: ' + eventName));
                    }
                });
            },
            on(eventName, handler) {
                if (eventName === EVENT_NAMES.request) {
                    state.requestHandler = handler;
                    return Promise.resolve();
                }
                return Promise.reject(new Error('The event is not supported: ' + eventName));
            },
            utils: {
                crypto: {
                    aesEncrypt(buffer, mode, key, iv) {
                        const cipher = nodeCrypto.createCipheriv(mode, key, iv);
                        return Buffer.concat([cipher.update(buffer), cipher.final()]);
                    },
                    rsaEncrypt(buffer, key) {
                        buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
                        return nodeCrypto.publicEncrypt({ key, padding: nodeCrypto.constants.RSA_NO_PADDING }, buffer);
                    },
                    randomBytes(size) { return nodeCrypto.randomBytes(size); },
                    md5(str) { return nodeCrypto.createHash('md5').update(str).digest('hex'); },
                },
                buffer: {
                    from(...args) { return Buffer.from(...args); },
                    bufToString(buf, format) { return Buffer.from(buf, 'binary').toString(format); },
                },
                zlib: {
                    inflate(buf) { return new Promise((res, rej) => zlib.inflate(buf, (e, d) => (e ? rej(new Error(e.message)) : res(d)))); },
                    deflate(buf) { return new Promise((res, rej) => zlib.deflate(buf, (e, d) => (e ? rej(new Error(e.message)) : res(d)))); },
                },
            },
        };

        const scriptConsole = {
            log: (...a) => debug('[script]', ...a.map(String)),
            info: (...a) => debug('[script]', ...a.map(String)),
            warn: (...a) => debug('[script][warn]', ...a.map(String)),
            error: (...a) => debug('[script][error]', ...a.map(String)),
            debug: (...a) => debug('[script]', ...a.map(String)),
        };
        const sandbox = {
            lx,
            console: scriptConsole,
            Buffer,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            setTimeout: (fn, ms, ...args) => {
                const t = setTimeout(() => { state.timers.delete(t); fn(...args); }, ms);
                state.timers.add(t);
                return t;
            },
            clearTimeout: (t) => { state.timers.delete(t); clearTimeout(t); },
            setInterval: (fn, ms, ...args) => {
                const t = setInterval(fn, ms, ...args);
                state.intervals.add(t);
                return t;
            },
            clearInterval: (t) => { state.intervals.delete(t); clearInterval(t); },
            queueMicrotask,
            structuredClone,
            performance,
            fetch: (...args) => fetch(...args),
            atob: (s) => Buffer.from(s, 'base64').toString('binary'),
            btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
            crypto: nodeCrypto.webcrypto,
        };
        sandbox.globalThis = sandbox;
        const ctx = vm.createContext(sandbox);
        try {
            vm.runInContext(raw, ctx, { timeout: 15000, filename: file });
        } catch (e) {
            state.error = `脚本执行失败：${e.message}`;
            debug(state.error);
            return status();
        }
        // inited 可能在异步任务里发出，最多等 10 秒
        const ok = await Promise.race([initPromise, new Promise(r => setTimeout(() => r(false), 10000))]);
        if (!ok && !state.ready) {
            state.error = state.error || '脚本未发送 inited 事件（10 秒超时）';
            debug(state.error);
        }
        return status();
    };

    const status = () => ({
        scriptFile: state.scriptFile,
        scriptName: state.scriptInfo ? state.scriptInfo.name : null,
        ready: state.ready,
        sources: state.sources,
        error: state.error,
        dataDir,
    });

    const requestMusicUrl = async ({ source, type, musicInfo }) => {
        if (!state.ready || !state.requestHandler) throw new Error(state.error || '脚本未加载');
        const src = state.sources && state.sources[source];
        if (!src) throw new Error(`脚本不支持源 ${source}`);
        if (!src.actions.includes('musicUrl')) throw new Error(`源 ${source} 不支持 musicUrl`);
        const quality = src.qualitys.includes(type) ? type : (src.qualitys[src.qualitys.length - 1] || '128k');
        debug('musicUrl request', source, quality, JSON.stringify(musicInfo).slice(0, 300));
        const started = Date.now();
        let timer;
        const result = await Promise.race([
            Promise.resolve().then(() => state.requestHandler({ source, action: 'musicUrl', info: { type: quality, musicInfo } })),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`脚本解析超时（${REQUEST_TIMEOUT_MS / 1000}s）`)), REQUEST_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        if (typeof result !== 'string' || !/^https?:/.test(result) || result.length > 2048) {
            throw new Error('脚本返回的链接无效');
        }
        debug('musicUrl ok', source, `${Date.now() - started}ms`, result.slice(0, 120));
        return result;
    };

    // QQ 数字 id → songmid（LX 脚本需要 mid；宿主只暴露数字 id 时的兜底）
    const midCache = new Map();
    const resolveTxMid = async (id) => {
        const key = String(id);
        if (midCache.has(key)) return midCache.get(key);
        const url = `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songid=${encodeURIComponent(key)}&format=json&tpl=yqq_song_detail`;
        const resp = await fetch(url, {
            headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(8000),
        });
        const data = await resp.json();
        const mid = data && data.data && data.data[0] && data.data[0].mid;
        if (typeof mid !== 'string' || !mid) throw new Error(`未找到歌曲 ${key} 的 mid`);
        midCache.set(key, mid);
        debug('txMid', key, '->', mid);
        return mid;
    };

    // ---- 榜单数据层（接口与 LX Music musicSdk 一致，公开无需登录） ----
    const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const chartCache = new Map();
    const withCache = async (key, ttlMs, fn) => {
        const hit = chartCache.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value;
        const value = await fn();
        chartCache.set(key, { at: Date.now(), value });
        return value;
    };
    const chartJson = async (url, opt = {}) => {
        const resp = await fetch(url, {
            signal: AbortSignal.timeout(15000),
            ...opt,
            headers: { 'User-Agent': UA_PC, ...(opt.headers || {}) },
        });
        if (!resp.ok) throw new Error(`榜单接口 HTTP ${resp.status}`);
        return resp.json();
    };

    const WY_BOARDS = [
        { id: '19723756', name: '飙升榜' }, { id: '3778678', name: '热歌榜' },
        { id: '3779629', name: '新歌榜' }, { id: '2884035', name: '原创榜' },
        { id: '991319590', name: '说唱榜' }, { id: '71384707', name: '古典榜' },
        { id: '1978921795', name: '电音榜' }, { id: '71385702', name: 'ACG榜' },
        { id: '745956260', name: '韩语榜' }, { id: '5059661515', name: '民谣榜' },
        { id: '5059642708', name: '国风榜' }, { id: '5059633707', name: '摇滚榜' },
        { id: '2809513713', name: '欧美热歌榜' }, { id: '60198', name: 'Billboard榜' },
        { id: '60131', name: 'Oricon榜' }, { id: '180106', name: 'UK榜' },
    ];
    const TX_BOARDS_FALLBACK = [
        { id: '4', name: '流行指数' }, { id: '26', name: '热歌' }, { id: '27', name: '新歌' },
        { id: '62', name: '飙升' }, { id: '58', name: '说唱' }, { id: '57', name: '电音' },
        { id: '28', name: '网络歌曲' }, { id: '5', name: '内地' }, { id: '3', name: '欧美' },
        { id: '59', name: '港台' }, { id: '16', name: '韩国' }, { id: '17', name: '日本' },
        { id: '60', name: '抖快' }, { id: '29', name: '影视' }, { id: '52', name: '原创' },
        { id: '65', name: '国风' }, { id: '72', name: '动漫' }, { id: '73', name: '游戏' },
    ];
    const KG_BOARDS_FALLBACK = [
        { id: '8888', name: 'TOP500' }, { id: '6666', name: '飙升榜' }, { id: '52144', name: '抖音热歌榜' },
        { id: '52767', name: '快手热歌榜' }, { id: '24971', name: 'DJ热歌榜' }, { id: '23784', name: '网络红歌榜' },
        { id: '44412', name: '说唱榜' }, { id: '31308', name: '内地榜' }, { id: '33160', name: '电音榜' },
    ];
    const KW_BOARDS = [
        { id: '93', name: '飙升榜' }, { id: '16', name: '热歌榜' }, { id: '17', name: '新歌榜' },
        { id: '158', name: '抖音热歌榜' }, { id: '145', name: '会员畅听榜' }, { id: '187', name: '流行趋势榜' },
        { id: '26', name: '经典怀旧榜' }, { id: '104', name: '华语榜' }, { id: '182', name: '粤语榜' },
        { id: '22', name: '欧美榜' }, { id: '184', name: '韩语榜' }, { id: '183', name: '日语榜' },
        { id: '64', name: '影视金曲榜' }, { id: '278', name: '古风音乐榜' }, { id: '242', name: '电音榜' },
        { id: '12', name: 'Billboard榜' },
    ];

    const fetchBoards = (src) => withCache(`boards:${src}`, 60 * 60 * 1000, async () => {
        if (src === 'wy') return WY_BOARDS;
        if (src === 'tx') {
            try {
                const d = await chartJson('https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?g_tk=1928093487&inCharset=utf-8&outCharset=utf-8&notice=0&format=json&uin=0&needNewCode=1&platform=h5', { headers: { Referer: 'https://y.qq.com/' } });
                const list = (d.data && d.data.topList || []).filter(b => b.id !== 201).map(b => ({ id: String(b.id), name: String(b.topTitle || '').replace(/^巅峰榜·/, ''), picUrl: b.picUrl || '' }));
                if (list.length) return list;
            } catch (e) { debug('tx boards fallback:', e.message); }
            return TX_BOARDS_FALLBACK;
        }
        if (src === 'kg') {
            try {
                const d = await chartJson('http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1');
                const list = (d.data && d.data.info || []).filter(b => b.isvol === 1).map(b => ({ id: String(b.rankid), name: b.rankname, picUrl: (b.imgurl || '').replace('{size}', '400') }));
                if (list.length) return list;
            } catch (e) { debug('kg boards fallback:', e.message); }
            return KG_BOARDS_FALLBACK;
        }
        if (src === 'kw') return KW_BOARDS;
        throw new Error(`不支持的榜单平台 ${src}`);
    });

    const fetchWySongs = async (boardId) => {
        const r = await fetchWyPlaylistSongs(boardId);
        return r.songs;
    };

    const fetchTxSongs = async (boardId) => {
        const body = JSON.stringify({
            toplist: { module: 'musicToplist.ToplistInfoServer', method: 'GetDetail', param: { topid: Number(boardId), num: 300, period: '' } },
            comm: { uin: 0, format: 'json', ct: 20, cv: 1859 },
        });
        const d = await chartJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
            method: 'POST',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)', 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
            body,
        });
        const list = d.toplist && d.toplist.data && d.toplist.data.songInfoList;
        if (!Array.isArray(list)) throw new Error('QQ榜单返回异常');
        return list.map(s => {
            const albumMid = (s.album && s.album.mid) || '';
            const singerMid = s.singer && s.singer[0] && s.singer[0].mid;
            return {
                id: String(s.id),
                name: s.title || '',
                singer: (s.singer || []).map(a => a.name).filter(Boolean).join(' / '),
                albumName: (s.album && s.album.name) || '',
                albumId: albumMid,
                intervalSec: s.interval || 0,
                picUrl: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : (singerMid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${singerMid}.jpg` : ''),
                meta: { songmid: s.mid || '', strMediaMid: (s.file && s.file.media_mid) || s.mid || '' },
            };
        });
    };

    const fetchKgSongs = async (boardId) => {
        const songs = [];
        let total = 0;
        for (let page = 1; page <= 5; page++) {
            const d = await chartJson(`http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=100&area_code=1&page=${page}&rankid=${encodeURIComponent(boardId)}&with_res_tag=0&show_portrait_mv=1`);
            const info = d.data && d.data.info;
            if (!Array.isArray(info) || !info.length) break;
            total = d.data.total || info.length;
            for (const it of info) {
                songs.push({
                    id: String(it.hash || '').toUpperCase(),
                    name: it.songname || '',
                    singer: (it.authors || []).map(a => a.author_name).filter(Boolean).join(' / '),
                    albumName: it.remark || '',
                    albumId: String(it.album_id || ''),
                    intervalSec: it.duration || 0,
                    picUrl: (it.album_sizable_cover || '').replace('{size}', '400'),
                    meta: { album_audio_id: it.album_audio_id || '', audio_id: it.audio_id || '', album_id: String(it.album_id || '') },
                });
            }
            if (songs.length >= total) break;
        }
        if (!songs.length) throw new Error('酷狗榜单返回为空');
        return songs;
    };

    const fetchKwSongs = async (boardId) => {
        const d = await chartJson(`http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=0&rn=300&type=bang&data=content&id=${encodeURIComponent(boardId)}&show_copyright_off=0&pcmp4=1&isbang=1`);
        const list = d.musiclist;
        if (!Array.isArray(list) || !list.length) throw new Error('酷我榜单返回为空');
        const songs = list.map(it => mapKwRaw(it));
        await fillKwPics(songs);
        return songs;
    };

    const fetchChartSongs = (src, boardId) => withCache(`songs:${src}:${boardId}`, 10 * 60 * 1000, async () => {
        const songs = src === 'wy' ? await fetchWySongs(boardId) : src === 'tx' ? await fetchTxSongs(boardId) : src === 'kg' ? await fetchKgSongs(boardId) : src === 'kw' ? await fetchKwSongs(boardId) : null;
        if (!songs) throw new Error(`不支持的榜单平台 ${src}`);
        debug('chartSongs', src, boardId, songs.length);
        return { songs, total: songs.length };
    });

    // ---- 发现数据层：推荐 / 歌单 / 专辑（公开接口，无需登录） ----
    const WY_HEADERS = { Referer: 'https://music.163.com/', Cookie: 'os=pc; appver=8.9.70;' };
    const KG_HEADERS = { Referer: 'http://www.kugou.com/' };
    const txMusicu = (req, comm) => chartJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
        body: JSON.stringify({ ...req, comm: comm || { uin: 0, format: 'json', ct: 20, cv: 1859 } }),
    });
    const txMusicuGet = (req) => chartJson('https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&platform=wk_v15.json&needNewCode=0&data=' + encodeURIComponent(JSON.stringify({ ...req, comm: { cv: 1602, ct: 20 } })), { headers: { Referer: 'https://y.qq.com/' } });
    const htmlUnescape = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

    const mapWyTrack = (t) => {
        const artists = t.artists || t.ar || [];
        const album = t.album || t.al || {};
        const duration = t.duration || t.dt || 0;
        return {
            id: String(t.id),
            name: t.name || '',
            singer: artists.map(a => a.name).filter(Boolean).join(' / '),
            albumName: album.name || '',
            albumId: String(album.id || ''),
            intervalSec: Math.round(duration / 1000),
            picUrl: String(album.picUrl || album.pic_str || '').replace(/^http:/, 'https:'),
            meta: {},
        };
    };
    const mapTxSong = (s) => {
        const albumMid = (s.album && s.album.mid) || '';
        const singerMid = s.singer && s.singer[0] && s.singer[0].mid;
        return {
            id: String(s.id),
            name: s.title || s.name || '',
            singer: (s.singer || []).map(a => a.name).filter(Boolean).join(' / '),
            albumName: (s.album && s.album.name) || '',
            albumId: albumMid,
            intervalSec: s.interval || 0,
            picUrl: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : (singerMid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${singerMid}.jpg` : ''),
            meta: { songmid: s.mid || '', strMediaMid: (s.file && s.file.media_mid) || s.mid || '' },
        };
    };
    // 酷狗歌单/专辑接口只给 "歌手 - 歌名" 拼接串
    const mapKgFile = (it) => {
        const fn = String(it.filename || '');
        const sep = fn.indexOf(' - ');
        const singer = sep > 0 ? fn.slice(0, sep).split('、').join(' / ') : '';
        const name = sep > 0 ? fn.slice(sep + 3) : fn;
        const cover = (it.trans_param && it.trans_param.union_cover) || it.album_sizable_cover || '';
        return {
            id: String(it.hash || '').toUpperCase(),
            name,
            singer,
            albumName: it.remark || '',
            albumId: String(it.album_id || ''),
            intervalSec: it.duration || 0,
            picUrl: cover.replace('{size}', '400'),
            meta: { album_audio_id: it.album_audio_id || '', audio_id: it.audio_id || '', album_id: String(it.album_id || '') },
        };
    };
    const mapKgSpecial = (it) => ({
        id: String(it.specialid),
        name: it.specialname || '',
        picUrl: String(it.img || it.imgurl || '').replace('{size}', '400'),
        playCount: it.total_play_count || it.play_count || '',
        trackCount: it.songcount || 0,
        desc: it.nickname || '',
    });

    const TX_ALBUM_AREAS = [
        { id: '1', name: '内地' }, { id: '2', name: '港台' }, { id: '3', name: '欧美' },
        { id: '4', name: '韩国' }, { id: '5', name: '日本' }, { id: '6', name: '其他' },
    ];

    const fetchDiscoverCats = (src, kind) => withCache(`cats:${src}:${kind}`, 60 * 60 * 1000, async () => {
        if (kind === 'album') return src === 'tx' ? TX_ALBUM_AREAS : [];
        if (kind !== 'playlist') return [];
        if (src === 'wy') {
            const d = await chartJson('https://music.163.com/api/playlist/catalogue', { headers: WY_HEADERS });
            const groups = d.categories || {};
            return [{ id: '全部', name: '全部', group: '' }].concat((d.sub || []).map(s => ({ id: s.name, name: s.name, group: groups[s.category] || '' })));
        }
        if (src === 'tx') {
            const d = await txMusicuGet({ tags: { module: 'playlist.PlaylistAllCategoriesServer', method: 'get_all_categories', param: { qq: '' } } });
            const groups = (d.tags && d.tags.data && d.tags.data.v_group) || [];
            return groups.flatMap(g => (g.v_item || []).map(it => ({ id: String(it.id), name: it.name, group: g.group_name || '' })));
        }
        if (src === 'kg') {
            const d = await chartJson('http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&cdn=cdn&t=5&c=', { headers: KG_HEADERS });
            const hot = (d.data && d.data.hotTag && d.data.hotTag.data) || {};
            return [{ id: '', name: '全部', group: '' }].concat(Object.values(hot).map(t => ({ id: String(t.special_id), name: t.special_name, group: '' })));
        }
        if (src === 'kw') {
            const d = await chartJson('http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&loginUid=0&loginSid=0&appUid=76039576');
            const groups = d.data || [];
            return [{ id: '', name: '推荐', group: '' }].concat(groups.flatMap(g => (g.data || []).map(it => ({ id: `${it.id}-${it.digest}`, name: it.name, group: g.name || '' }))));
        }
        if (src === 'mg') {
            const d = await chartJson('https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-taglist/release', { headers: MG_HEADERS });
            const groups = d.data || [];
            return [{ id: '', name: '推荐', group: '' }].concat(groups.flatMap(g => (g.content || []).map(it => ({ id: String((it.texts || [])[1] || ''), name: (it.texts || [])[0] || '', group: g.title || '' })).filter(x => x.id)));
        }
        if (src === 'qs') return [];
        throw new Error(`不支持的平台 ${src}`);
    });

    const fetchWyAlbums = async () => {
        const items = [];
        const seen = new Set();
        try {
            const resp = await fetch('https://music.163.com/discover/album', { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA_PC, Cookie: 'os=pc;' } });
            const html = await resp.text();
            const seg = (html.split('m-cvrlst-alb2')[1] || '').split('</ul>')[0];
            for (const li of seg.match(/<li>[\s\S]*?<\/li>/g) || []) {
                const id = (li.match(/href="\/album\?id=(\d+)"/) || [])[1];
                if (!id || seen.has(id)) continue;
                const name = (li.match(/class="tit[^"]*"[^>]*title="([^"]*)"/) || [])[1];
                const artist = (li.match(/class="nm[^"]*"[^>]*title="([^"]*)"/) || [])[1];
                const pic = ((li.match(/<img src="([^"]+)"/) || [])[1] || '').split('?')[0].replace(/^http:/, 'https:');
                seen.add(id);
                items.push({ id, name: htmlUnescape(name), picUrl: pic ? `${pic}?param=300y300` : '', desc: htmlUnescape(artist), tag: '新碟' });
            }
        } catch (e) { debug('wy album scrape:', e.message); }
        for (const boardId of ['3779629', '3778678']) {
            if (items.length >= 40) break;
            try {
                const d = await chartJson(`https://music.163.com/api/playlist/detail?id=${boardId}`, { headers: WY_HEADERS });
                for (const t of (d.result && d.result.tracks) || []) {
                    const al = t.album;
                    if (!al || !al.id || seen.has(String(al.id))) continue;
                    seen.add(String(al.id));
                    items.push({ id: String(al.id), name: al.name || '', picUrl: (al.picUrl || '').replace(/^http:/, 'https:'), desc: (t.artists || []).map(a => a.name).filter(Boolean).join(' / '), tag: '热门' });
                    if (items.length >= 40) break;
                }
            } catch (e) { debug('wy chart albums:', e.message); }
        }
        if (!items.length) throw new Error('网易云专辑列表获取失败（可能被风控，稍后重试）');
        return { items, hasMore: false };
    };

    const fetchDiscoverLists = (src, kind, cat, page) => withCache(`lists:${src}:${kind}:${cat}:${page}`, 10 * 60 * 1000, async () => {
        page = Math.max(1, Number(page) || 1);
        if (kind === 'recommend') {
            if (src === 'wy') {
                const d = await chartJson('https://music.163.com/api/personalized/playlist?limit=30', { headers: WY_HEADERS });
                const list = d.result || [];
                return { items: list.map(it => ({ id: String(it.id), name: it.name || '', picUrl: (it.picUrl || '').replace(/^http:/, 'https:'), playCount: it.playCount || 0, trackCount: it.trackCount || 0, desc: it.copywriter || '' })), hasMore: false };
            }
            if (src === 'tx') {
                const d = await txMusicuGet({ playlist: { module: 'music.playlist.PlaylistSquare', method: 'GetRecommendWhole', param: { IsReqFeed: true, FeedReq: { From: (page - 1) * 30, Size: 30 } } } });
                const list = (d.playlist && d.playlist.data && d.playlist.data.FeedRsp && d.playlist.data.FeedRsp.List) || [];
                return {
                    items: list.map(({ Playlist }) => {
                        const b = Playlist.basic || {};
                        const cover = b.cover || {};
                        return { id: String(b.tid), name: b.title || '', picUrl: cover.medium_url || cover.small_url || cover.default_url || '', playCount: b.play_cnt || 0, trackCount: b.song_cnt || 0, desc: '' };
                    }),
                    hasMore: list.length === 30,
                };
            }
            if (src === 'kg') {
                const d = await chartJson(`http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=5&c=&p=${page}`, { headers: KG_HEADERS });
                const list = d.special_db || (d.data && d.data.special_db) || [];
                return { items: list.map(mapKgSpecial), hasMore: list.length > 0 && page < 20 };
            }
            if (src === 'kw') {
                const d = await chartJson(`http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&rn=30&order=hot`);
                const data = d.data || {};
                const list = data.data || [];
                return { items: list.map(mapKwPlaylist), hasMore: (page * 30) < (data.total || 0) };
            }
            if (src === 'mg') {
                const d = await chartJson(`https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0?templateVersion=2&pageNo=${page}`, { headers: MG_HEADERS });
                const list = mgLeaves(d.data && d.data.contents).filter(x => x.resType === '2021' && x.img);
                return { items: list.map(mapMgPlaylist), hasMore: list.length > 0 && page < 3 };
            }
            if (src === 'qs') return { items: [], hasMore: false };
        }
        if (kind === 'playlist') {
            if (src === 'wy') {
                const d = await chartJson(`https://music.163.com/api/playlist/list?cat=${encodeURIComponent(cat || '全部')}&order=hot&limit=30&offset=${(page - 1) * 30}`, { headers: WY_HEADERS });
                const list = d.playlists || [];
                return { items: list.map(it => ({ id: String(it.id), name: it.name || '', picUrl: (it.coverImgUrl || '').replace(/^http:/, 'https:'), playCount: it.playCount || 0, trackCount: it.trackCount || 0, desc: it.description || '' })), hasMore: (page * 30) < (d.total || 0) };
            }
            if (src === 'tx') {
                const catId = Number(cat) || 3317;
                const d = await txMusicuGet({ playlist: { module: 'playlist.PlayListCategoryServer', method: 'get_category_content', param: { titleid: catId, caller: '0', category_id: catId, size: 30, page: page - 1, use_page: 1 } } });
                const content = (d.playlist && d.playlist.data && d.playlist.data.content) || {};
                const list = content.v_item || [];
                return {
                    items: list.map(it => {
                        const b = it.basic || {};
                        const cover = b.cover || {};
                        return { id: String(b.tid), name: b.title || '', picUrl: cover.medium_url || cover.default_url || cover.small_url || '', playCount: b.play_cnt || 0, trackCount: b.song_cnt || 0, desc: '' };
                    }),
                    hasMore: (page * 30) < (content.total_cnt || 0),
                };
            }
            if (src === 'kg') {
                const d = await chartJson(`http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=6&c=${encodeURIComponent(cat || '')}&p=${page}`, { headers: KG_HEADERS });
                const list = d.special_db || (d.data && d.data.special_db) || [];
                return { items: list.map(mapKgSpecial), hasMore: list.length > 0 && page < 20 };
            }
            if (src === 'kw') {
                if (!cat) {
                    const d = await chartJson(`http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&rn=30&order=hot`);
                    const data = d.data || {};
                    return { items: (data.data || []).map(mapKwPlaylist), hasMore: (page * 30) < (data.total || 0) };
                }
                const [id, digest] = cat.split('-');
                if (digest === '43') {
                    const d = await chartJson(`http://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id=${encodeURIComponent(id)}&prod=pc`);
                    const list = [];
                    for (const group of Array.isArray(d) ? d : []) for (const it of group.list || []) {
                        if (['songlist', 'list'].includes(it.type)) list.push(it);
                    }
                    return { items: list.map(mapKwPlaylist), hasMore: false };
                }
                const d = await chartJson(`http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&id=${encodeURIComponent(id)}&rn=30`);
                const data = d.data || {};
                return { items: (data.data || []).map(mapKwPlaylist), hasMore: (page * 30) < (data.total || 0) };
            }
            if (src === 'mg') {
                const url = cat
                    ? `https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-listbytag/release?pageNumber=${page}&templateVersion=2&tagId=${encodeURIComponent(cat)}`
                    : `https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0?templateVersion=2&pageNo=${page}`;
                const d = await chartJson(url, { headers: MG_HEADERS });
                const list = mgLeaves(d.data && (d.data.contents || d.data.contentItemList)).filter(x => (x.resType === '2021' || (x.logEvent && x.logEvent.contentType === '2021')) && (x.img || x.imageUrl));
                const hasMore = cat ? (Boolean(d.data && d.data.nextPageUrl) && list.length > 0) : (list.length > 0 && page < 3);
                return { items: list.map(mapMgPlaylist).filter(x => x.id), hasMore };
            }
            if (src === 'qs') {
                const data = await qsPlatform('/search/', { q: cat || '热门', cursor: String((page - 1) * 20), search_id: qsSearchId(), from_search_id: '', search_method: 'input', search_type: 'playlist', search_scene: 'normal', scene_name: 'search', ab_param: '', last_viewed_media: {} });
                const groups = data.result_groups || [];
                const group = groups.find(g => g.id === 'playlists') || groups[0];
                const list = ((group && group.data) || []).map(x => x.entity && x.entity.playlist).filter(Boolean);
                return {
                    items: list.map(pl => ({
                        id: String((pl.base_info && pl.base_info.id) || ''),
                        name: (pl.base_info && (pl.base_info.title || pl.base_info.name)) || '',
                        picUrl: qsCover(pl.display_info),
                        playCount: (pl.stats && pl.stats.count_played) || 0,
                        trackCount: (pl.resource_cnt && pl.resource_cnt.track_cnt) || 0,
                        desc: (pl.base_info && pl.base_info.desc) || '',
                    })).filter(x => x.id),
                    hasMore: Boolean(group && group.has_more),
                };
            }
        }
        if (kind === 'album') {
            if (src === 'wy') return fetchWyAlbums();
            if (src === 'tx') {
                const d = await txMusicu({ new_album: { module: 'newalbum.NewAlbumServer', method: 'get_new_album_info', param: { area: Number(cat) || 1, start: (page - 1) * 30, num: 30 } } }, { ct: 24 });
                const list = (d.new_album && d.new_album.data && d.new_album.data.albums) || [];
                return {
                    items: list.map(it => ({
                        id: it.mid || String(it.id),
                        name: it.name || '',
                        picUrl: (it.photo && it.photo.pic_mid) ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${it.photo.pic_mid}.jpg` : '',
                        desc: (it.singers || []).map(s => s.name).filter(Boolean).join(' / '),
                        tag: it.release_time || '',
                    })),
                    hasMore: list.length === 30,
                };
            }
            if (src === 'kg') {
                const d = await chartJson(`http://mobilecdnbj.kugou.com/api/v3/album/list?page=${page}&pagesize=30`, { headers: KG_HEADERS });
                const list = (d.data && d.data.info) || [];
                return { items: list.map(it => ({ id: String(it.albumid), name: it.albumname || '', picUrl: String(it.imgurl || '').replace('{size}', '400'), desc: it.singername || '', tag: (it.publishtime || '').slice(0, 10) })), hasMore: list.length === 30 };
            }
            if (src === 'kw' || src === 'mg' || src === 'qs') return { items: [], hasMore: false, unsupported: '该平台专辑暂不支持在线浏览，可复制专辑链接到「歌单」页导入' };
        }
        throw new Error(`不支持的发现类型 ${src}/${kind}`);
    });

    const fetchWyPlaylistSongs = async (id) => {
        let r = null;
        const d6 = await chartJson(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=1000`, { headers: WY_HEADERS }).catch(() => null);
        if (d6 && d6.code === 200 && d6.playlist) r = d6.playlist;
        else {
            const d = await chartJson(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`, { headers: WY_HEADERS });
            r = d.result;
        }
        if (!r || (!Array.isArray(r.tracks) && !Array.isArray(r.trackIds))) throw new Error('网易云歌单返回异常（可能被风控，稍后重试）');
        let tracks = Array.isArray(r.tracks) ? r.tracks : [];
        const ids = (r.trackIds || []).map(t => t.id);
        if (ids.length > tracks.length) {
            const have = new Set(tracks.map(t => t.id));
            const missing = ids.filter(i => !have.has(i)).slice(0, Math.max(0, 1000 - tracks.length));
            for (let i = 0; i < missing.length; i += 500) {
                const chunk = missing.slice(i, i + 500);
                const sd = await chartJson(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(chunk.map(x => ({ id: x }))))}`, { headers: WY_HEADERS }).catch(() => null);
                if (!sd || !Array.isArray(sd.songs)) break;
                for (const s of sd.songs) tracks.push({ id: s.id, name: s.name, artists: s.ar, album: s.al, duration: s.dt });
            }
            const byId = new Map(tracks.map(t => [t.id, t]));
            tracks = ids.map(i => byId.get(i)).filter(Boolean);
        }
        return { songs: tracks.slice(0, 1000).map(mapWyTrack), total: r.trackCount || tracks.length, name: r.name || '', picUrl: (r.coverImgUrl || '').replace(/^http:/, 'https:') };
    };
    const fetchTxPlaylistSongs = async (id) => {
        const d = await txMusicu({ diss: { module: 'music.srfDissInfo.aiDissInfo', method: 'uniform_get_Dissinfo', param: { disstid: Number(id), dirid: 0, onlysonglist: 0, song_begin: 0, song_num: 1000 } } });
        const data = d.diss && d.diss.data;
        const list = data && data.songlist;
        if (!Array.isArray(list)) throw new Error('QQ歌单返回异常');
        const dir = data.dirinfo || {};
        return { songs: list.map(mapTxSong), total: data.total_song_num || list.length, name: dir.title || '', picUrl: dir.picurl || '' };
    };
    const fetchKgPagedSongs = async (urlBase, id) => {
        const songs = [];
        let total = 0;
        for (let page = 1; page <= 5; page++) {
            const d = await chartJson(`${urlBase}${encodeURIComponent(id)}&page=${page}&pagesize=100`, { headers: KG_HEADERS });
            const info = d.data && d.data.info;
            if (!Array.isArray(info) || !info.length) break;
            total = d.data.total || info.length;
            for (const it of info) songs.push(mapKgFile(it));
            if (songs.length >= total) break;
        }
        if (!songs.length) throw new Error('酷狗列表返回为空');
        return { songs, total };
    };
    const fetchWyAlbumSongs = async (id) => {
        const d = await chartJson(`https://music.163.com/api/album/${encodeURIComponent(id)}`, { headers: WY_HEADERS });
        const list = d.album && d.album.songs;
        if (!Array.isArray(list)) throw new Error('网易云专辑返回异常');
        return { songs: list.map(mapWyTrack), total: list.length, name: (d.album && d.album.name) || '', picUrl: ((d.album && d.album.picUrl) || '').replace(/^http:/, 'https:') };
    };
    const fetchTxAlbumSongs = async (mid) => {
        const d = await txMusicu({ albumSonglist: { module: 'music.musichallAlbum.AlbumSongList', method: 'GetAlbumSongList', param: { albumMid: mid, albumID: 0, begin: 0, num: 999, order: 2 } } }, { ct: 24, cv: 10000 });
        const data = d.albumSonglist && d.albumSonglist.data;
        const list = data && data.songList;
        if (!Array.isArray(list)) throw new Error('QQ专辑返回异常');
        const songs = list.map(x => x.songInfo || x).map(mapTxSong);
        return { songs, total: (data && data.totalNum) || songs.length, name: (songs[0] && songs[0].albumName) || '', picUrl: (songs[0] && songs[0].picUrl) || '' };
    };

    const fetchDiscoverSongs = (src, kind, id) => withCache(`dsongs:${src}:${kind}:${id}`, 10 * 60 * 1000, async () => {
        let r;
        if (kind === 'album') {
            r = src === 'wy' ? await fetchWyAlbumSongs(id) : src === 'tx' ? await fetchTxAlbumSongs(id) : src === 'kg' ? await fetchKgPagedSongs('http://mobilecdnbj.kugou.com/api/v3/album/song?albumid=', id) : src === 'kw' ? await fetchKwAlbumSongs(id) : src === 'mg' ? await fetchMgAlbumSongs(id) : null;
        } else {
            r = src === 'wy' ? await fetchWyPlaylistSongs(id) : src === 'tx' ? await fetchTxPlaylistSongs(id) : src === 'kg' ? await fetchKgPagedSongs('http://mobilecdnbj.kugou.com/api/v3/special/song?specialid=', id) : src === 'kw' ? await fetchKwPlaylistSongs(id) : src === 'mg' ? await fetchMgPlaylistSongs(id) : src === 'qs' ? await fetchQsPlaylistSongs(id) : null;
        }
        if (!r) throw new Error(`不支持的平台 ${src}`);
        debug('discoverSongs', src, kind, id, r.songs.length);
        return r;
    });

    // ---- 酷我 / 咪咕 / 汽水 数据层：搜索、歌词、歌单、专辑（公开接口，无需登录） ----
    const MG_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
        Referer: 'https://m.music.migu.cn/',
    };
    const chartText = async (url, opt = {}) => {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000), ...opt, headers: { 'User-Agent': UA_PC, ...(opt.headers || {}) } });
        if (!resp.ok) throw new Error(`接口 HTTP ${resp.status}`);
        return resp.text();
    };

    // 酷我
    const kwObjStr2JSON = (str) => JSON.parse(str.replace(/('(?=(,\s*')))|('(?=:))|((?<=([:,]\s*))')|((?<={)')|('(?=}))/g, '"'));
    const mapKwRaw = (it) => {
        const rid = String(it.id || String(it.MUSICRID || '').replace('MUSIC_', ''));
        return {
            id: rid,
            name: htmlUnescape(it.name || it.SONGNAME || ''),
            singer: htmlUnescape(String(it.artist || it.ARTIST || '')).replace(/&/g, '、'),
            albumName: htmlUnescape(it.album || it.ALBUM || ''),
            albumId: String(it.albumid || it.ALBUMID || ''),
            intervalSec: parseInt(it.duration || it.DURATION || 0, 10) || 0,
            picUrl: it.albumpic || it.musicPic || it.pic || '',
            meta: { rid },
        };
    };
    const kwPic = async (rid) => {
        const t = await chartText(`http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${encodeURIComponent(rid)}`, { signal: AbortSignal.timeout(8000) });
        return /^https?:/.test(t.trim()) ? t.trim() : '';
    };
    const fillKwPics = async (songs, cap = Infinity) => {
        const need = songs.filter(s => !s.picUrl).slice(0, cap);
        for (let i = 0; i < need.length; i += 32) {
            await Promise.all(need.slice(i, i + 32).map(async s => { s.picUrl = await kwPic(s.id).catch(() => ''); }));
        }
    };
    const kwSearch = async (str, page, limit) => {
        const d = await chartJson(`http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`);
        const songs = (d.abslist || []).map(mapKwRaw).filter(s => s.id);
        const total = parseInt(d.TOTAL || 0, 10) || 0;
        await fillKwPics(songs);
        return { songs, total, hasMore: page * limit < total };
    };
    const kwLyric = async (rid) => {
        const resp = await fetch(`http://mlyric.kuwo.cn/mobi.s?f=web&type=lyric&lrcx=1&rid=${encodeURIComponent(rid)}&encode=utf8`, { signal: AbortSignal.timeout(15000) });
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.toString('utf8', 0, 10).toLowerCase() !== 'tp=content') throw new Error('酷我歌词返回异常');
        const idx = buf.indexOf('\r\n\r\n');
        let lrc = zlib.inflateSync(buf.subarray(idx + 4)).toString('utf8');
        if (!/\[\d{1,2}:\d{2}/.test(lrc)) {
            const b = Buffer.from(lrc.trim(), 'base64');
            const key = Buffer.from('yeelion');
            const out = Buffer.alloc(b.length);
            for (let i = 0; i < b.length; i++) out[i] = b[i] ^ key[i % key.length];
            lrc = out.toString('utf8');
        }
        lrc = lrc.replace(/<-?\d+,-?\d+(?:,-?\d+)?>/g, '');
        return { lrc, tlyric: '' };
    };
    const mapKwPlaylist = (it) => ({
        id: `digest-${it.digest}__${it.id}`,
        name: it.name || '',
        picUrl: it.img || '',
        playCount: it.listencnt || 0,
        trackCount: parseInt(it.total || 0, 10) || 0,
        desc: it.desc || it.uname || '',
    });
    const fetchKwPlaylistSongs = async (id) => {
        const m = /^digest-(\d+)__(\d+)$/.exec(id);
        let pid = m ? m[2] : id;
        if (m && m[1] === '5') {
            const q = await chartJson(`http://qukudata.kuwo.cn/q.k?op=query&cont=ninfo&node=${pid}&pn=0&rn=1&fmt=json&src=mbox&level=2`);
            const resolved = q.child && q.child[0] && q.child[0].sourceid;
            if (!resolved) throw new Error('酷我歌单解析失败');
            pid = String(resolved);
        }
        const songs = [];
        let total = 0, name = '', picUrl = '';
        for (let page = 0; page < 2; page++) {
            const d = await chartJson(`http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${encodeURIComponent(pid)}&pn=${page}&rn=1000&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`);
            if (d.result !== 'ok' || !Array.isArray(d.musiclist)) throw new Error('酷我歌单返回异常');
            total = parseInt(d.total || 0, 10) || d.musiclist.length;
            name = d.title || name; picUrl = d.pic || picUrl;
            for (const it of d.musiclist) songs.push(mapKwRaw(it));
            if (songs.length >= Math.min(total, 1000) || !d.musiclist.length) break;
        }
        await fillKwPics(songs, 100);
        return { songs: songs.slice(0, 1000), total, name, picUrl };
    };
    const fetchKwAlbumSongs = async (id) => {
        const text = await chartText(`http://search.kuwo.cn/r.s?pn=0&rn=1000&stype=albuminfo&albumid=${encodeURIComponent(id)}&show_copyright_off=0&encoding=utf8&vipver=MUSIC_9.1.0`);
        const d = kwObjStr2JSON(text);
        if (!Array.isArray(d.musiclist)) throw new Error('酷我专辑返回异常');
        const songs = d.musiclist.map(it => ({ ...mapKwRaw(it), albumName: htmlUnescape(d.name || ''), albumId: String(d.albumid || id), picUrl: it.pic || d.img || d.hts_img || '' }));
        return { songs, total: parseInt(d.songnum || 0, 10) || songs.length, name: htmlUnescape(d.name || ''), picUrl: d.img || d.hts_img || '' };
    };

    // 咪咕
    const mgSign = (text, time) => {
        const deviceId = '963B7AA0D21511ED807EE5846EC87D20';
        const sign = nodeCrypto.createHash('md5').update(`${text}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`).digest('hex');
        return { sign, deviceId };
    };
    const mapMgSong = (it) => {
        let img = it.img3 || it.img2 || it.img1 || '';
        if (!img && Array.isArray(it.albumImgs) && it.albumImgs.length) img = it.albumImgs[0].img || '';
        if (img && !/^https?:/.test(img)) img = 'http://d.musicapp.migu.cn' + img;
        const singer = Array.isArray(it.singerList) ? it.singerList.map(s => s.name).filter(Boolean).join(' / ') : String(it.singer || '');
        return {
            id: String(it.songId || ''),
            name: it.name || it.songName || '',
            singer,
            albumName: it.album || '',
            albumId: String(it.albumId || ''),
            intervalSec: parseInt(it.duration || 0, 10) || 0,
            picUrl: img.replace(/^http:/, 'https:'),
            meta: { copyrightId: it.copyrightId || '', lrcUrl: it.lrcUrl || '', mrcUrl: it.mrcurl || '', trcUrl: it.trcUrl || '' },
        };
    };
    const mgSearch = async (str, page, limit) => {
        const time = Date.now().toString();
        const { sign, deviceId } = mgSign(str, time);
        const d = await chartJson(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0&sid=USS`, {
            headers: { uiVersion: 'A_music_3.6.1', deviceId, timestamp: time, sign, channel: '0146921', 'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30' },
        });
        if (!d || d.code !== '000000') throw new Error((d && d.info) || '咪咕搜索失败');
        const sr = d.songResultData || { resultList: [], totalCount: 0 };
        const seen = new Set();
        const songs = [];
        for (const group of sr.resultList || []) for (const it of group || []) {
            if (!it.songId || !it.copyrightId || seen.has(it.copyrightId)) continue;
            seen.add(it.copyrightId);
            songs.push(mapMgSong(it));
        }
        const total = parseInt(sr.totalCount || 0, 10) || 0;
        return { songs, total, hasMore: page * limit < total };
    };
    const mgLyric = async (musicInfo) => {
        const meta = (musicInfo && musicInfo.meta) || {};
        let lrcUrl = meta.lrcUrl || '';
        if (!lrcUrl && meta.copyrightId) {
            const resp = await fetch('https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...MG_HEADERS },
                body: `resourceId=${encodeURIComponent(meta.copyrightId)}`,
                signal: AbortSignal.timeout(15000),
            });
            const d = await resp.json();
            const r = d.resource && d.resource[0];
            lrcUrl = (r && r.lrcUrl) || '';
        }
        if (!lrcUrl) throw new Error('咪咕歌词地址缺失');
        const lrc = await chartText(lrcUrl, { headers: { Referer: 'https://app.c.nf.migu.cn/', channel: '0146921' } });
        return { lrc, tlyric: '' };
    };
    const mgLeaves = (node, out = []) => {
        if (!node) return out;
        if (Array.isArray(node)) { for (const n of node) mgLeaves(n, out); return out; }
        if (node.contents || node.contentItemList || node.itemList) { mgLeaves(node.contents || node.contentItemList || node.itemList, out); return out; }
        out.push(node);
        return out;
    };
    const mapMgPlaylist = (it) => {
        let id = it.resId || (it.logEvent && (it.logEvent.resourceId || it.logEvent.contentId)) || '';
        if (!id && it.actionUrl) { const m = /[?&]id=(\d+)/.exec(it.actionUrl); if (m) id = m[1]; }
        return {
            id: String(id),
            name: it.txt || it.title || '',
            picUrl: String(it.img || it.imageUrl || '').replace(/^http:/, 'https:'),
            playCount: 0,
            trackCount: 0,
            desc: it.txt2 || '',
        };
    };
    const fetchMgPlaylistSongs = async (id) => {
        const songs = [];
        let total = 0;
        for (let page = 1; page <= 20; page++) {
            const d = await chartJson(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=50&playlistId=${encodeURIComponent(id)}`, { headers: MG_HEADERS });
            if (d.code !== '000000' || !d.data) throw new Error('咪咕歌单返回异常');
            total = parseInt(d.data.totalCount || 0, 10) || 0;
            const list = d.data.songList || [];
            if (!list.length) break;
            for (const it of list) songs.push(mapMgSong(it));
            if (songs.length >= Math.min(total, 1000)) break;
        }
        let name = '', picUrl = '';
        try {
            const info = await chartJson(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId=${encodeURIComponent(id)}`, { headers: MG_HEADERS });
            const p = info.data || {};
            name = p.title || p.name || '';
            picUrl = (p.imgItems && p.imgItems[0] && p.imgItems[0].img) || p.img || '';
        } catch { /* 名称获取失败不影响歌曲 */ }
        return { songs: songs.slice(0, 1000), total, name, picUrl: String(picUrl).replace(/^http:/, 'https:') };
    };
    const fetchMgAlbumSongs = async (id) => {
        const songs = [];
        for (let page = 1; page <= 10; page++) {
            const d = await chartJson(`http://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/queryAlbumSong?albumId=${encodeURIComponent(id)}&pageNo=${page}`, { headers: MG_HEADERS });
            if (d.code !== '000000' || !d.data) throw new Error('咪咕专辑返回异常');
            const list = d.data.songList || [];
            if (!list.length) break;
            for (const it of list) songs.push(mapMgSong(it));
            if (list.length < 20) break;
        }
        let name = '', picUrl = '';
        try {
            const info = await chartJson(`https://app.c.nf.migu.cn/MIGUM3.0/resource/album/v2.0?albumId=${encodeURIComponent(id)}`, { headers: MG_HEADERS });
            const a = info.data || {};
            name = a.title || a.albumName || a.name || '';
            picUrl = (a.imgItems && a.imgItems[0] && a.imgItems[0].img) || '';
        } catch { /* ignore */ }
        return { songs, total: songs.length, name, picUrl: String(picUrl).replace(/^http:/, 'https:') };
    };

    // 汽水（车机开放协议，匿名 client_token，无需登录）
    const QS_UA = 'LunaOpenSDK/1.0.10';
    const QS_PREFIX = '/api/luna/v1/platform';
    const qsDeviceId = (nodeCrypto.randomBytes(8).readBigUInt64BE() % 9000000000000000000n + 1000000000000000000n).toString();
    const qsCommon = {
        aid: '765213', app_id: '765213', app_name: 'byte_autoservice_lite', version_code: '100010', version_name: '1.0.10',
        channel: 'bydSong', sdk_aid: '753999', caller_name: 'luna_open_sdk', sdk_version_code: '100000100', sdk_version_name: '0.0.1',
        sdk_channel: 'Test', vehicle_type: 'BYD', device_brand: 'BYD', device_type: 'BYD', device_platform: 'android',
        resolution: '1920x1080', os_version: '13', ac: 'wifi',
    };
    const qsParams = (extra = {}) => new URLSearchParams({
        ...qsCommon, device_id: qsDeviceId, did: qsDeviceId, iid: qsDeviceId, vehicle_id: `qishui-${qsDeviceId}`,
        _timestamp: String(Math.floor(Date.now() / 1000)), _nonce: String(nodeCrypto.randomBytes(2).readUInt16BE()), ...extra,
    }).toString();
    let qsTokenEntry = null;
    const qsToken = () => {
        if (!qsTokenEntry) {
            qsTokenEntry = fetch(`https://open.qishui.com${QS_PREFIX}/client/token/get/?${qsParams({ trigger_type: 'cold_start' })}`, {
                headers: { 'user-agent': QS_UA }, signal: AbortSignal.timeout(20000),
            }).then(async r => {
                const j = await r.json();
                const token = j.client_token || (j.data && j.data.client_token);
                if (!token) throw new Error('汽水令牌获取失败');
                return token;
            }).catch(e => { qsTokenEntry = null; throw e; });
        }
        return qsTokenEntry;
    };
    const qsPlatform = async (path, body = {}) => {
        const token = await qsToken();
        const r = await fetch(`https://open.douyin.com${QS_PREFIX}${path}?${qsParams()}`, {
            method: 'POST',
            headers: { 'user-agent': QS_UA, 'content-type': 'application/json', 'access-token': token },
            body: JSON.stringify({ ...body, common_params: {} }),
            signal: AbortSignal.timeout(20000),
        });
        const j = await r.json();
        if (j.err_no) {
            if ([28001003, 28001007, 28001008, 10007].includes(Number(j.err_no))) qsTokenEntry = null;
            throw new Error(`汽水接口错误 ${j.err_no}`);
        }
        return j.data;
    };
    const qsSearchId = () => nodeCrypto.randomUUID();
    const qsCover = (di) => {
        const c = di && (di.cover_url || di.url_cover);
        if (c && Array.isArray(c.urls) && c.urls[0] && c.uri) return c.urls[0] + c.uri;
        return '';
    };
    const qsExtractTrack = (raw) => (raw && (raw.track_entity || (raw.entity && raw.entity.media && raw.entity.media.track_entity) || (raw.entity && raw.entity.track) || raw.track)) || raw;
    const mapQsTrack = (raw) => {
        const t = qsExtractTrack(raw);
        const b = (t && t.base_info) || {};
        const rel = (t && t.related_info) || {};
        return {
            id: String(b.id || ''),
            name: b.name || '',
            singer: (rel.artist_links || []).map(a => a.name).filter(Boolean).join(' / '),
            albumName: (rel.album_link && rel.album_link.name) || '',
            albumId: String((rel.album_link && rel.album_link.id) || ''),
            intervalSec: Math.round((b.duration_ms || 0) / 1000),
            picUrl: qsCover(t && t.display_info),
            meta: {},
        };
    };
    const qsSearch = async (str, page) => {
        const sid = qsSearchId();
        const data = await qsPlatform('/search/', {
            q: str, cursor: String((page - 1) * 20), search_id: sid, from_search_id: sid,
            search_method: 'input', search_type: 'track', search_scene: 'normal', scene_name: 'search', ab_param: '', last_viewed_media: {},
        });
        const groups = data.result_groups || [];
        const group = groups.find(g => g.id === 'tracks') || groups[0];
        const songs = ((group && group.data) || []).map(x => mapQsTrack(x.entity && x.entity.track)).filter(s => s.id);
        return { songs, total: 0, hasMore: Boolean(group && group.has_more) };
    };
    const qsLyric = async (id) => {
        const data = await qsPlatform('/media/mget/', { media_list: [{ id: String(id), type: 'track' }], card_context: {} });
        const media = (data.media_list || []).find(x => String(x.media_id || (x.track_entity && x.track_entity.base_info && x.track_entity.base_info.id)) === String(id));
        const entity = media && media.track_entity;
        const content = entity && entity.display_info && entity.display_info.lyric_info && entity.display_info.lyric_info.lyric_entity && entity.display_info.lyric_info.lyric_entity.content;
        if (!content) throw new Error('汽水歌词缺失');
        const lines = [];
        for (const line of String(content).split('\n')) {
            const m = /^\[(\d+),\d+\](.*)$/.exec(line);
            if (!m) continue;
            const ms = parseInt(m[1], 10);
            const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
            const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
            const xx = String(Math.floor(ms / 10) % 100).padStart(2, '0');
            const text = m[2].replace(/<\d+,\d+,?\d*>/g, '').trim();
            if (text) lines.push(`[${mm}:${ss}.${xx}]${text}`);
        }
        if (!lines.length) throw new Error('汽水歌词解析失败');
        return { lrc: lines.join('\n'), tlyric: '' };
    };
    const qsFeed = async (count = 30) => {
        const data = await qsPlatform('/feed/song-tab/', {
            played_media: [], is_first_request: true, with_client_cache: false, is_did_first_request: false, count,
            feed_preference: { scene_mode_id: null, scene_mode_select_time: null, preference_mode: null, total_request_count: 1, preference_mode_request_count: 1, current_mode_request_count: 1 },
        });
        const songs = (data.items || []).filter(x => !x.type || x.type === 'track').map(mapQsTrack).filter(s => s.id);
        return { songs };
    };
    const fetchQsPlaylistSongs = async (id) => {
        const songs = [];
        let cursor = '0', name = '', picUrl = '', total = 0;
        const seen = new Set();
        for (let page = 0; page < 12; page++) {
            const data = await qsPlatform('/playlist/detail/', { playlist_id: String(id), owner_id: '', count: 100, cursor, type: null });
            if (page === 0 && data.playlist) {
                const b = data.playlist.base_info || {};
                name = b.title || b.name || '';
                picUrl = qsCover(data.playlist.display_info);
                total = (data.playlist.resource_cnt && data.playlist.resource_cnt.track_cnt) || 0;
            }
            const batch = data.media_entities || [];
            for (const it of batch) {
                const s = mapQsTrack(it);
                if (s.id && !seen.has(s.id)) { seen.add(s.id); songs.push(s); }
            }
            const next = String(data.next_cursor ?? '');
            if (!data.has_more || !next || seen.has(`c${next}`) || songs.length >= 1000) break;
            seen.add(`c${next}`);
            cursor = next;
        }
        if (!songs.length) throw new Error('汽水歌单返回为空');
        return { songs: songs.slice(0, 1000), total: total || songs.length, name, picUrl };
    };

    // 歌单/专辑链接导入
    const resolveShareLink = async (url) => {
        let current = url;
        for (let i = 0; i < 6; i++) {
            let host = '';
            try { host = new URL(current).hostname; } catch { return current; }
            const isShort = /(^|\.)(163cn\.tv|c\.y\.qq\.com|t1\.kugou\.com|kugou\.com|v\.kuwo\.cn|douyin\.com|qishui\.com|iesdouyin\.com)$/.test(host)
                && /\/(base\/fcgi-bin\/u|share|s\/|short)/.test(current) || host === '163cn.tv' || host === 't1.kugou.com';
            if (!isShort) return current;
            try {
                const r = await fetch(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': UA_PC } });
                const loc = r.headers.get('location');
                if (!loc) return current;
                current = new URL(loc, current).toString();
            } catch { return current; }
        }
        return current;
    };
    const importPlaylist = async (rawUrl) => {
        let url = String(rawUrl || '').trim();
        const textMatch = url.match(/https?:\/\/[^\s"'<>]+/);
        if (textMatch) url = textMatch[0];
        if (!/^https?:\/\//.test(url)) throw new Error('请粘贴完整的歌单/专辑分享链接');
        url = await resolveShareLink(url);
        const pick = (source, kind, m) => m && m[1] ? { source, kind, id: m[1] } : null;
        const found =
            pick('wy', 'playlist', /(?:y\.)?music\.163\.com\/(?:#\/)?(?:m\/)?(?:playlist|myplaylist)\?(?:.*&)?id=(\d+)/.exec(url)) ||
            pick('wy', 'playlist', /(?:y\.)?music\.163\.com\/(?:m\/)?playlist\/(\d+)/.exec(url)) ||
            pick('wy', 'album', /(?:y\.)?music\.163\.com\/(?:#\/)?(?:m\/)?album\?(?:.*&)?id=(\d+)/.exec(url)) ||
            pick('wy', 'album', /(?:y\.)?music\.163\.com\/(?:m\/)?album\/(\d+)/.exec(url)) ||
            pick('tx', 'playlist', /y\.qq\.com\/n\/(?:ryqq(?:_v2)?|yqq)\/playlist\/(\d+)/.exec(url)) ||
            pick('tx', 'playlist', /y\.qq\.com\/[^?#]*taoge\.html\?(?:[^#]*&)?id=(\d+)/.exec(url)) ||
            pick('tx', 'album', /y\.qq\.com\/n\/(?:ryqq(?:_v2)?|yqq)\/albumDetail\/([A-Za-z0-9]+)/.exec(url)) ||
            pick('tx', 'album', /y\.qq\.com\/[^?#]*album\.html\?(?:[^#]*&)?albummid=([A-Za-z0-9]+)/.exec(url)) ||
            pick('kg', 'playlist', /kugou\.com\/(?:[^?#]*\/)?special\/single\/(\d+)/.exec(url)) ||
            pick('kg', 'playlist', /kugou\.com\/(?:[^?#]*\/)?songlist\/(\d+)/.exec(url)) ||
            pick('kg', 'playlist', /kugou\.com\/[^?#]*\?(?:[^#]*&)?specialid=(\d+)/.exec(url)) ||
            pick('kg', 'album', /kugou\.com\/(?:[^?#]*\/)?album\/(\d+)/.exec(url)) ||
            pick('kw', 'playlist', /kuwo\.cn\/(?:[^?#]*\/)?playlist(?:_detail)?\/(\d+)/i.exec(url)) ||
            pick('kw', 'album', /kuwo\.cn\/(?:[^?#]*\/)?album_detail\/(\d+)/i.exec(url)) ||
            pick('mg', 'playlist', /music\.migu\.cn\/(?:v3\/)?music\/playlist\/(\d+)/.exec(url)) ||
            pick('mg', 'album', /music\.migu\.cn\/(?:v3\/)?music\/album\/(\d+)/.exec(url)) ||
            pick('qs', 'playlist', /(?:music\.douyin\.com|qishui\.com)\/(?:qishui\/)?playlist\/(\d{6,})/.exec(url)) ||
            pick('qs', 'playlist', /playlist_id=(\d{6,})/.exec(url));
        if (!found) throw new Error('无法识别该链接（支持网易云/QQ/酷狗/酷我/咪咕/汽水的歌单或专辑链接）');
        debug('importPlaylist', url, '→', JSON.stringify(found));
        return found;
    };

    const platformSearch = async ({ source, str, page, limit }) => {
        const q = String(str || '').trim().slice(0, 200);
        if (!q) throw new Error('关键词为空');
        const p = Math.max(1, Number(page) || 1);
        const l = Math.min(Math.max(1, Number(limit) || 30), 50);
        const r = source === 'kw' ? await kwSearch(q, p, l) : source === 'mg' ? await mgSearch(q, p, l) : source === 'qs' ? await qsSearch(q, p) : null;
        if (!r) throw new Error(`不支持的搜索平台 ${source}`);
        debug('platformSearch', source, q, p, r.songs.length);
        return r;
    };
    const platformLyric = async ({ source, musicInfo }) => {
        const info = musicInfo || {};
        if (source === 'kw') return kwLyric(info.songmid || info.id);
        if (source === 'mg') return mgLyric(info);
        if (source === 'qs') return qsLyric(info.songmid || info.id);
        throw new Error(`不支持的歌词平台 ${source}`);
    };

    // ---- 我的歌单（持久化收藏）----
    const getMyLists = async () => {
        const v = await api.storage.get('myLists');
        return Array.isArray(v) ? v : [];
    };
    const saveMyList = async (item) => {
        if (!item || !item.source || !item.id) throw new Error('收藏信息不完整');
        const kind = item.kind === 'album' ? 'album' : 'playlist';
        const key = `${item.source}:${kind}:${item.id}`;
        const lists = await getMyLists();
        const entry = {
            key, source: String(item.source), kind, id: String(item.id),
            name: String(item.name || ''), picUrl: String(item.picUrl || ''),
            total: Number(item.total) || 0, addedAt: Date.now(),
        };
        const i = lists.findIndex(x => x.key === key);
        if (i >= 0) lists[i] = { ...entry, addedAt: lists[i].addedAt || entry.addedAt, removed: lists[i].removed, added: lists[i].added };
        else lists.unshift(entry);
        await api.storage.set('myLists', lists.slice(0, 200));
        return entry;
    };
    const removeMyList = async (key) => {
        const lists = await getMyLists();
        const next = lists.filter(x => x.key !== String(key));
        await api.storage.set('myLists', next);
        return { removed: lists.length - next.length };
    };
    const saveMergedList = async ({ name, picUrl, songs }) => {
        if (!Array.isArray(songs) || !songs.length) throw new Error('合并结果为空');
        if (songs.length > 5000) throw new Error('合并结果过大（超过 5000 首）');
        const clean = songs.filter(s => s && typeof s.source === 'string');
        if (!clean.length) throw new Error('合并结果为空');
        const id = Date.now().toString(36);
        const entry = {
            key: `merged:merged:${id}`, source: 'merged', kind: 'merged', id,
            name: String(name || '合并歌单').slice(0, 120), picUrl: String(picUrl || ''),
            total: clean.length, addedAt: Date.now(), songs: clean,
        };
        const lists = await getMyLists();
        lists.unshift(entry);
        await api.storage.set('myLists', lists.slice(0, 200));
        return entry;
    };
    const updateMyList = async ({ key, name, songs, removed, added }) => {
        const lists = await getMyLists();
        const entry = lists.find(x => x.key === String(key));
        if (!entry) throw new Error('收藏不存在');
        if (typeof name === 'string') {
            const t = name.trim();
            if (!t) throw new Error('名称不能为空');
            entry.name = t.slice(0, 120);
        }
        if (Array.isArray(songs)) {
            if (!['merged', 'local', 'like'].includes(entry.kind)) throw new Error('该收藏不支持直接修改歌曲');
            if (songs.length > 5000) throw new Error('歌单过大（超过 5000 首）');
            entry.songs = songs.filter(s => s && typeof s.source === 'string');
            entry.total = entry.songs.length;
        }
        if (Array.isArray(removed)) {
            entry.removed = removed.filter(k => typeof k === 'string').slice(0, 5000);
        }
        if (Array.isArray(added)) {
            if (['merged', 'local', 'like'].includes(entry.kind)) throw new Error('该收藏不支持本地加歌字段');
            entry.added = added.filter(s => s && typeof s.source === 'string').slice(0, 5000);
        }
        await api.storage.set('myLists', lists);
        return entry;
    };
    const createMyList = async ({ name }) => {
        const t = String(name || '').trim();
        if (!t) throw new Error('名称不能为空');
        const id = Date.now().toString(36);
        const entry = {
            key: `local:local:${id}`, source: 'local', kind: 'local', id,
            name: t.slice(0, 120), picUrl: '', total: 0, addedAt: Date.now(), songs: [],
        };
        const lists = await getMyLists();
        lists.unshift(entry);
        await api.storage.set('myLists', lists.slice(0, 200));
        return entry;
    };
    const ensureLikeList = async () => {
        const lists = await getMyLists();
        const found = lists.find(x => x.kind === 'like');
        if (found) return found;
        const entry = {
            key: 'like:like:default', source: 'like', kind: 'like', id: 'default',
            name: '我喜欢', picUrl: '', total: 0, addedAt: Date.now(), songs: [],
        };
        lists.unshift(entry);
        await api.storage.set('myLists', lists.slice(0, 200));
        return entry;
    };
    const addSongToList = async ({ key, song }) => {
        if (!song || typeof song.source !== 'string' || song.id === undefined || song.id === null || !String(song.name || '').trim()) throw new Error('歌曲信息不完整');
        const lists = await getMyLists();
        const entry = lists.find(x => x.key === String(key));
        if (!entry) throw new Error('收藏不存在');
        const k = `${song.source}:${song.id}`;
        const clean = {
            id: song.id, name: String(song.name), singer: String(song.singer || ''),
            picUrl: String(song.picUrl || ''), intervalSec: Number(song.intervalSec) || 0,
            albumName: String(song.albumName || ''), source: song.source,
        };
        if (['merged', 'local', 'like'].includes(entry.kind)) {
            const songs = Array.isArray(entry.songs) ? entry.songs : [];
            if (songs.some(s => `${s.source}:${s.id}` === k)) return { entry, inserted: false };
            if (songs.length >= 5000) throw new Error('歌单过大（超过 5000 首）');
            entry.songs = songs.concat(clean);
            entry.total = entry.songs.length;
        } else {
            const added = Array.isArray(entry.added) ? entry.added : [];
            if (added.some(s => `${s.source}:${s.id}` === k)) return { entry, inserted: false };
            if (added.length >= 5000) throw new Error('歌单过大（超过 5000 首）');
            entry.added = added.concat(clean);
        }
        await api.storage.set('myLists', lists);
        return { entry, inserted: true };
    };
    const exportMyList = async ({ key }) => {
        const lists = await getMyLists();
        const entry = lists.find(x => x.key === String(key));
        if (!entry) throw new Error('收藏不存在');
        let songs;
        if (Array.isArray(entry.songs)) {
            songs = entry.songs;
        } else {
            const r = await fetchDiscoverSongs(entry.source, entry.kind, entry.id);
            const rem = new Set(Array.isArray(entry.removed) ? entry.removed : []);
            songs = (r.songs || []).filter(s => !rem.has(`${entry.source}:${s.id}`));
            const have = new Set(songs.map(s => `${entry.source}:${s.id}`));
            for (const s of Array.isArray(entry.added) ? entry.added : []) {
                const k = `${s.source}:${s.id}`;
                if (!have.has(k)) { have.add(k); songs.push(s); }
            }
        }
        const clean = songs.map(s => ({
            id: s.id, name: String(s.name || ''), singer: String(s.singer || ''),
            picUrl: String(s.picUrl || ''), intervalSec: Number(s.intervalSec) || 0,
            albumName: String(s.albumName || ''), source: s.source || entry.source,
        }));
        const dir = path.join(dataDir, 'exports');
        fs.mkdirSync(dir, { recursive: true });
        const safe = String(entry.name || entry.id).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'playlist';
        const file = path.join(dir, `${safe}.json`);
        fs.writeFileSync(file, JSON.stringify({
            name: entry.name || '', kind: entry.kind, source: entry.source || null,
            exportedAt: new Date().toISOString(), total: clean.length, songs: clean,
        }, null, 2), 'utf8');
        debug('exportMyList', entry.key, clean.length, file);
        return { file, total: clean.length };
    };

    // ---- 音源脚本管理（导入/编辑/删除，脚本与插件本体分离）----
    const safeScriptName = (name) => {
        const base = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!base || base.startsWith('.')) throw new Error('无效的文件名');
        return base.toLowerCase().endsWith('.js') ? base : `${base}.js`;
    };
    const importScript = async ({ fileName, content }) => {
        const text = String(content || '');
        if (!text.trim()) throw new Error('脚本内容为空');
        if (text.length > 8 * 1024 * 1024) throw new Error('脚本过大（超过 8MB）');
        parseScriptInfo(text);
        let file = safeScriptName(fileName);
        let n = 1;
        while (fs.existsSync(path.join(dataDir, file))) {
            n += 1;
            file = safeScriptName(`${String(fileName).replace(/\.js$/i, '')}-${n}`);
        }
        fs.writeFileSync(path.join(dataDir, file), text, 'utf8');
        debug('importScript', file, text.length);
        return { file, list: listScripts() };
    };
    const readScript = async (file) => {
        const f = safeScriptName(file);
        const full = path.join(dataDir, f);
        if (!fs.existsSync(full)) throw new Error('脚本不存在');
        return { file: f, content: fs.readFileSync(full, 'utf8') };
    };
    const saveScript = async ({ file, content }) => {
        const f = safeScriptName(file);
        const text = String(content || '');
        if (!text.trim()) throw new Error('脚本内容为空');
        if (text.length > 8 * 1024 * 1024) throw new Error('脚本过大（超过 8MB）');
        parseScriptInfo(text);
        fs.writeFileSync(path.join(dataDir, f), text, 'utf8');
        debug('saveScript', f, text.length);
        const st = state.scriptFile === f ? await loadScript(f) : null;
        return { file: f, status: st, list: listScripts() };
    };
    const deleteScript = async (file) => {
        const f = safeScriptName(file);
        const full = path.join(dataDir, f);
        if (!fs.existsSync(full)) throw new Error('脚本不存在');
        fs.unlinkSync(full);
        debug('deleteScript', f);
        const st = state.scriptFile === f ? await loadScript(null) : null;
        return { file: f, status: st, list: listScripts() };
    };

    api.rpc.handle('listScripts', () => listScripts());
    api.rpc.handle('status', () => status());
    api.rpc.handle('reload', (arg) => loadScript(arg && arg.script));
    api.rpc.handle('musicUrl', (arg) => requestMusicUrl(arg));
    api.rpc.handle('txMid', (arg) => resolveTxMid(arg && arg.id));
    api.rpc.handle('chartLists', (arg) => fetchBoards(String(arg && arg.source)));
    api.rpc.handle('chartSongs', (arg) => fetchChartSongs(String(arg && arg.source), String(arg && arg.boardId)));
    api.rpc.handle('discoverCats', (arg) => fetchDiscoverCats(String(arg && arg.source), String(arg && arg.kind)));
    api.rpc.handle('discoverLists', (arg) => fetchDiscoverLists(String(arg && arg.source), String(arg && arg.kind), String((arg && arg.cat) || ''), Number(arg && arg.page) || 1));
    api.rpc.handle('discoverSongs', (arg) => fetchDiscoverSongs(String(arg && arg.source), String(arg && arg.kind), String(arg && arg.id)));
    api.rpc.handle('platformSearch', (arg) => platformSearch(arg || {}));
    api.rpc.handle('platformLyric', (arg) => platformLyric(arg || {}));
    api.rpc.handle('qsFeed', (arg) => qsFeed(Number(arg && arg.count) || 30));
    api.rpc.handle('importPlaylist', (arg) => importPlaylist(arg && arg.url));
    api.rpc.handle('myLists', () => getMyLists());
    api.rpc.handle('saveMyList', (arg) => saveMyList(arg));
    api.rpc.handle('removeMyList', (arg) => removeMyList(arg && arg.key));
    api.rpc.handle('updateMyList', (arg) => updateMyList(arg || {}));
    api.rpc.handle('createMyList', (arg) => createMyList(arg || {}));
    api.rpc.handle('ensureLikeList', () => ensureLikeList());
    api.rpc.handle('addSongToList', (arg) => addSongToList(arg || {}));
    api.rpc.handle('exportMyList', (arg) => exportMyList(arg || {}));
    api.rpc.handle('saveMergedList', (arg) => saveMergedList(arg || {}));
    api.rpc.handle('importScript', (arg) => importScript(arg || {}));
    api.rpc.handle('readScript', (arg) => readScript(arg && arg.file));
    api.rpc.handle('saveScript', (arg) => saveScript(arg || {}));
    api.rpc.handle('deleteScript', (arg) => deleteScript(arg && arg.file));
    api.rpc.handle('settingsGet', async () => (await api.storage.get('settings')) || null);
    api.rpc.handle('settingsSet', async (patch) => {
        const cur = (await api.storage.get('settings')) || {};
        const next = { ...cur, ...(patch || {}) };
        await api.storage.set('settings', next);
        return next;
    });

    api.onDispose(() => { teardownScript(); debug('mod stopped'); });

    // 启动时按已保存的设置自动加载
    void (async () => {
        try {
            const saved = await api.storage.get('script');
            if (saved) await loadScript(saved);
        } catch (e) { debug('auto load failed:', e.message); }
    })();

    debug('mod activated, dataDir:', dataDir);
};