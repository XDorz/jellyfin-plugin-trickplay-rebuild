// ==UserScript==
// @name         Jellyfin Trickplay Rebuild
// @name:zh-CN   Jellyfin 单视频预览图重建
// @namespace    https://github.com/XDorz/jellyfin-plugin-trickplay-rebuild
// @version      1.0.0
// @description Add a native-style preview rebuild button to Jellyfin movie and episode details. Requires the Trickplay Rebuild server plugin.
// @description:zh-CN 在 Jellyfin 影片和单集详情页添加原生风格的预览图重建按钮，需要安装 Trickplay Rebuild 服务端插件。
// @author       XDorz
// @match        *://*/web/index.html*
// @match        *://*/*/web/index.html*
// @match        *://*/web/
// @match        *://*/*/web/
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// @license      GPL-3.0-only
// @homepageURL  https://github.com/XDorz/jellyfin-plugin-trickplay-rebuild/tree/main/web
// @downloadURL  https://raw.githubusercontent.com/XDorz/jellyfin-plugin-trickplay-rebuild/main/web/trickplay-rebuild.user.js
// @updateURL    https://raw.githubusercontent.com/XDorz/jellyfin-plugin-trickplay-rebuild/main/web/trickplay-rebuild.user.js
// ==/UserScript==

