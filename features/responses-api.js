import { createLogger, probeLogger } from '../../st-logger/logger-client.js';

const GENERATE_URL = '/api/backends/chat-completions/generate';
const PASSTHROUGH_PARAMS = [
    'temperature', 'top_p', 'top_k', 'stop',
];

const log = createLogger('ST Tweaks');

let getSettings;
const originalFetch = window.fetch;

// ── Request transform ──────────────────────────────────────────────

function transformRequest(chat) {
    const req = { model: chat.model, store: false };

    // System messages → instructions
    if (Array.isArray(chat.messages)) {
        const systemParts = chat.messages
            .filter(m => m.role === 'system')
            .map(m => typeof m.content === 'string' ? m.content : '')
            .filter(Boolean);

        if (systemParts.length) {
            req.instructions = systemParts.join('\n\n');
        }

        req.input = chat.messages.filter(m => m.role !== 'system');
    }

    // Renamed params
    const maxTokens = chat.max_completion_tokens ?? chat.max_tokens;
    if (maxTokens != null) req.max_output_tokens = maxTokens;

    // Pass-through params (stream intentionally excluded — always non-streaming)
    for (const key of PASSTHROUGH_PARAMS) {
        if (chat[key] != null) req[key] = chat[key];
    }

    // Reasoning effort: ST sends flat `reasoning_effort`, Responses API expects nested object
    if (chat.reasoning_effort) {
        const EFFORT_MAP = { min: 'minimal', max: 'xhigh' };
        const effort = EFFORT_MAP[chat.reasoning_effort] ?? chat.reasoning_effort;
        req.reasoning = { effort };
    }

    // Verbosity: controls output length (GPT-5+)
    if (chat.verbosity) {
        req.text = { verbosity: chat.verbosity };
    }

    return req;
}

// ── Response transform (Responses API → Chat Completions) ─────────

function transformResponse(resp) {
    const text = (resp.output ?? [])
        .filter(item => item.type === 'message')
        .flatMap(item => item.content ?? [])
        .filter(part => part.type === 'output_text')
        .map(part => part.text)
        .join('');

    const finishReason = resp.status === 'incomplete' ? 'length' : 'stop';

    return {
        id: resp.id ?? 'resp-unknown',
        object: 'chat.completion',
        created: resp.created_at ?? Math.floor(Date.now() / 1000),
        model: resp.model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: text || null },
            finish_reason: finishReason,
        }],
        usage: resp.usage ? {
            prompt_tokens: resp.usage.input_tokens ?? 0,
            completion_tokens: resp.usage.output_tokens ?? 0,
            total_tokens: resp.usage.total_tokens ?? 0,
            prompt_tokens_details: resp.usage.input_tokens_details
                ? { cached_tokens: resp.usage.input_tokens_details.cached_tokens ?? 0 }
                : undefined,
        } : undefined,
    };
}

// ── Synthetic SSE stream from a complete Chat Completions response ─

function createSyntheticStream(chatData) {
    const encoder = new TextEncoder();
    const text = chatData.choices?.[0]?.message?.content ?? '';

    return new ReadableStream({
        start(controller) {
            // Emit full text as a single delta
            if (text) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    choices: [{ delta: { content: text } }],
                })}\n\n`));
            }

            // Emit finish + usage
            const finalChunk = {
                choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
            };
            if (chatData.usage) {
                finalChunk.usage = chatData.usage;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    });
}

// ── Fetch interceptor ──────────────────────────────────────────────

async function interceptedFetch(url, options) {
    if (typeof url !== 'string' || !url.includes(GENERATE_URL) || options?.method !== 'POST' || !options?.body) {
        return originalFetch.call(this, url, options);
    }

    const settings = getSettings();
    if (!settings.responsesApi || !settings.useResponsesApi) {
        return originalFetch.call(this, url, options);
    }

    let chatBody;
    try { chatBody = JSON.parse(options.body); } catch {
        return originalFetch.call(this, url, options);
    }

    const proxyUrl = chatBody.reverse_proxy;
    if (!proxyUrl) {
        return originalFetch.call(this, url, options);
    }

    const wantsStream = !!chatBody.stream;
    const apiKey = chatBody.proxy_password || '';
    const responsesUrl = proxyUrl.replace(/\/+$/, '') + '/responses';
    const responsesBody = transformRequest(chatBody);

    log.debug('Responses API request:', responsesBody);
    log.info(`Responses API → ${responsesUrl} ${wantsStream ? '(simulated stream)' : '(non-stream)'}`);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    let upstreamResponse;
    try {
        upstreamResponse = await originalFetch.call(window, responsesUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(responsesBody),
        });
    } catch (err) {
        log.error('Upstream fetch failed:', err.message);
        return new Response(JSON.stringify({
            error: { message: `Responses API request failed: ${err.message}` },
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    if (!upstreamResponse.ok) {
        let errorBody;
        try {
            errorBody = await upstreamResponse.json();
        } catch {
            errorBody = { error: { message: `${upstreamResponse.status} ${upstreamResponse.statusText}` } };
        }
        log.warn(`Upstream returned ${upstreamResponse.status} ${upstreamResponse.statusText}`, errorBody);
        return new Response(JSON.stringify(errorBody), {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Always get complete JSON from proxy (streaming not reliable on proxies)
    const respData = await upstreamResponse.json();
    log.debug('Responses API raw response:', respData);

    const chatData = transformResponse(respData);

    if (chatData.usage) {
        log.debug(`Tokens — input: ${chatData.usage.prompt_tokens}  output: ${chatData.usage.completion_tokens}  total: ${chatData.usage.total_tokens}`);
    }

    // If ST expects streaming, synthesize an SSE stream from the complete response
    if (wantsStream) {
        return new Response(createSyntheticStream(chatData), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        });
    }

    return new Response(JSON.stringify(chatData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

// ── Init ───────────────────────────────────────────────────────────

export function initResponsesApi(getSettingsFn) {
    getSettings = getSettingsFn;
    window.fetch = interceptedFetch;
    probeLogger();
}
