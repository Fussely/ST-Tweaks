// Opus 4.7+ rejects `thinking.type: 'enabled'`. ST's server only flips to
// 'adaptive' for opus-4-6/sonnet-4-6 (chat-completions.js:233). For newer
// models we bypass ST's backend and POST to the reverse proxy directly
// with `thinking.type: 'adaptive'` + `output_config.effort`.
//
// Ports ST's Claude request flow (chat-completions.js:207-369) to the client:
// system extraction, consecutive-role merge, function tools, json_schema as
// forced tool, web_search, assistant_prefill, trailing-assistant-role flip,
// beta headers, and prompt caching (driven by extension settings — config.yaml
// values are server-side and not reachable from the browser).

import { createLogger, probeLogger } from '../../st-logger/logger-client.js';

const log = createLogger('ST Tweaks/thinking-fix');

const GENERATE_URL = '/api/backends/chat-completions/generate';
// reverse_proxy URLs already include the version segment (e.g. ".../v1"),
// matching ST's API_CLAUDE default. Only append /messages.
const CLAUDE_MESSAGES_PATH = '/messages';

// Models that require adaptive-only. Expand as more hit the same restriction.
const ADAPTIVE_ONLY_MODEL_RX = /^claude-opus-4-([7-9]|\d{2,})/;

// Mirrors calculateClaudeBudgetTokens() in ST's prompt-converters.js:1120,
// plus an extra `xhigh` passthrough surfaced by the xhigh-option feature.
const EFFORT_MAP = {
    auto: null,
    min: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
    xhigh: 'xhigh',
};

// Static beta headers ST always sends for Claude (chat-completions.js:224).
const BASE_BETA_HEADERS = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];

// Prompt-caching beta headers (chat-completions.js:298-299).
const CACHE_BETA_HEADERS = ['prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11'];

function notify(level, message) {
    if (typeof toastr !== 'undefined') {
        toastr[level]?.(message, 'ST Tweaks');
    }
}

let getSettings;
let originalFetch;

// ── Message conversion (OAI → Claude) ───────────────────────────────
// Mirrors ST's convertClaudeMessages (prompt-converters.js:197-342).

function imageUrlToBlock(part) {
    const url = part.image_url?.url || '';
    const mimeType = url.split(';')?.[0]?.split(':')?.[1] || 'image/png';
    const data = url.split(',')?.[1] || '';
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
}

function normalizeContent(rawContent, name) {
    if (typeof rawContent === 'string') {
        const text = name ? `${name}: ${rawContent}` : rawContent;
        return [{ type: 'text', text: text || '\u200b' }];
    }
    if (!Array.isArray(rawContent)) {
        return [{ type: 'text', text: '\u200b' }];
    }
    return rawContent.map(part => {
        if (part.type === 'image_url') return imageUrlToBlock(part);
        if (part.type === 'text') {
            const text = name ? `${name}: ${part.text || ''}` : (part.text || '');
            return { type: 'text', text: text || '\u200b' };
        }
        return part;
    });
}

