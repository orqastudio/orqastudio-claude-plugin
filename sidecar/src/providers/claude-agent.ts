/**
 * Claude Agent SDK provider for the OrqaStudio sidecar.
 *
 * Uses @anthropic-ai/claude-agent-sdk which spawns the official Claude Code
 * CLI binary. Authentication is handled via Claude Max subscription OAuth —
 * no API key needed.
 *
 * Manages per-session conversation state and streams Agent SDK responses
 * back as SidecarResponse events over the NDJSON protocol.
 */

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Provider, ResponseSender } from '../provider-interface.js';
import type {
    SidecarResponse,
    MessageSummary,
    ToolResultRequest,
    ToolApprovalRequest,
} from '../protocol.js';

// ── Module-level constants ──

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Resolve the path to the Agent SDK's bundled cli.js.
 *
 * When the sidecar is compiled with `bun build`, import.meta resolution
 * points to the dist directory instead of node_modules. We use
 * createRequire to resolve the SDK package path reliably.
 */
function resolveSdkCliPath(): string {
    try {
        const require = createRequire(import.meta.url);
        const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
        return path.join(path.dirname(sdkPath), 'cli.js');
    } catch {
        // Fallback: assume node_modules is a sibling of the sidecar dir
        return path.resolve(process.cwd(), 'sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
    }
}

const SDK_CLI_PATH = resolveSdkCliPath();

const SUMMARY_SYSTEM_PROMPT =
    'Generate a short title (3-5 words max) for this conversation. ' +
    'No quotes, no punctuation, no prefix. Just the title.';

const TOOL_SYSTEM_PROMPT = `You have access to these tools:
- read_file: Read a file from the filesystem
- write_file: Write content to a file
- edit_file: Edit a file with search and replace
- bash: Execute a bash command
- glob: Find files matching a glob pattern
- grep: Search file contents with regex
- search_regex: Search indexed codebase with a regex pattern (must be indexed first)
- search_semantic: Search codebase using natural language (semantic similarity, must be indexed with embeddings first)
- code_research: Research the codebase using combined regex and semantic search — best for understanding how features work end-to-end
- load_skill: Load the full content of a project skill by name

Use these tools by their short names. When referencing tools in your responses, use the short name (e.g. "read_file" not "mcp__orqa__read_file").

For understanding code structure, use grep with relevant patterns. For precise text matching, use grep. For searching the indexed codebase, use search_regex. For natural language code search, use search_semantic. Use load_skill to load skill documentation before applying its guidance.`;

// ── Helper ──

/**
 * Strip MCP server prefixes from tool names.
 * e.g. "mcp__orqa__read_file" → "read_file"
 */
function stripMcpPrefix(name: string): string {
    const match = name.match(/^mcp__[^_]+__(.+)$/);
    return match ? match[1] : name;
}

/**
 * Resolve the model string. If "auto" or null/undefined, use the default.
 */
function resolveModel(model: string | null): string {
    if (!model || model === 'auto') {
        return DEFAULT_MODEL;
    }
    return model;
}

// ── Error classification ──

interface ErrorInfo {
    code: string;
    message: string;
    recoverable: boolean;
}

/**
 * Classify an error into a code, message, and recoverable flag.
 * With the Agent SDK, errors come from the CLI process rather than
 * the HTTP API directly, so classification is simpler.
 */
function classifyError(error: unknown): ErrorInfo {
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();

        if (
            error.name === 'AbortError' ||
            msg.includes('aborted') ||
            msg.includes('cancelled')
        ) {
            return {
                code: 'cancelled',
                message: 'Request was cancelled',
                recoverable: false,
            };
        }

        if (msg.includes('auth') || msg.includes('login') || msg.includes('oauth')) {
            return {
                code: 'auth_error',
                message: `Authentication error: ${error.message}. Ensure Claude Code CLI is logged in with a Max subscription.`,
                recoverable: false,
            };
        }

        if (msg.includes('rate limit') || msg.includes('429')) {
            return {
                code: 'rate_limit',
                message: error.message,
                recoverable: true,
            };
        }

        if (msg.includes('overloaded') || msg.includes('529')) {
            return {
                code: 'overloaded',
                message: error.message,
                recoverable: true,
            };
        }

        if (msg.includes('not found') || msg.includes('enoent')) {
            return {
                code: 'cli_not_found',
                message: `Claude Code CLI not found: ${error.message}. Ensure the CLI is installed and in PATH.`,
                recoverable: false,
            };
        }

        return {
            code: 'sdk_error',
            message: error.message,
            recoverable: false,
        };
    }

    return {
        code: 'unknown_error',
        message: String(error),
        recoverable: false,
    };
}

