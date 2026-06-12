let getSettings;

// ── data-source patching ─────────────────────────────────────────────

function getWebSearchBlock() {
    const checkbox = document.getElementById('openai_enable_web_search');
    return checkbox?.closest('[data-source]');
}

function patchDataSource(add) {
    const block = getWebSearchBlock();
    if (!block) return;

    const $block = $(block);
    const sources = ($block.data('source') || '').split(',');
    const idx = sources.indexOf('xai');

    if (add && idx === -1) {
        sources.push('xai');
    } else if (!add && idx !== -1) {
        sources.splice(idx, 1);
    } else {
        return;
    }

    const joined = sources.join(',');
    $block.data('source', joined);
    block.setAttribute('data-source', joined);
}

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

function isXaiSource(generateData) {
    if (generateData.chat_completion_source === 'xai') return true;
    return /grok/i.test(String(generateData.model || ''));
}

function onSettingsReady(generateData) {
    if (!getSettings().xaiWebSearch) return;
    if (!isXaiSource(generateData)) return;
    if (!generateData.enable_web_search) return;

    if (!Array.isArray(generateData.tools)) {
        generateData.tools = [];
    }

    generateData.tools.push({ type: 'web_search' });
}

// ── Public API ───────────────────────────────────────────────────────

export function setXaiWebSearch(enabled) {
    patchDataSource(enabled);
    refreshVisibility();
}

export function initXaiWebSearch(getSettingsFn, eventSource, event_types) {
    getSettings = getSettingsFn;

    if (getSettings().xaiWebSearch) {
        patchDataSource(true);
        refreshVisibility();
    }

    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
}
