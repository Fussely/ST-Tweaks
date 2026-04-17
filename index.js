import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { initBalanceColumns, enableBalanceColumns, disableBalanceColumns } from './features/balance-columns.js';
import { initResponsesApi } from './features/responses-api.js';
import { initDropdownLabel, applyLabel } from './features/dropdown-label.js';
import { initConnectionsTab, setFeatureEnabled } from './features/connections-tab.js';
import { initZaiWebSearch, setZaiWebSearch } from './features/zai-websearch.js';
import { initThinkingFix } from './features/thinking-fix.js';
import { initXhighOption, setXhighOption } from './features/xhigh-option.js';

const EXTENSION_NAME = 'third-party/st-tweaks';
const DEFAULTS = {
    balanceColumns: false,
    responsesApi: false,
    useResponsesApi: false,
    profileResponsesApi: {},
    fixGlm5Name: true,
    zaiWebSearch: false,
    fixThinkingAdaptive: false,
    cacheSystem: false,
    cacheAtDepth: -1,
    cacheTTL: '5m',
};

function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = structuredClone(DEFAULTS);
    }
    return extension_settings[EXTENSION_NAME];
}

jQuery(async () => {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    $('#extensions_settings2').append(html);

    const settings = getSettings();

    // ── Balance Columns ───────────────────────────────────────────
    const $balanceCheckbox = $('#stu_balance_columns');
    $balanceCheckbox.prop('checked', settings.balanceColumns);
    $balanceCheckbox.on('change', function () {
        settings.balanceColumns = this.checked;
        saveSettingsDebounced();
        if (this.checked) {
            enableBalanceColumns();
        } else {
            disableBalanceColumns();
        }
    });

    // ── Responses API: master feature toggle ───────────────────────
    const $responsesCheckbox = $('#stu_responses_api');
    $responsesCheckbox.prop('checked', settings.responsesApi);
    $responsesCheckbox.on('change', function () {
        settings.responsesApi = this.checked;
        saveSettingsDebounced();
        setFeatureEnabled(this.checked);
        applyLabel();
    });

    // ── Fix Z.AI glm-5 → glm-5.0 ─────────────────────────────────
    const $glm5Checkbox = $('#stu_fix_glm5');
    $glm5Checkbox.prop('checked', settings.fixGlm5Name);
    $glm5Checkbox.on('change', function () {
        settings.fixGlm5Name = this.checked;
        saveSettingsDebounced();
        applyGlm5Label(this.checked);
    });

    // Rewrite model name in outgoing API request (keeps dropdown value as glm-5 for profile compat)
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
        if (getSettings().fixGlm5Name && generateData.model === 'glm-5') {
            generateData.model = 'glm-5.0';
        }
    });

    // Safety net: 'xhigh' is only known to Opus 4.7+. On other models ST's native
    // calculateClaudeBudgetTokens has no xhigh case and silently drops thinking
    // entirely (adaptive models) or floors it to 1024 tokens (traditional thinking).
    // Downgrade to 'max' so thinking still happens. The thinking-fix interceptor
    // keeps 'xhigh' on Opus 4.7+ via its EFFORT_MAP.
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
        if (generateData.reasoning_effort === 'xhigh' &&
            !/^claude-opus-4-([7-9]|\d{2,})/.test(String(generateData.model || ''))) {
            generateData.reasoning_effort = 'max';
        }
    });

    // Opus 4.7+ rejects top_p and top_k as deprecated parameters. The thinking-fix
    // interceptor already strips them when it fires, but on reasoning_effort='auto'
    // it passes through to ST's native path which sends them and triggers a 400.
    // Strip here so both paths produce a valid request.
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
        if (/^claude-opus-4-([7-9]|\d{2,})/.test(String(generateData.model || ''))) {
            delete generateData.top_p;
            delete generateData.top_k;
        }
    });

    // ── Z.AI Web Search ──────────────────────────────────────────
    const $zaiWebSearchCheckbox = $('#stu_zai_websearch');
    $zaiWebSearchCheckbox.prop('checked', settings.zaiWebSearch);
    $zaiWebSearchCheckbox.on('change', function () {
        settings.zaiWebSearch = this.checked;
        saveSettingsDebounced();
        setZaiWebSearch(this.checked);
    });

    // ── Opus 4.7+ adaptive-thinking fix ──────────────────────────
    const $thinkingFixCheckbox = $('#stu_fix_thinking_adaptive');
    $thinkingFixCheckbox.prop('checked', settings.fixThinkingAdaptive);
    $thinkingFixCheckbox.on('change', function () {
        settings.fixThinkingAdaptive = this.checked;
        saveSettingsDebounced();
        setXhighOption(this.checked);
    });

    // ── Prompt caching (applies only when the bypass is active) ──
    const $cacheSystemCheckbox = $('#stu_cache_system');
    $cacheSystemCheckbox.prop('checked', settings.cacheSystem);
    $cacheSystemCheckbox.on('change', function () {
        settings.cacheSystem = this.checked;
        saveSettingsDebounced();
    });

    const $cacheDepthInput = $('#stu_cache_depth');
    $cacheDepthInput.val(settings.cacheAtDepth);
    $cacheDepthInput.on('change', function () {
        const parsed = parseInt(this.value, 10);
        // Clamp: any negative / NaN / garbage → -1 (off). Otherwise use the int.
        const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
        settings.cacheAtDepth = value;
        this.value = value; // reflect the normalized value back to the field
        saveSettingsDebounced();
    });

    const $cacheTtlSelect = $('#stu_cache_ttl');
    $cacheTtlSelect.val(settings.cacheTTL);
    $cacheTtlSelect.on('change', function () {
        settings.cacheTTL = this.value;
        saveSettingsDebounced();
    });

    // ── Feature inits ─────────────────────────────────────────────
    // Order matters: responses-api captures originalFetch at module-load (= native),
    // so we init it first, then thinking-fix captures window.fetch at init time
    // (= responses-api intercept). Runtime chain: thinking-fix → responses-api → native.
    initResponsesApi(getSettings);
    initThinkingFix(getSettings);
    initXhighOption(getSettings);
    initDropdownLabel(getSettings, eventSource, event_types);
    initConnectionsTab(
        getSettings,
        saveSettingsDebounced,
        () => applyLabel(),
        eventSource,
        event_types,
    );
    initZaiWebSearch(getSettings, eventSource, event_types);

    // Deferred init: wait for other extensions to finish loading
    setTimeout(() => {
        initBalanceColumns();
        if (settings.balanceColumns) {
            enableBalanceColumns();
        }
        if (settings.fixGlm5Name) applyGlm5Label(true);
    }, 1000);
});

function applyGlm5Label(enabled) {
    const option = document.querySelector('#model_zai_select option[value="glm-5"]');
    if (!option) return;
    option.textContent = enabled ? 'glm-5.0' : 'glm-5';
}
