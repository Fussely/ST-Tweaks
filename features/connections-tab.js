const CHECKBOX_ID = 'stu_responses_api_conn';
const WRAPPER_ID = 'stu_responses_api_conn_wrap';
const PROXY_SOURCES = new Set([
    'openai', 'claude', 'mistralai', 'makersuite',
    'vertexai', 'deepseek', 'xai', 'zai', 'moonshot',
]);

let getSettings;
let save;
let syncLabel;

// ── DOM injection ─────────────────────────────────────────────────

function injectCheckbox() {
    if (document.getElementById(CHECKBOX_ID)) return;

    const html = `
        <div id="${WRAPPER_ID}" class="range-block" style="display:none">
            <label class="checkbox_label" for="${CHECKBOX_ID}">
                <input type="checkbox" id="${CHECKBOX_ID}" />
                <span>Use Responses API</span>
            </label>
        </div>`;

    const sourceSelect = document.getElementById('chat_completion_source');
    if (sourceSelect) {
        sourceSelect.insertAdjacentHTML('afterend', html);
    }
}

// ── Visibility ────────────────────────────────────────────────────

function updateVisibility() {
    const wrapper = document.getElementById(WRAPPER_ID);
    if (!wrapper) return;

    const source = document.getElementById('chat_completion_source')?.value;
    const visible = getSettings().responsesApi && PROXY_SOURCES.has(source);
    wrapper.style.display = visible ? '' : 'none';
}

// ── Checkbox wiring ───────────────────────────────────────────────

function wireCheckbox() {
    const cb = document.getElementById(CHECKBOX_ID);
    if (!cb) return;

    cb.checked = getSettings().useResponsesApi;

    cb.addEventListener('change', () => {
        const enabled = cb.checked;
        getSettings().useResponsesApi = enabled;
        savePerProfile(enabled);
        save();
        syncLabel();
    });
}

// ── Per-profile persistence ───────────────────────────────────────

function getConnectionManager() {
    try {
        const ext = window.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager;
        return ext ?? null;
    } catch {
        return null;
    }
}

function savePerProfile(enabled) {
    const cm = getConnectionManager();
    const profileId = cm?.selectedProfile;
    if (!profileId) return;

    const settings = getSettings();
    if (!settings.profileResponsesApi) settings.profileResponsesApi = {};
    settings.profileResponsesApi[profileId] = enabled;
}

function onProfileLoaded(profileName) {
    const NONE = '<None>';
    if (!profileName || profileName === NONE) return;

    const cm = getConnectionManager();
    if (!cm?.profiles) return;

    const profile = cm.profiles.find(p => p.name === profileName);
    if (!profile) return;

    const map = getSettings().profileResponsesApi;
    const stored = map?.[profile.id] ?? false;
    getSettings().useResponsesApi = stored;
    save();

    const cb = document.getElementById(CHECKBOX_ID);
    if (cb) cb.checked = stored;
    syncLabel();
}

// ── Public API ────────────────────────────────────────────────────

export function setFeatureEnabled(enabled) {
    updateVisibility();

    // When master toggle turns off, deactivate and sync
    if (!enabled) {
        const cb = document.getElementById(CHECKBOX_ID);
        if (cb) cb.checked = false;
        getSettings().useResponsesApi = false;
        save();
        syncLabel();
    }
}

// ── Init ──────────────────────────────────────────────────────────

export function initConnectionsTab(getSettingsFn, saveFn, syncLabelFn, eventSource, event_types) {
    getSettings = getSettingsFn;
    save = saveFn;
    syncLabel = syncLabelFn;

    injectCheckbox();
    wireCheckbox();
    updateVisibility();

    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, onProfileLoaded);
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, () => updateVisibility());
}
