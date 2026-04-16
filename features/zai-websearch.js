let getSettings;

// ── data-source patching ─────────────────────────────────────────────

function getWebSearchBlock() {
    const checkbox = document.getElementById('openai_enable_web_search');
    return checkbox?.closest('[data-source]');
}

function patchDataSource(add) {
    const block = getWebSearchBlock();
    if (!block) return;

    // Read from jQuery's cache — that's what ST's visibility loop uses
    const $block = $(block);
    const sources = ($block.data('source') || '').split(',');
    const idx = sources.indexOf('zai');

    if (add && idx === -1) {
        sources.push('zai');
    } else if (!add && idx !== -1) {
        sources.splice(idx, 1);
    } else {
        return; // already in desired state
    }

    const joined = sources.join(',');
    // Update both jQuery's internal cache AND the DOM attribute
    $block.data('source', joined);
    block.setAttribute('data-source', joined);
}

// Show/hide the web search block based on current source
function refreshVisibility() {
    const block = getWebSearchBlock();
    if (!block) return;

    const source = document.getElementById('chat_completion_source')?.value;
    const sources = ($(block).data('source') || '').split(',');
    const mode = $(block).data('source-mode');
    const matches = sources.includes(source);
    $(block).toggle(mode !== 'except' ? matches : !matches);
}

// ── CHAT_COMPLETION_SETTINGS_READY handler ───────────────────────────

function onSettingsReady(generateData) {
    if (!getSettings().zaiWebSearch) return;
    if (generateData.chat_completion_source !== 'zai') return;
    if (!generateData.enable_web_search) return;

    if (!Array.isArray(generateData.tools)) {
        generateData.tools = [];
    }

    generateData.tools.push({
        type: 'web_search',
        web_search: {
            enable: true,
            search_engine: 'search_pro_jina',
        },
    });
}

// ── Public API ───────────────────────────────────────────────────────

export function setZaiWebSearch(enabled) {
    patchDataSource(enabled);
    refreshVisibility();
}

export function initZaiWebSearch(getSettingsFn, eventSource, event_types) {
    getSettings = getSettingsFn;

    if (getSettings().zaiWebSearch) {
        patchDataSource(true);
        refreshVisibility();
    }

    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
}