function convertMessages(oaiMessages, prefillString, flipTrailingAssistant) {
    const systemParts = [];
    const others = [];

    // Step 1: Hoist only the leading run of system messages (prompt-converters.js:200-218).
    // Non-leading system messages (e.g. depth-0 post-history) stay in messages as user turns
    // so they sit after cache breakpoints and don't invalidate the system prefix.
    let cursor = 0;
    while (cursor < oaiMessages.length && oaiMessages[cursor].role === 'system') {
        const msg = oaiMessages[cursor];
        const text = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
                ? msg.content.filter(p => p.type === 'text').map(p => p.text || '').join('')
                : '';
        if (text) systemParts.push({ type: 'text', text });
        cursor++;
    }

    // Step 2: Convert each remaining message (prompt-converters.js:234-313).
    const parse = (s) => typeof s === 'string' ? JSON.parse(s) : s;
    for (let i = cursor; i < oaiMessages.length; i++) {
        const msg = oaiMessages[i];
        let role = msg.role;
        let content = msg.content;
        let name = msg.name;

        // Assistant with tool_calls → tool_use content blocks
        if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            content = msg.tool_calls.map(tc => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name,
                input: parse(tc.function?.arguments ?? '{}'),
            }));
        }

        // Tool role → user with tool_result (name prefix must not apply here)
        if (role === 'tool') {
            role = 'user';
            content = [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }];
            name = undefined;
        }

        // Non-leading system → user; ST explicitly deletes the name before content normalization,
        // so no name prefix is applied to these.
        if (role === 'system') {
            role = 'user';
            name = undefined;
        }

        // If content is already a block array (e.g. tool_use we just built), don't re-normalize.
        const isBlockArray = Array.isArray(content) && content.every(c => c && typeof c === 'object' && typeof c.type === 'string' && c.type !== 'image_url');
        const finalContent = isBlockArray ? content : normalizeContent(content, name);
        others.push({ role, content: finalContent });
    }

    // Step 3: Move images from assistant messages to the next user message (prompt-converters.js:316-332).
    // Claude rejects images in assistant turns.
    for (let i = 0; i < others.length; i++) {
        const m = others[i];
        if (m.role !== 'assistant' || !m.content.some(c => c.type === 'image')) continue;
        let j = i + 1;
        while (j < others.length && others[j].role !== 'user') j++;
        if (j >= others.length) others.splice(i + 1, 0, { role: 'user', content: [] });
        others[j].content.push(...m.content.filter(c => c.type === 'image'));
        m.content = m.content.filter(c => c.type !== 'image');
    }

    // Step 4: Append assistant prefill (chat-completions.js:227 → prompt-converters.js:336).
    const trimmed = typeof prefillString === 'string' ? prefillString.trimEnd() : '';
    if (trimmed) {
        others.push({ role: 'assistant', content: [{ type: 'text', text: trimmed }] });
    }

    // Step 5: Merge consecutive same-role blocks (Messages API alternation).
    const merged = [];
    for (const msg of others) {
        if (merged.length && merged[merged.length - 1].role === msg.role) {
            merged[merged.length - 1].content.push(...msg.content);
        } else {
            merged.push(msg);
        }
    }

    // Step 6: Thinking models reject a trailing assistant turn — flip to user to preserve content
    // (chat-completions.js:342).
    if (flipTrailingAssistant && merged.length && merged[merged.length - 1].role === 'assistant') {
        merged[merged.length - 1].role = 'user';
    }

    return { messages: merged, system: systemParts };
}

// ── Tools ───────────────────────────────────────────────────────────

// Port of util.js:flattenSchema (non-Google branch). Resolves $refs from $defs and
// strips the top-level $schema property so Claude's tool validator doesn't reject
// schemas that reference internal definitions.
function flattenSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const copy = structuredClone(schema);
    const defs = copy.$defs || {};
    delete copy.$defs;

    const resolve = (obj, parents = []) => {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(item => resolve(item, parents));
        if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/$defs/')) {
            const name = obj.$ref.split('/').pop();
            if (parents.includes(name)) return {};
            if (defs[name]) return resolve(structuredClone(defs[name]), [...parents, name]);
            return {};
        }
        const out = {};
        for (const key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            out[key] = resolve(obj[key], parents);
        }
        return out;
    };

    const flat = resolve(copy);
    delete flat.$schema;
    return flat;
}

function buildTools(chatBody) {
    const tools = [];
    let toolChoice = null;
    let hasFunctionTool = false;

    // Web search first (chat-completions.js:285-291)
    if (chatBody.enable_web_search) {
        tools.push({ type: 'web_search_20250305', name: 'web_search' });
    }

    // Function tools
    if (Array.isArray(chatBody.tools)) {
        for (const t of chatBody.tools) {
            if (t?.type !== 'function' || !t.function) continue;
            tools.push({
                name: t.function.name,
                description: t.function.description,
                input_schema: flattenSchema(t.function.parameters),
            });
            hasFunctionTool = true;
        }
        if (hasFunctionTool && chatBody.tool_choice) {
            toolChoice = { type: chatBody.tool_choice };
        }
    }

    // json_schema is a forced tool — overrides tool_choice (chat-completions.js:275)
    if (chatBody.json_schema) {
        tools.push({
            name: chatBody.json_schema.name,
            description: chatBody.json_schema.description || 'Well-formed JSON object',
            input_schema: flattenSchema(chatBody.json_schema.value),
        });
        toolChoice = { type: 'tool', name: chatBody.json_schema.name };
    }

    return { tools, toolChoice, hasFunctionTool };
}

// ── Prompt caching ──────────────────────────────────────────────────

// Tag the last system text block with cache_control (chat-completions.js:253).
function applySystemCache(systemParts, ttl) {
    if (!systemParts.length) return;
    systemParts[systemParts.length - 1].cache_control = { type: 'ephemeral', ttl };
}