/**
 * Translate an Agent SDK message into SidecarResponse events.
 *
 * The Agent SDK yields partial messages that contain content blocks.
 * We translate text blocks to text_delta, thinking blocks to thinking_delta,
 * and tool_use blocks to tool_use_start/tool_input_delta events.
 */
function translateAgentMessage(
    message: unknown,
    sendResponse: ResponseSender,
    _previousBlockCount: number,
): void {
    if (!message || typeof message !== 'object') {
        return;
    }

    const msg = message as Record<string, unknown>;

    if ('content' in msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
            if (!block || typeof block !== 'object') {
                continue;
            }

            const b = block as Record<string, unknown>;

            if (b.type === 'text' && typeof b.text === 'string') {
                sendResponse({
                    type: 'text_delta',
                    content: b.text,
                });
            } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
                sendResponse({
                    type: 'thinking_delta',
                    content: b.thinking,
                });
            } else if (b.type === 'tool_use') {
                // Tool use blocks are handled by the MCP server callbacks,
                // but we emit tracking events for the frontend.
                // Skip OrqaStudio tools — executeToolViaRust already emits these events.
                const isOrqa = typeof b.name === 'string' && b.name.startsWith('mcp__orqa__');
                if (!isOrqa) {
                    if (typeof b.id === 'string' && typeof b.name === 'string') {
                        sendResponse({
                            type: 'tool_use_start',
                            tool_call_id: b.id,
                            tool_name: stripMcpPrefix(b.name),
                        });
                    }
                    if (typeof b.input === 'string') {
                        sendResponse({
                            type: 'tool_input_delta',
                            tool_call_id: typeof b.id === 'string' ? b.id : '',
                            content: b.input,
                        });
                    } else if (b.input !== undefined && b.input !== null) {
                        sendResponse({
                            type: 'tool_input_delta',
                            tool_call_id: typeof b.id === 'string' ? b.id : '',
                            content: JSON.stringify(b.input),
                        });
                    }
                }
            }
        }
    }
}

// ── ClaudeAgentProvider ──

/**
 * Provider implementation backed by the Anthropic Claude Agent SDK.
 *
 * Each instance owns its session state independently, allowing multiple
 * provider instances to coexist without sharing mutable state.
 */
export class ClaudeAgentProvider implements Provider {
    readonly name = 'claude-agent';

    // ── Instance state ──

    /** Per-session abort controllers for cancellation. */
    private readonly activeStreams = new Map<number, AbortController>();

    /** Monotonically increasing message ID counter. */
    private nextMessageId = 1;

    /**
     * Monotonically increasing tool call ID counter.
     * Used to correlate tool_execute/tool_result and
     * tool_approval_request/tool_approval exchanges.
     */
    private nextToolCallId = 1;

    /**
     * Maps OrqaStudio session IDs to provider session IDs.
     * The SDK uses its own UUID-based session IDs for conversation persistence.
     * On the first message in an OrqaStudio session, we start a new SDK
     * conversation and capture the session ID. Subsequent messages use `resume`
     * to continue the same conversation, giving Claude access to the full history.
     */
    private readonly providerSessionMap = new Map<number, string>();

    /**
     * Pending requests waiting for tool_result responses from Rust via stdin.
     * Key is tool_call_id, value is the resolve function for the promise.
     */
    private readonly pendingToolResults = new Map<
        string,
        (result: ToolResultRequest) => void
    >();

    private readonly pendingToolApprovals = new Map<
        string,
        (result: ToolApprovalRequest) => void
    >();

    // ── Public API (Provider interface) ──

    /** Respond to a health check with the sidecar version. */
    healthCheck(send: ResponseSender): void {
        send({
            type: 'health_ok',
            version: '0.1.0',
        });
    }

