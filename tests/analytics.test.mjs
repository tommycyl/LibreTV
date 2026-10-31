import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const analyticsSource = readFileSync(new URL('../js/analytics.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const configSource = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const deployedConfig = vm.runInNewContext(`${configSource}\nANALYTICS_CONFIG;`);

function createPage({ baseUrl = deployedConfig.baseUrl, endpoints = deployedConfig.endpoints, enabled = true, debug = false, fetchImpl, query = ' 流浪地球 ', sources = ['one', 'two'] } = {}) {
    const calls = [];
    const listeners = new Map();
    const timers = new Map();
    const logs = [];
    let nextTimer = 0;
    const context = vm.createContext({
        ANALYTICS_CONFIG: { baseUrl, endpoints, enabled, debug, timeoutMs: 3000 },
        console: {
            info: (...args) => logs.push(args),
            warn: (...args) => logs.push(args),
        },
        window: {
            location: { pathname: '/', search: '?private=not-sent', hash: '#not-sent' },
            navigator: { userAgent: 'Test Browser', platform: 'Win32', language: 'zh-CN' },
            screen: { width: 1920, height: 1080 },
            devicePixelRatio: 1.5,
            innerWidth: 1280,
            innerHeight: 720,
        },
        Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }) },
        document: {
            readyState: 'loading',
            addEventListener(event, callback, options) {
                const list = listeners.get(event) || [];
                list.push({ callback, once: options?.once });
                listeners.set(event, list);
            },
            getElementById: () => ({ value: query }),
        },
        fetch: (url, options) => {
            calls.push({ url, options });
            return fetchImpl ? fetchImpl(url, options) : Promise.resolve({ ok: true });
        },
        AbortController,
        setTimeout(callback, delay) {
            const id = ++nextTimer;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout: id => timers.delete(id),
        localStorage: { getItem: key => key === 'selectedAPIs' ? JSON.stringify(sources) : null },
        API_SITES: {},
        showToast() {},
    });
    vm.runInContext(analyticsSource, context);
    return {
        context, calls, timers, logs,
        loadApp: () => vm.runInContext(appSource, context),
        fireReady() {
            const list = listeners.get('DOMContentLoaded') || [];
            listeners.set('DOMContentLoaded', list.filter(item => !item.once));
            for (const item of list) item.callback();
        },
    };
}

test('未配置接口或关闭埋点时不发送访问、搜索数据', async () => {
    for (const options of [{ endpoints: {} }, { endpoints: { home_visit: ' ', search: ' ' } }, { enabled: false }]) {
        const page = createPage(options);
        page.fireReady();
        await page.context.window.LibreTVAnalytics.track('search', '流浪地球');
        assert.equal(page.calls.length, 0);
        assert.equal(page.timers.size, 0);
    }
});

test('首页每次加载一次，发送 JSON 且不附带 Cookie、查询串或 hash', () => {
    const page = createPage();
    page.fireReady();
    page.fireReady();
    assert.equal(page.calls.length, 1);
    const { url, options } = page.calls[0];
    assert.equal(url, 'https://record.tommy.xx.kg/api/libre');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.keepalive, true);
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['device', 'event', 'keyword', 'occurred_at', 'page_path']);
    assert.equal(body.event, 'home_visit');
    assert.equal(body.keyword, null);
    assert.equal(body.page_path, '/');
    assert.ok(Number.isFinite(Date.parse(body.occurred_at)));
    assert.deepEqual(body.device, {
        user_agent: 'Test Browser',
        platform: 'Win32',
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        screen: { width: 1920, height: 1080, pixel_ratio: 1.5 },
        viewport: { width: 1280, height: 720 },
    });
});

test('浏览器缺少设备字段或时区 API 时，首页事件仍可上报', () => {
    const page = createPage();
    delete page.context.window.navigator;
    delete page.context.window.screen;
    delete page.context.window.devicePixelRatio;
    delete page.context.window.innerWidth;
    delete page.context.window.innerHeight;
    page.context.Intl.DateTimeFormat = () => { throw new Error('unavailable'); };
    page.fireReady();
    assert.equal(page.calls.length, 1);
    assert.deepEqual(JSON.parse(page.calls[0].options.body).device, {
        user_agent: null, platform: null, language: null, timezone: null,
        screen: { width: null, height: null, pixel_ratio: null },
        viewport: { width: null, height: null },
    });
});

