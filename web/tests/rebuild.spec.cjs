const { test, expect } = require('@playwright/test');
const path = require('node:path');

const itemId = 'a'.repeat(32);
const alternateId = 'b'.repeat(32);
const serverId = 'e'.repeat(32);
const instanceId = 'f'.repeat(32);
const script = path.resolve(__dirname, '../trickplay-rebuild.user.js');

async function open(page, options = {}) {
    const prefix = options.prefix || '';
    const base = 'http://jellyfin.test' + prefix;
    const state = { requests: [], status: 'none', postStatus: 202, postCode: '', instanceId, ...options };
    await page.route('http://jellyfin.test/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.isNavigationRequest()) {
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head>
                <meta name="application-name" content="${options.application || 'Jellyfin'}">
                <style>.hide {display:none !important} .mainDetailButtons {display:flex} button {width:48px;height:48px}</style>
                </head><body><div class="itemDetailPage"><div class="mainDetailButtons">
                <button class="button-flat detailButton btnPlay">Play</button>
                <button class="button-flat detailButton btnDownload">Download</button>
                <button class="button-flat detailButton btnMoreCommands">More</button></div>
                <select class="selectSource"><option value="${itemId}">Main</option>
                ${options.multiple ? `<option value="${alternateId}">Alternate</option>` : ''}</select></div></body></html>` });
        }
        state.requests.push({ path: url.pathname, method: request.method(), query: url.searchParams,
            authorization: request.headers().authorization });
        if (url.pathname.includes('/Users/')) {
            return route.fulfill({ json: { Id: itemId, Type: options.type || 'Movie', IsFolder: !!options.folder,
                Name: '<img src=x onerror=alert(1)>',
                MediaSources: [{ Id: itemId }, ...(options.multiple ? [{ Id: alternateId }] : [])] } });
        }
        if (url.pathname.includes('/TrickplayRebuild/')) {
            if (request.method() === 'POST') {
                if (state.abortPost) return route.abort();
                if (state.postStatus === 202 || state.postStatus === 409) state.status = 'queued';
                if (state.postStatus !== 202) return route.fulfill({ status: state.postStatus, json: { code: state.postCode } });
            }
            return route.fulfill({ status: request.method() === 'POST' ? 202 : 200, json: {
                apiVersion: 1, instanceId: state.instanceId, itemId: url.searchParams.get('mediaSourceId'), state: state.status
            } });
        }
        return route.fulfill({ status: 404 });
    });
    await page.addInitScript(({ base, admin, serverId, crossOrigin }) => {
        window.unsafeWindow = window;
        window.fixtureToken = 'test-token';
        window.toasts = [];
        window.ApiClient = {
            getCurrentUserId: () => 'd'.repeat(32), serverId: () => serverId,
            accessToken: () => window.fixtureToken,
            serverAddress: () => crossOrigin || base,
            setRequestHeaders: headers => { headers.Authorization = 'MediaBrowser Token="test-token"'; },
            getCurrentUser: async () => ({ Policy: { IsAdministrator: admin } })
        };
        window.Dashboard = { alert: message => { window.toasts.push(message); } };
    }, { base, admin: options.admin !== false, serverId, crossOrigin: options.crossOrigin });
    await page.goto(base + '/web/index.html#!/details?id=' + itemId + '&serverId=' + serverId);
    await page.addScriptTag({ path: script });
    return state;
}

const button = page => page.locator('.jf-trickplay-rebuild');
const posts = state => state.requests.filter(r => r.method === 'POST');
const reads = state => state.requests.filter(r => r.path.includes('/TrickplayRebuild/') && r.method === 'GET');
const toast = (page, value) => expect.poll(() => page.evaluate(() => window.toasts.at(-1))).toContain(value);

test('uses the native detail button position, SVG, cached identity and same-origin auth', async ({ page }) => {
    const state = await open(page, { prefix: '/jellyfin' });
    await expect(button(page)).toBeVisible();
    await expect(page.locator('.btnDownload + .jf-trickplay-rebuild + .btnMoreCommands')).toHaveCount(1);
    await expect(button(page)).toHaveClass(/emby-button/);
    await expect(button(page).locator('svg')).toHaveAttribute('stroke', 'currentColor');
    await button(page).click();
    await toast(page, '已提交');
    expect(posts(state)).toHaveLength(1);
    expect(posts(state)[0].path).toBe('/jellyfin/TrickplayRebuild/Items/' + itemId);
    expect(posts(state)[0].authorization).toBe('MediaBrowser Token="test-token"');
    expect(posts(state)[0].query.has('api_key')).toBe(false);
    expect(await page.locator('img').count()).toBe(0);
});

for (const options of [{ admin: false }, { type: 'Series', folder: true }, { application: 'Emby' }, { crossOrigin: 'https://other.example' }]) {
    test('does not add an execution button for ' + JSON.stringify(options), async ({ page }) => {
        const state = await open(page, options);
        await page.waitForTimeout(250);
        await expect(button(page)).toHaveCount(0);
        expect(posts(state)).toHaveLength(0);
        if (options.crossOrigin || options.application || options.admin === false) expect(state.requests).toHaveLength(0);
    });
}

test('uses the selected native media version and rejects an injected source ID', async ({ page }) => {
    const state = await open(page, { multiple: true });
    await expect(button(page)).toBeVisible();
    await page.selectOption('.selectSource', alternateId);
    await button(page).click();
    await toast(page, '已提交');
    expect(posts(state)[0].query.get('mediaSourceId')).toBe(alternateId);
    await page.evaluate(() => {
        const select = document.querySelector('.selectSource');
        const option = new Option('Unrelated', 'c'.repeat(32));
        select.add(option); select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await button(page).click();
    await toast(page, '有效的视频版本');
    expect(posts(state)).toHaveLength(1);
});

test('prevents duplicate clicks, reports completion and stops polling when idle', async ({ page }) => {
    const state = await open(page);
    await expect(button(page)).toBeVisible();
    await expect.poll(() => reads(state).length).toBe(1);
    await page.clock.install();
    await button(page).click();
    await toast(page, '已提交');
    await button(page).click();
    await toast(page, '请勿重复提交');
    expect(posts(state)).toHaveLength(1);
    state.status = 'completed';
    await page.clock.runFor(10500);
    await toast(page, '已重新生成');
    const count = reads(state).length;
    await page.clock.runFor(30000);
    expect(reads(state)).toHaveLength(count);
    await expect(page.locator('.jf-trickplay-rebuild-status')).toBeHidden();
});

for (const [postStatus, postCode, message] of [
    [403, '', '没有服务器管理权限'], [409, 'already_running', '请勿重复提交'],
    [404, '', 'HTTP 404'], [405, '', 'HTTP 405'], [503, 'incompatible_server', '不支持当前'],
    [422, 'trickplay_disabled', '启用了 Trickplay'], [429, 'rate_limited', '请求较多']
]) {
    test('reports HTTP ' + postStatus + ' using the native toast API', async ({ page }) => {
        const state = await open(page, { postStatus, postCode });
        await expect(button(page)).toBeVisible();
        await button(page).click();
        await toast(page, message);
        expect(posts(state)).toHaveLength(1);
    });
}

test('does not retry an uncertain POST', async ({ page }) => {
    const state = await open(page, { abortPost: true });
    await expect(button(page)).toBeVisible();
    await button(page).click();
    await toast(page, '暂时无法确认');
    await page.clock.install();
    await page.clock.runFor(30000);
    expect(posts(state)).toHaveLength(1);
});

test('cleans up on SPA navigation and suppresses work after account changes', async ({ page }) => {
    const state = await open(page);
    await expect(button(page)).toBeVisible();
    await page.evaluate(() => { window.fixtureToken = null; });
    await button(page).click();
    await toast(page, '登录账号已改变');
    expect(posts(state)).toHaveLength(0);
    await page.evaluate(() => { location.hash = '#/home'; });
    await expect(button(page)).toHaveCount(0);
    await page.clock.install();
    const count = state.requests.length;
    await page.clock.runFor(30000);
    expect(state.requests).toHaveLength(count);
});

test('keeps one button when details are restored or the script runs twice', async ({ page }) => {
    await open(page);
    await expect(button(page)).toBeVisible();
    await page.addScriptTag({ path: script });
    await page.evaluate(() => document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewshow', { bubbles: true })));
    await expect(button(page)).toHaveCount(1);
});