    /**
     * Stream a message using the Claude Agent SDK query() function.
     *
     * The Agent SDK spawns the Claude Code CLI which handles authentication
     * via Claude Max subscription OAuth. No API key is needed.
     *
     * Tool calls are routed through the NDJSON protocol to Rust for execution.
     * Tool approval decisions are routed through the NDJSON protocol to the UI.
     */
    async streamMessage(
        sessionId: number,
        content: string,
        model: string | null,
        systemPrompt: string | null,
        send: ResponseSender,
        providerSessionId: string | null = null,
        enableThinking: boolean = false,
    ): Promise<void> {
        const resolvedModel = resolveModel(model);
        const messageId = this.nextMessageId++;

        const abortController = new AbortController();
        this.activeStreams.set(sessionId, abortController);

        const orqaToolServer = this.createOrqaToolServer(send);

        try {
            send({
                type: 'stream_start',
                message_id: messageId,
                resolved_model: resolvedModel,
            });

            let blockIndex = 0;
            let inputTokens = 0;
            let outputTokens = 0;

            // Pre-populate map from persisted provider session UUID (survives restart)
            if (providerSessionId && !this.providerSessionMap.has(sessionId)) {
                this.providerSessionMap.set(sessionId, providerSessionId);
                process.stderr.write(
                    `orqa-studio-sidecar: restored provider session mapping ${sessionId} -> ${providerSessionId}\n`,
                );
            }

            const existingProviderSessionId = this.providerSessionMap.get(sessionId);

            const conversation = query({
                prompt: content,
                options: {
                    tools: [],
                    mcpServers: { orqa: orqaToolServer },
                    canUseTool: async (
                        name: string,
                        input: Record<string, unknown>,
                    ) => {
                        const toolCallId = `orqa_approval_${this.nextToolCallId++}`;
                        const strippedName = stripMcpPrefix(name);
                        process.stderr.write(
                            `orqa-studio-sidecar: canUseTool called: name=${strippedName} id=${toolCallId}\n`,
                        );

                        send({
                            type: 'tool_approval_request',
                            tool_call_id: toolCallId,
                            tool_name: strippedName,
                            input: JSON.stringify(input),
                        });

                        const approval = await this.waitForToolApproval(toolCallId);
                        process.stderr.write(
                            `orqa-studio-sidecar: canUseTool resolved: id=${toolCallId} approved=${approval.approved}\n`,
                        );

                        if (approval.approved) {
                            return { behavior: 'allow' as const, updatedInput: input };
                        }
                        return {
                            behavior: 'deny' as const,
                            message: approval.reason ?? 'User denied tool use',
                        };
                    },
                    pathToClaudeCodeExecutable: SDK_CLI_PATH,
                    includePartialMessages: true,
                    systemPrompt: (TOOL_SYSTEM_PROMPT + '\n\n' + (systemPrompt ?? '')).trim() || undefined,
                    model: resolvedModel,
                    abortController,
                    ...(enableThinking ? { maxThinkingTokens: 8000 } : {}),
                    ...(existingProviderSessionId ? { resume: existingProviderSessionId } : {}),
                },
            });

            for await (const message of conversation) {
                if (abortController.signal.aborted) {
                    break;
                }

                if (message && typeof message === 'object') {
                    const msg = message as Record<string, unknown>;

                    // Capture the provider session ID from the SDK init message
                    if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
                        this.providerSessionMap.set(sessionId, msg.session_id);
                        process.stderr.write(
                            `orqa-studio-sidecar: mapped orqa session ${sessionId} -> provider session ${msg.session_id}\n`,
                        );
                        // Notify Rust to persist the mapping for restart recovery
                        send({
                            type: 'session_initialized',
                            session_id: sessionId,
                            provider_session_id: msg.session_id,
                        });
                    }

                    if (msg.type === 'assistant' && msg.message && typeof msg.message === 'object') {
                        const inner = msg.message as Record<string, unknown>;
                        translateAgentMessage(inner, send, blockIndex);

                        if (inner.usage && typeof inner.usage === 'object') {
                            const usage = inner.usage as {
                                input_tokens?: number;
                                output_tokens?: number;
                            };
                            if (usage.input_tokens !== undefined) {
                                inputTokens = usage.input_tokens;
                            }
                            if (usage.output_tokens !== undefined) {
                                outputTokens = usage.output_tokens;
                            }
                        }

                        if (Array.isArray(inner.content)) {
                            blockIndex = inner.content.length;
                        }
                    } else if (msg.type === 'result' && msg.usage && typeof msg.usage === 'object') {
                        const usage = msg.usage as {
                            input_tokens?: number;
                            output_tokens?: number;
                        };
                        if (usage.input_tokens !== undefined) {
                            inputTokens = usage.input_tokens;
                        }
                        if (usage.output_tokens !== undefined) {
                            outputTokens = usage.output_tokens;
                        }
                    }
                }
            }

            send({
                type: 'turn_complete',
                input_tokens: inputTokens,
                output_tokens: outputTokens,
            });
        } catch (error: unknown) {
            if (abortController.signal.aborted) {
                send({ type: 'stream_cancelled' });
                return;
            }

            const errorInfo = classifyError(error);
            send({
                type: 'stream_error',
                code: errorInfo.code,
                message: errorInfo.message,
                recoverable: errorInfo.recoverable,
            });
        } finally {
            this.activeStreams.delete(sessionId);
        }
    }

    /**
     * Cancel an active stream for the given session.
     * If no stream is active, sends stream_cancelled anyway (idempotent).
     */
    cancelStream(sessionId: number, send: ResponseSender): void {
        const controller = this.activeStreams.get(sessionId);
        if (controller) {
            controller.abort();
            this.activeStreams.delete(sessionId);
            // The stream handler will emit stream_cancelled when it detects the abort
        } else {
            send({ type: 'stream_cancelled' });
        }
    }

    /**
     * Generate a summary of the given messages using the Agent SDK query().
     * Uses a single-turn conversation with the summary system prompt.
     */
    async generateSummary(
        sessionId: number,
        messages: MessageSummary[],
        send: ResponseSender,
    ): Promise<void> {
        try {
            const formattedMessages = messages
                .map((m) => `${m.role}: ${m.content}`)
                .join('\n\n');

            const conversation = query({
                prompt: formattedMessages,
                options: {
                    tools: [],
                    mcpServers: {},
                    pathToClaudeCodeExecutable: SDK_CLI_PATH,
                    systemPrompt: SUMMARY_SYSTEM_PROMPT,
                    model: DEFAULT_MODEL,
                    includePartialMessages: false,
                },
            });

            let summary = '';

            for await (const message of conversation) {
                if (!message || typeof message !== 'object') continue;
                const msg = message as Record<string, unknown>;

                if (msg.type === 'assistant' && msg.message && typeof msg.message === 'object') {
                    const inner = msg.message as Record<string, unknown>;
                    if (Array.isArray(inner.content)) {
                        for (const block of inner.content) {
                            if (
                                block &&
                                typeof block === 'object' &&
                                (block as Record<string, unknown>).type === 'text' &&
                                typeof (block as Record<string, unknown>).text === 'string'
                            ) {
                                summary = (block as Record<string, unknown>).text as string;
                            }
                        }
                    }
                } else if (msg.type === 'result' && typeof msg.result === 'string') {
                    summary = msg.result;
                }
            }

            send({
                type: 'summary_result',
                session_id: sessionId,
                summary,
            });
        } catch (error: unknown) {
            const errorInfo = classifyError(error);
            send({
                type: 'stream_error',
                code: errorInfo.code,
                message: errorInfo.message,
                recoverable: errorInfo.recoverable,
            });
        }
    }

    /**
     * Resolve a pending tool result request.
     * Called by index.ts when a tool_result arrives on stdin.
     */
    resolveToolResult(result: ToolResultRequest): void {
        const resolve = this.pendingToolResults.get(result.tool_call_id);
        if (resolve) {
            this.pendingToolResults.delete(result.tool_call_id);
            resolve(result);
        } else {
            process.stderr.write(
                `orqa-studio-sidecar: no pending tool_result for ${result.tool_call_id}\n`,
            );
        }
    }

    /**
     * Resolve a pending tool approval request.
     * Called by index.ts when a tool_approval arrives on stdin.
     */
    resolveToolApproval(result: ToolApprovalRequest): void {
        process.stderr.write(
            `orqa-studio-sidecar: resolveToolApproval: id=${result.tool_call_id} approved=${result.approved} pending_count=${this.pendingToolApprovals.size}\n`,
        );
        const resolve = this.pendingToolApprovals.get(result.tool_call_id);
        if (resolve) {
            this.pendingToolApprovals.delete(result.tool_call_id);
            resolve(result);
        } else {
            process.stderr.write(
                `orqa-studio-sidecar: no pending tool_approval for ${result.tool_call_id}\n`,
            );
        }
    }

    // ── Private helpers ──

    /**
     * Wait for Rust to send a tool_result back through stdin.
     * Returns a promise that resolves when resolveToolResult() is called
     * with a matching tool_call_id.
     */
    private waitForToolResult(toolCallId: string): Promise<ToolResultRequest> {
        return new Promise<ToolResultRequest>((resolve) => {
            this.pendingToolResults.set(toolCallId, resolve);
        });
    }

    /**
     * Wait for Rust to send a tool_approval back through stdin.
     * Returns a promise that resolves when resolveToolApproval() is called
     * with a matching tool_call_id.
     */
    private waitForToolApproval(toolCallId: string): Promise<ToolApprovalRequest> {
        return new Promise<ToolApprovalRequest>((resolve) => {
            this.pendingToolApprovals.set(toolCallId, resolve);
        });
    }

    /**
     * Create the OrqaStudio MCP tool server that routes tool calls to Rust
     * via the NDJSON protocol.
     *
     * Each tool call sends a tool_execute event to stdout and waits for
     * a tool_result response from stdin. This allows Rust (and the Tauri
     * frontend) to control all tool execution.
     */
    private createOrqaToolServer(send: ResponseSender) {
        return createSdkMcpServer({
            name: 'orqa-studio-tools',
            tools: [
                tool(
                    'read_file',
                    'Read a file from the filesystem',
                    { path: z.string() },
                    async (args) => this.executeToolViaRust('read_file', args, send),
                ),
                tool(
                    'write_file',
                    'Write content to a file',
                    { path: z.string(), content: z.string() },
                    async (args) => this.executeToolViaRust('write_file', args, send),
                ),
                tool(
                    'edit_file',
                    'Edit a file with search and replace',
                    {
                        path: z.string(),
                        old_string: z.string(),
                        new_string: z.string(),
                    },
                    async (args) => this.executeToolViaRust('edit_file', args, send),
                ),
                tool(
                    'bash',
                    'Execute a bash command',
                    { command: z.string() },
                    async (args) => this.executeToolViaRust('bash', args, send),
                ),
                tool(
                    'glob',
                    'Find files matching a glob pattern',
                    { pattern: z.string(), path: z.string().optional() },
                    async (args) => this.executeToolViaRust('glob', args, send),
                ),
                tool(
                    'grep',
                    'Search file contents with regex',
                    { pattern: z.string(), path: z.string().optional() },
                    async (args) => this.executeToolViaRust('grep', args, send),
                ),
                tool(
                    'search_regex',
                    'Search indexed codebase with a regex pattern. Returns matching code chunks with file paths and line numbers. The codebase must be indexed first.',
                    { pattern: z.string(), path: z.string().optional(), max_results: z.number().optional() },
                    async (args) => this.executeToolViaRust('search_regex', args, send),
                ),
                tool(
                    'search_semantic',
                    'Search the codebase using natural language. Finds semantically similar code chunks. Best for understanding how things work, finding related patterns, or exploring unfamiliar code. The codebase must be indexed with embeddings first.',
                    { query: z.string(), max_results: z.number().optional() },
                    async (args) => this.executeToolViaRust('search_semantic', args, send),
                ),
                tool(
                    'code_research',
                    'Research the codebase using combined regex and semantic search. Best for understanding how a feature works end-to-end, finding all callers of a function, or exploring relationships between modules. Returns results from both exact pattern matching and semantic similarity.',
                    { query: z.string(), max_results: z.number().optional() },
                    async (args) => this.executeToolViaRust('code_research', args, send),
                ),
                tool(
                    'load_skill',
                    'Load the full content of a project skill by name. Skills contain domain knowledge, patterns, and guidelines. Use this to load a skill before applying its guidance.',
                    { name: z.string() },
                    async (args) => this.executeToolViaRust('load_skill', args, send),
                ),
            ],
        });
    }

    /**
     * Execute a tool by sending a tool_execute event to Rust and waiting
     * for the tool_result response.
     */
    private async executeToolViaRust(
        toolName: string,
        args: Record<string, unknown>,
        send: ResponseSender,
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
        const toolCallId = `orqa_tool_${this.nextToolCallId++}`;
        process.stderr.write(
            `orqa-studio-sidecar: executeToolViaRust called: tool=${toolName} id=${toolCallId}\n`,
        );

        send({
            type: 'tool_execute',
            tool_call_id: toolCallId,
            tool_name: toolName,
            input: JSON.stringify(args),
        });

        send({
            type: 'tool_use_start',
            tool_call_id: toolCallId,
            tool_name: toolName,
        });

        const result = await this.waitForToolResult(toolCallId);

        send({
            type: 'tool_result',
            tool_call_id: toolCallId,
            tool_name: toolName,
            result: result.output,
            is_error: result.is_error,
        });

        if (result.is_error) {
            return {
                content: [{ type: 'text', text: `Error: ${result.output}` }],
            };
        }
        return {
            content: [{ type: 'text', text: result.output }],
        };
    }
}

// Re-export SidecarResponse for use in index.ts if needed
export type { SidecarResponse };