(() => {
    'use strict';

    const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    if (window.top !== window.self ||
        document.querySelector('meta[name="application-name"]')?.content !== 'Jellyfin') return;
    const marker = 'jf-trickplay-rebuild';
    if (document.documentElement.hasAttribute('data-' + marker)) return;
    document.documentElement.setAttribute('data-' + marker, '1');

    const messages = {
        en: {
            button: 'Rebuild previews', queued: 'Preview rebuild queued', running: 'Rebuilding previews',
            submitted: 'Preview rebuild submitted. The server will process it in the background.',
            duplicate: 'This video is already queued or rebuilding. Please do not submit it again.',
            forbidden: 'Your account does not have server administrator permission to rebuild previews.',
            busy: 'Too many rebuild requests. Please try again later.',
            missing: 'Rebuild endpoint or video not found (HTTP 404). Check that the server plugin is installed.',
            method: 'The server rejected this request method (HTTP 405). Check the proxy configuration.',
            incompatible: 'The rebuild plugin does not support this Jellyfin version. Update the plugin.',
            unavailable: 'The rebuild service is unavailable (HTTP 503). Check the plugin version and server status.',
            unsupported: 'Check that Trickplay is enabled for this library and the video is accessible and supported.',
            uncertain: 'Unable to confirm submission. Check the task status before trying again.',
            failed: 'Unable to verify preview generation. Check the server log.',
            completed: 'Preview images have been rebuilt.',
            lost: 'The rebuild was interrupted or its status expired. Check before submitting again.',
            source: 'Select a valid video version on this page before rebuilding previews.',
            refresh: 'The page or account changed. Reopen the video details before submitting.'
        },
        zh: {
            button: '重建预览图', queued: '预览图重建排队中', running: '正在重建预览图',
            submitted: '已提交预览图重建，服务器将在后台处理。',
            duplicate: '此视频的预览图正在排队或处理中，请勿重复提交。',
            forbidden: '当前账号没有服务器管理权限，无法重建预览图。',
            busy: '重建请求较多，请稍后再试。',
            missing: '未找到重建接口或视频（HTTP 404），请确认已安装服务端插件。',
            method: '服务器拒绝了请求方式（HTTP 405），请检查代理配置。',
            incompatible: '重建插件不支持当前 Jellyfin 版本，请更新插件。',
            unavailable: '重建服务不可用（HTTP 503），请检查插件版本及服务器状态。',
            unsupported: '请检查媒体库是否启用了 Trickplay，以及视频文件是否可访问且受支持。',
            uncertain: '暂时无法确认是否提交成功，请先查看任务状态再重试。',
            failed: '未能确认预览图生成成功，请检查服务器日志。',
            completed: '预览图已重新生成。',
            lost: '重建已中断或状态已失效，请检查后再提交。',
            source: '请先在当前页面选择有效的视频版本，再重建预览图。',
            refresh: '页面或登录账号已改变，请重新打开视频详情后再提交。'
        }
    };
    let current = null;
    let scanTimer;
    const active = status => status?.state === 'queued' || status?.state === 'running';
    const guid = value => typeof value === 'string' &&
        /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)
        ? value.replaceAll('-', '').toLowerCase() : null;
    const language = () => /^zh\b/i.test(document.documentElement.lang || navigator.language) ? 'zh' : 'en';
    const text = key => messages[language()][key];

    function notify(key) {
        // Passing a string uses Jellyfin's actual toast component, including its theme/animation.
        try { pageWindow.Dashboard?.alert(text(key)); } catch { /* Never break the host page. */ }
    }

    function session() {
        try {
            const api = pageWindow.ApiClient;
            if (!api || typeof api.setRequestHeaders !== 'function' ||
                typeof pageWindow.Dashboard?.alert !== 'function') return null;
            const userId = guid(api.getCurrentUserId());
            const serverId = guid(api.serverId());
            const token = api.accessToken();
            const base = new URL(api.serverAddress());
            // No GM network privileges, cross-origin tokens, or redirected authenticated requests.
            if (!userId || !serverId || !token || base.origin !== location.origin ||
                !/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) return null;
            return { api, userId, serverId, token, base: base.href.replace(/\/$/, '') };
        } catch { return null; }
    }

    function route() {
        const hash = location.hash.replace(/^#!?\/?/, '');
        const [path, query = ''] = hash.split('?');
        if (path !== 'details') return null;
        const params = new URLSearchParams(query);
        const itemId = guid(params.get('id'));
        const serverId = params.get('serverId');
        if (!itemId || (serverId && !guid(serverId))) return null;
        return { itemId, serverId: guid(serverId) };
    }

    function sameSession(a, b) {
        return a && b && a.api === b.api && a.userId === b.userId &&
            a.serverId === b.serverId && a.token === b.token && a.base === b.base;
    }

    function live(ctx) {
        const target = route();
        return current === ctx && ctx.page.isConnected &&
            target?.itemId === ctx.itemId && (!target.serverId || target.serverId === ctx.session.serverId) &&
            sameSession(ctx.session, session());
    }

    function selectedSource(ctx) {
        const select = ctx.page.querySelector('.selectSource');
        const value = select?.value;
        const id = guid(value);
        if (id) return ctx.sources?.has(id) ? id : null;
        // Never silently rebuild the wrong version while a multiple-version selector is loading.
        if (value || ctx.sources?.size !== 1) return null;
        return ctx.sources.values().next().value;
    }

    async function request(ctx, path, method = 'GET', source = null) {
        if (!live(ctx)) throw { code: 'session_changed' };
        const url = new URL(ctx.session.base + '/' + path);
        if (source) url.searchParams.set('mediaSourceId', source);
        // Create the mutable argument in the page realm for Firefox userscript isolation.
        const pageHeaders = new pageWindow.Object();
        ctx.session.api.setRequestHeaders(pageHeaders);
        const headers = { Accept: 'application/json', Authorization: pageHeaders.Authorization };
        const controller = new AbortController();
        ctx.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            // Exactly one POST per click; a timeout never automatically resubmits a rebuild.
            const response = await fetch(url, {
                method, headers, signal: controller.signal, redirect: 'error',
                mode: 'same-origin', credentials: 'omit', cache: 'no-store'
            });
            let body;
            try { body = await response.json(); } catch { /* Proxies may return HTML. */ }
            if (!response.ok) throw { status: response.status, code: body?.code };
            if (!body || !live(ctx)) throw { code: 'invalid_response' };
            return body;
        } finally {
            clearTimeout(timeout);
            ctx.controllers.delete(controller);
        }
    }

    function render(ctx) {
        if (!ctx.button) return;
        const key = active(ctx.status) ? ctx.status.state : 'button';
        ctx.button.title = text(key);
        ctx.button.setAttribute('aria-label', text(key));
        ctx.button.setAttribute('aria-busy', String(ctx.submitting || active(ctx.status)));
        ctx.label.classList.toggle('hide', !active(ctx.status));
        const label = active(ctx.status) ? text(key) : '';
        if (ctx.label.textContent !== label) ctx.label.textContent = label;
    }

    function acceptStatus(ctx, body, source) {
        if (!live(ctx) || selectedSource(ctx) !== source) return;
        if (body.apiVersion !== 1 || guid(body.itemId) !== source || !guid(body.instanceId) ||
            !['none', 'queued', 'running', 'completed', 'failed', 'interrupted'].includes(body.state)) {
            throw { code: 'invalid_response' };
        }
        const previous = ctx.status;
        if (active(previous)) {
            if (body.instanceId !== previous.instanceId || body.state === 'none' || body.state === 'interrupted') notify('lost');
            else if (!active(body)) notify(body.state === 'completed' ? 'completed' : 'failed');
        }
        ctx.status = body;
        render(ctx);
    }

    function schedulePoll(ctx) {
        clearTimeout(ctx.pollTimer);
        if (live(ctx) && active(ctx.status) && !document.hidden) {
            ctx.pollTimer = setTimeout(() => checkStatus(ctx), 10000);
        }
    }

    async function checkStatus(ctx) {
        if (!live(ctx) || document.hidden || ctx.reading || ctx.submitting) return;
        const source = selectedSource(ctx);
        if (!source) return;
        ctx.reading = true;
        try {
            const body = await request(ctx, 'TrickplayRebuild/Items/' + ctx.itemId, 'GET', source);
            acceptStatus(ctx, body, source);
        } catch (error) {
            if (live(ctx) && selectedSource(ctx) === source && [401, 403].includes(error.status)) {
                ctx.button?.remove();
                ctx.label?.remove();
                ctx.status = null;
            }
            // Quiet initial capability checks; transient failures retry GET only for active work.
        } finally {
            ctx.reading = false;
            if (live(ctx) && selectedSource(ctx) !== source) void checkStatus(ctx);
            else schedulePoll(ctx);
        }
    }

    function errorMessage(error) {
        if (error.code === 'incompatible_server') return 'incompatible';
        if (error.code === 'session_changed') return 'refresh';
        return ({ 400: 'unsupported', 401: 'forbidden', 403: 'forbidden', 404: 'missing',
            405: 'method', 409: 'duplicate', 422: 'unsupported', 429: 'busy',
            500: 'failed', 502: 'failed', 503: 'unavailable' })[error.status] || 'uncertain';
    }

    async function submit(ctx) {
        if (!live(ctx)) { notify('refresh'); return; }
        const source = selectedSource(ctx);
        if (!source) { notify('source'); return; }
        if (source !== ctx.source) { ctx.source = source; ctx.status = null; }
        if (ctx.submitting || active(ctx.status)) { notify('duplicate'); return; }
        ctx.submitting = true;
        render(ctx);
        try {
            const body = await request(ctx, 'TrickplayRebuild/Items/' + ctx.itemId, 'POST', source);
            if (!live(ctx) || selectedSource(ctx) !== source) return;
            acceptStatus(ctx, body, source);
            notify('submitted');
        } catch (error) {
            if (live(ctx) && selectedSource(ctx) === source) notify(errorMessage(error));
        } finally {
            ctx.submitting = false;
            if (live(ctx)) {
                render(ctx);
                // This also reconciles a 409 or an uncertain POST without sending another POST.
                void checkStatus(ctx);
            }
        }
    }

    function createButton(ctx) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button ' + marker;
        const content = document.createElement('div');
        content.className = 'detailButton-content';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'detailButton-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        for (const d of [
            'M10 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v5M3 16l5-5 3 3 2-2',
            'M16 7a1 1 0 1 1-2 0a1 1 0 1 1 2 0',
            'M21.5 16a4.25 4.25 0 1 0 0 3M21.5 12.5V16H18'
        ]) {
            const path = document.createElementNS(svg.namespaceURI, 'path');
            path.setAttribute('d', d);
            svg.appendChild(path);
        }
        content.appendChild(svg);
        button.appendChild(content);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            void submit(ctx);
        });
        const bar = ctx.page.querySelector('.mainDetailButtons');
        const download = bar.querySelector('.btnDownload');
        if (download) download.after(button);
        else bar.appendChild(button);
        const label = document.createElement('div');
        label.className = 'itemMiscInfo hide ' + marker + '-status';
        label.setAttribute('role', 'status');
        label.setAttribute('aria-live', 'polite');
        bar.after(label);
        ctx.button = button;
        ctx.label = label;
        render(ctx);
    }

    function dispose() {
        if (!current) return;
        clearTimeout(current.pollTimer);
        for (const controller of current.controllers) controller.abort();
        current.button?.remove();
        current.label?.remove();
        current = null;
    }

    async function initialize(ctx) {
        try {
            const user = await ctx.session.api.getCurrentUser();
            if (!live(ctx) || user?.Policy?.IsAdministrator !== true) return;
            const item = await request(ctx, 'Users/' + ctx.session.userId + '/Items/' + ctx.itemId);
            if (!live(ctx) || guid(item.Id) !== ctx.itemId || item.IsFolder ||
                !['Movie', 'Episode', 'Video'].includes(item.Type)) return;
            ctx.sources = new Set((item.MediaSources || []).map(source => guid(source.Id)).filter(Boolean));
            if (!ctx.sources.size) return;
            createButton(ctx);
            ctx.source = selectedSource(ctx);
            void checkStatus(ctx);
        } catch { /* Missing APIs and unsupported pages must not affect the native page. */ }
    }

    function scan() {
        try {
            const target = route();
            const login = session();
            const page = [...document.querySelectorAll('.itemDetailPage')]
                .find(element => element.getClientRects().length && !element.closest('.hide'));
            if (!target || !login || !page || !page.querySelector('.mainDetailButtons') ||
                (target.serverId && target.serverId !== login.serverId)) { dispose(); return; }
            if (current && current.page === page && current.itemId === target.itemId && sameSession(current.session, login)) {
                const source = selectedSource(current);
                if (source !== current.source) {
                    current.source = source;
                    current.status = null;
                    render(current);
                    void checkStatus(current);
                }
                return;
            }
            dispose();
            const ctx = { page, itemId: target.itemId, session: login, controllers: new Set(),
                sources: new Set(), source: null, status: null, submitting: false, reading: false };
            current = ctx;
            void initialize(ctx);
        } catch { dispose(); }
    }

    function scheduleScan() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 100);
    }
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    for (const event of ['hashchange', 'popstate']) window.addEventListener(event, scheduleScan);
    for (const event of ['viewshow', 'viewdestroy']) document.addEventListener(event, scheduleScan, true);
    document.addEventListener('change', event => {
        if (event.target.matches?.('.selectSource')) scheduleScan();
    }, true);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearTimeout(current?.pollTimer);
        else { scan(); if (current && active(current.status)) void checkStatus(current); }
    });
    window.addEventListener('pagehide', () => { dispose(); });
    window.addEventListener('pageshow', scheduleScan);
    scan();
})();