test('搜索去除首尾空白，空搜索不发送；请求失败不抛出、不重试', async () => {
    const page = createPage({ fetchImpl: () => Promise.reject(new Error('offline')) });
    await page.context.window.LibreTVAnalytics.track('search', '  流浪地球  ');
    await page.context.window.LibreTVAnalytics.track('search', '   ');
    await new Promise(setImmediate);
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0].url, 'https://record.tommy.xx.kg/api/searchlist');
    assert.equal(JSON.parse(page.calls[0].options.body).keyword, '流浪地球');
    assert.equal(page.timers.size, 0);
});

test('达到超时时间会终止请求并清理计时器', async () => {
    const page = createPage({ fetchImpl: (_, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    const result = page.context.window.LibreTVAnalytics.track('search', '流浪地球');
    assert.equal(result, undefined);
    const timer = [...page.timers.values()][0];
    assert.equal(timer.delay, 3000);
    timer.callback();
    await new Promise(setImmediate);
    assert.equal(page.calls[0].options.signal.aborted, true);
    assert.equal(page.timers.size, 0);
});

test('实际搜索入口只上报一次，并在埋点仍未返回时继续执行搜索', async () => {
    const page = createPage({ fetchImpl: () => new Promise(() => {}) });
    page.loadApp();
    const searchStarted = new Error('search started');
    page.context.showLoading = () => { throw searchStarted; };
    await assert.rejects(page.context.search(), error => error === searchStarted);
    assert.equal(page.calls.length, 1); // 已选两个源，仍只生成一个搜索事件。
    const body = JSON.parse(page.calls[0].options.body);
    assert.equal(body.event, 'search');
    assert.equal(body.keyword, '流浪地球');
    assert.equal('device' in body, false);
});

test('两个接口立即返回、不读取响应内容，兼容同源及独立接口地址', async () => {
    const page = createPage({ fetchImpl: () => new Promise(() => {}) });
    assert.equal(page.context.window.LibreTVAnalytics.track('home_visit'), undefined);
    assert.equal(page.context.window.LibreTVAnalytics.track('search', '流浪地球'), undefined);
    assert.deepEqual(page.calls.map(call => call.url), [
        'https://record.tommy.xx.kg/api/libre',
        'https://record.tommy.xx.kg/api/searchlist',
    ]);
    const relative = createPage({ baseUrl: '' });
    relative.context.window.LibreTVAnalytics.track('home_visit');
    assert.equal(relative.calls[0].url, '/api/libre');
    const absolute = createPage({ endpoints: { search: 'https://api.example.com/search' } });
    absolute.context.window.LibreTVAnalytics.track('search', '流浪地球');
    assert.equal(absolute.calls[0].url, 'https://api.example.com/search');
    const unreadResponse = new Proxy({}, { get() { throw new Error('response must not be read'); } });
    const completed = createPage({ fetchImpl: () => Promise.resolve(unreadResponse) });
    completed.context.window.LibreTVAnalytics.track('home_visit');
    await new Promise(setImmediate);
    assert.equal(completed.timers.size, 0);
});

test('调试日志可区分发起请求与失败，且不输出关键词和设备信息', async () => {
    const page = createPage({ debug: true, fetchImpl: () => Promise.reject(new TypeError('network')) });
    page.fireReady();
    page.context.window.LibreTVAnalytics.track('search', 'private search keyword');
    await new Promise(setImmediate);
    assert.equal(page.logs.filter(args => args[0] === '[Analytics] 发起请求').length, 2);
    assert.equal(page.logs.filter(args => args[0] === '[Analytics] 请求未完成').length, 2);
    const text = JSON.stringify(page.logs);
    assert.equal(text.includes('private search keyword'), false);
    assert.equal(text.includes('Test Browser'), false);
    assert.equal(page.timers.size, 0);
});

test('空关键词、无选中源或未通过密码验证时不记录搜索', async () => {
    for (const options of [{ query: ' ' }, { sources: [] }, { protected: true }]) {
        const page = createPage(options);
        page.loadApp();
        if (options.protected) {
            page.context.window.isPasswordProtected = () => true;
            page.context.window.isPasswordVerified = () => false;
            page.context.showPasswordModal = () => {};
        }
        await page.context.search();
        assert.equal(page.calls.length, 0);
    }
});
