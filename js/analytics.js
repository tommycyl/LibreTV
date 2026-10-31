// 首页访问与搜索事件；独立发送，失败时不影响页面和搜索。
(function () {
    function getDeviceInfo() {
        const nav = window.navigator || {};
        const screen = window.screen || {};
        const dimension = value => Number.isFinite(value) && value > 0 ? value : null;
        let timezone = null;
        try {
            timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        } catch {
            // 部分浏览器不提供时区信息，其他设备字段仍正常上报。
        }
        return {
            user_agent: nav.userAgent || null,
            platform: nav.userAgentData?.platform || nav.platform || null,
            language: nav.language || null,
            timezone,
            screen: {
                width: dimension(screen.width),
                height: dimension(screen.height),
                pixel_ratio: dimension(window.devicePixelRatio),
            },
            viewport: {
                width: dimension(window.innerWidth),
                height: dimension(window.innerHeight),
            },
        };
    }

    function track(event, keyword = null) {
        let timeoutId;
        try {
            const config = typeof ANALYTICS_CONFIG === 'undefined' ? null : ANALYTICS_CONFIG;
            if (!config || !config.enabled) return;
            if (event !== 'home_visit' && event !== 'search') return;
            const endpoint = config.endpoints?.[event]?.trim();
            if (!endpoint) return;
            const baseUrl = (config.baseUrl || '').trim().replace(/\/+$/, '');
            const url = /^https?:\/\//i.test(endpoint) || !baseUrl
                ? endpoint
                : `${baseUrl}/${endpoint.replace(/^\/+/, '')}`;

            const searchKeyword = event === 'search' ? String(keyword || '').trim() : null;
            if (event === 'search' && !searchKeyword) return;

            const payload = {
                event,
                keyword: searchKeyword,
                occurred_at: new Date().toISOString(),
                page_path: window.location.pathname,
            };
            if (event === 'home_visit') payload.device = getDeviceInfo();

            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), config.timeoutMs || 3000);
            // 发出后立即返回；不读取响应状态或响应体，后台仅处理失败和释放计时器。
            void fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'omit',
                keepalive: true,
                signal: controller.signal,
                body: JSON.stringify(payload),
            }).catch(() => {}).finally(() => clearTimeout(timeoutId));
        } catch {
            // 同步异常也不打断业务；不自动重试，避免重复统计。
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
    }

    window.LibreTVAnalytics = { track };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => track('home_visit'), { once: true });
    } else {
        track('home_visit');
    }
})();
