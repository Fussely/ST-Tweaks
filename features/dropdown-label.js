const ORIGINAL_LABEL = 'Chat Completion';
const RESPONSES_LABEL = 'Responses';
const OPTION_SELECTOR = '#main_api option[value="openai"]';
const SUFFIX_SELECTOR = '.reverse_proxy_warning code';
const ORIGINAL_SUFFIX = '/chat/completions';
const RESPONSES_SUFFIX = '/responses';

const PROXY_SOURCES = new Set([
    'openai', 'claude', 'mistralai', 'makersuite',
    'vertexai', 'deepseek', 'xai', 'zai', 'moonshot',
]);

let getSettings;

export function applyLabel() {
    const source = document.getElementById('chat_completion_source')?.value;
    const s = getSettings();
    const active = s.responsesApi && s.useResponsesApi && PROXY_SOURCES.has(source);

    const option = document.querySelector(OPTION_SELECTOR);
    if (option) {
        option.textContent = active ? RESPONSES_LABEL : ORIGINAL_LABEL;
    }

    document.querySelectorAll(SUFFIX_SELECTOR).forEach(el => {
        if (el.textContent === ORIGINAL_SUFFIX || el.textContent === RESPONSES_SUFFIX) {
            el.textContent = active ? RESPONSES_SUFFIX : ORIGINAL_SUFFIX;
        }
    });
}

export function initDropdownLabel(getSettingsFn, eventSource, event_types) {
    getSettings = getSettingsFn;
    applyLabel();
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, () => applyLabel());
}