// Port of cachingAtDepthForClaude (prompt-converters.js:981).
// Walks messages from the end, skips trailing assistant (prefill), adds
// cache_control at role-switch boundaries at depth N and depth N+2.
function applyMessagesCache(messages, depth, ttl) {
    if (depth < 0) return;
    let passedPrefill = false;
    let currentDepth = 0;
    let previousRole = '';

    for (let i = messages.length - 1; i >= 0; i--) {
        if (!passedPrefill && messages[i].role === 'assistant') continue;
        passedPrefill = true;

        if (messages[i].role !== previousRole) {
            if (currentDepth === depth || currentDepth === depth + 2) {
                const content = messages[i].content;
                content[content.length - 1].cache_control = { type: 'ephemeral', ttl };
            }
            if (currentDepth === depth + 2) break;
            currentDepth += 1;
            previousRole = messages[i].role;
        }
    }
}

// ── Claude request builder ──────────────────────────────────────────

function buildClaudeRequest(chatBody, effort, cacheOpts) {
    const { tools, toolChoice, hasFunctionTool } = buildTools(chatBody);
    const { messages, system } = convertMessages(chatBody.messages || [], chatBody.assistant_prefill, true);
    const maxTokens = chatBody.max_completion_tokens ?? chatBody.max_tokens ?? 4096;

    const cacheActive = cacheOpts.cacheSystem || cacheOpts.cacheAtDepth >= 0;
    if (cacheOpts.cacheSystem) applySystemCache(system, cacheOpts.ttl);
    // Tag the last tool with cache_control too when system caching is on, matching
    // chat-completions.js:269-271.
    if (cacheOpts.cacheSystem && tools.length) {
        tools[tools.length - 1].cache_control = { type: 'ephemeral', ttl: cacheOpts.ttl };
    }
    if (cacheOpts.cacheAtDepth >= 0) applyMessagesCache(messages, cacheOpts.cacheAtDepth, cacheOpts.ttl);

    const req = {
        model: chatBody.model,
        messages,
        max_tokens: maxTokens,
        stream: !!chatBody.stream,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
    };

    if (system.length) req.system = system;
    if (tools.length) req.tools = tools;
    if (toolChoice) req.tool_choice = toolChoice;

    // Opus 4.7+ adaptive mode: top_p and top_k are not accepted. Only temperature.
    if (chatBody.temperature != null) req.temperature = chatBody.temperature;

    if (Array.isArray(chatBody.stop) && chatBody.stop.length) {
        req.stop_sequences = chatBody.stop;
    }

    return { body: req, hasFunctionTool, cacheActive };
}

// ── Non-streaming response wrap (matches ST's reply shape at
//    chat-completions.js:387) ────────────────────────────────────────

