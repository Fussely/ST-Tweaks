// Adds an "xhigh" entry to ST's Reasoning Effort dropdown
// (#openai_reasoning_effort) when the adaptive-thinking-fix toggle is on.
// The value passes through thinking-fix's EFFORT_MAP so `output_config.effort`
// is set to 'xhigh' on the outgoing Claude request.

import { oai_settings } from '../../../../openai.js';

const SELECT_ID = '#openai_reasoning_effort';
const OPTION_VALUE = 'xhigh';
const OPTION_LABEL = 'Extra High';
const FALLBACK_VALUE = 'max';

function hasOption($select) {
    return $select.find(`option[value="${OPTION_VALUE}"]`).length > 0;
}

export function setXhighOption(enabled) {
    const $select = $(SELECT_ID);
    if (!$select.length) return;

    if (enabled) {
        if (!hasOption($select)) {
            const $option = $(`<option value="${OPTION_VALUE}">${OPTION_LABEL}</option>`);
            const $maxOption = $select.find(`option[value="${FALLBACK_VALUE}"]`);
            if ($maxOption.length) $maxOption.before($option);
            else $select.append($option);
        }
        // If the saved setting is xhigh but ST reset the dropdown to blank/auto
        // during its own init (because the option didn't exist yet), restore it.
        if (oai_settings?.reasoning_effort === OPTION_VALUE && $select.val() !== OPTION_VALUE) {
            $select.val(OPTION_VALUE).trigger('change');
        }
        return;
    }

    // Disabling: revert if xhigh is currently selected, then strip the option.
    if ($select.val() === OPTION_VALUE) {
        $select.val(FALLBACK_VALUE).trigger('change');
    }
    $select.find(`option[value="${OPTION_VALUE}"]`).remove();
}

export function initXhighOption(getSettings) {
    if (getSettings().fixThinkingAdaptive) {
        setXhighOption(true);
    }
}