function wrapOaiResponse(claudeResp) {
    const text = (claudeResp.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    return {
        choices: [{ message: { content: text } }],
        content: claudeResp.content,
    };
}

// ── Fetch interceptor ───────────────────────────────────────────────

async function interceptedFetch(url, options) {
    if (typeof url !== 'string' || !url.includes(GENERATE_URL) || options?.method !== 'POST' || !options?.body) {
        return originalFetch.call(this, url, options);
    }

    const settings = getSettings();
    if (!settings.fixThinkingAdaptive) {
        return originalFetch.call(this, url, options);
    }

    let chatBody;
    try { chatBody = JSON.parse(options.body); } catch {
        return originalFetch.call(this, url, options);
    }

    if (!chatBody.model || !ADAPTIVE_ONLY_MODEL_RX.test(chatBody.model)) {
        return originalFetch.call(this, url, options);
    }

    // Responses API handles its own thinking (reasoning.effort), no thinking.type conflict.
    if (settings.responsesApi && settings.useResponsesApi) {
        return originalFetch.call(this, url, options);
    }

    const customEffort = settings.customEffortEnabled ? settings.customEffort : '';
    const effort = customEffort || EFFORT_MAP[chatBody.reasoning_effort];
    if (!effort) {
        // No thinking requested — ST's server won't set thinking.type, so no error to fix.
        return originalFetch.call(this, url, options);
    }

    const proxyUrl = chatBody.reverse_proxy;
    if (!proxyUrl) {
        log.warn('no reverse_proxy in request body, passing through');
        notify('warning', 'thinking-fix skipped: no reverse_proxy in connection profile');
        return originalFetch.call(this, url, options);
    }

    const claudeUrl = proxyUrl.replace(/\/+$/, '') + CLAUDE_MESSAGES_PATH;
    const apiKey = chatBody.proxy_password || '';
    const wantsStream = !!chatBody.stream;

    const cacheOpts = {
        cacheSystem: !!settings.cacheSystem,
        cacheAtDepth: Number.isFinite(settings.cacheAtDepth) ? settings.cacheAtDepth : -1,
        ttl: settings.cacheTTL || '5m',
    };

    const { body: claudeBody, hasFunctionTool, cacheActive } = buildClaudeRequest(chatBody, effort, cacheOpts);

    const betaHeaders = [...BASE_BETA_HEADERS];
    if (hasFunctionTool) betaHeaders.push('tools-2024-05-16');
    if (cacheActive) betaHeaders.push(...CACHE_BETA_HEADERS);

    log.info(`→ ${claudeUrl}  (model=${claudeBody.model}, effort=${effort}, stream=${wantsStream}, tools=${claudeBody.tools?.length || 0}, cache=${cacheActive})`);
    log.debug('Claude request:', claudeBody);

    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': betaHeaders.join(','),
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    let upstream;
    try {
        upstream = await originalFetch.call(window, claudeUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(claudeBody),
        });
    } catch (err) {
        log.error('Upstream fetch threw:', err.message);
        notify('error', `thinking-fix fetch failed: ${err.message}`);
        return new Response(JSON.stringify({
            error: { message: `thinking-fix upstream failed: ${err.message}` },
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    if (!upstream.ok) {
        const rawText = await upstream.text();
        let errBody;
        try { errBody = JSON.parse(rawText); }
        catch { errBody = { error: { message: `${upstream.status} ${upstream.statusText}: ${rawText.slice(0, 500)}` } }; }
        log.warn(`Upstream returned ${upstream.status} ${upstream.statusText}`, errBody);
        const apiMsg = errBody?.error?.message || `${upstream.status} ${upstream.statusText}`;
        notify('error', `Claude API: ${apiMsg.slice(0, 200)}`);
        return new Response(JSON.stringify(errBody), {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Streaming: ST's client already parses Claude SSE because ST's backend
    // pipes it raw via forwardFetchResponse (chat-completions.js:373).
    // We tee the stream so we can log the decoded prompt text without
    // consuming the body that ST needs to read.
    if (wantsStream) {
        const [forSt, forLog] = upstream.body.tee();
        logStreamingResponse(forLog);
        return new Response(forSt, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
        });
    }

    const claudeResp = await upstream.json();
    log.debug('Claude response:', claudeResp);
    if (claudeResp.usage) {
        log.info(`Tokens — input: ${claudeResp.usage.input_tokens ?? 0}  output: ${claudeResp.usage.output_tokens ?? 0}  cache_read: ${claudeResp.usage.cache_read_input_tokens ?? 0}  cache_creation: ${claudeResp.usage.cache_creation_input_tokens ?? 0}`);
    }
    return new Response(JSON.stringify(wrapOaiResponse(claudeResp)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

// Stream SSE events to a logging sink; aggregates text deltas and usage so
// the final log shows the full response like ST's server-side does.
async function logStreamingResponse(stream) {
    try {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let fullThinking = '';
        let usage = null;
        let stopReason = null;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (!payload || payload === '[DONE]') continue;
                let evt;
                try { evt = JSON.parse(payload); } catch { continue; }

                if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                    fullText += evt.delta.text || '';
                } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
                    fullThinking += evt.delta.thinking || '';
                } else if (evt.type === 'message_delta') {
                    if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
                    if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
                } else if (evt.type === 'message_start' && evt.message?.usage) {
                    usage = { ...(usage || {}), ...evt.message.usage };
                }
            }
        }

        log.debug('Claude streamed response:', { stop_reason: stopReason, thinking: fullThinking, text: fullText });
        if (usage) {
            log.info(`Tokens — input: ${usage.input_tokens ?? 0}  output: ${usage.output_tokens ?? 0}  cache_read: ${usage.cache_read_input_tokens ?? 0}  cache_creation: ${usage.cache_creation_input_tokens ?? 0}`);
        }
    } catch (err) {
        log.warn('Stream logger failed:', err.message);
    }
}

export function initThinkingFix(getSettingsFn) {
    getSettings = getSettingsFn;
    // Capture at init time so we chain on top of any earlier interceptor (e.g. responses-api)
    originalFetch = window.fetch;
    window.fetch = interceptedFetch;
    probeLogger();
    log.info('installed (Opus 4.7+ adaptive bypass)');
}
