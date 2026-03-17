/**
 * Provider interface for the OrqaStudio sidecar.
 *
 * Defines the contract between the main sidecar entry point (index.ts)
 * and any provider implementation. New providers (e.g., a direct API
 * provider using an API key) implement this interface and are registered
 * in the provider factory (providers/index.ts).
 */

import type {
    SidecarResponse,
    MessageSummary,
    ToolResultRequest,
    ToolApprovalRequest,
} from './protocol.js';

/** Callback type for sending a response event to Rust via stdout. */
export type ResponseSender = (response: SidecarResponse) => void;

/** Re-export protocol types used in provider method signatures. */
export type { SidecarResponse, MessageSummary, ToolResultRequest, ToolApprovalRequest };

/**
 * Contract every AI provider implementation must satisfy.
 *
 * Each method maps to a SidecarRequest type. The provider is responsible
 * for translating the request into provider-specific API calls and emitting
 * the appropriate SidecarResponse events via the `send` callback.
 */
export interface Provider {
    /** Human-readable identifier for this provider (e.g. 'claude-agent'). */
    readonly name: string;

    /**
     * Respond to a health check with the sidecar version.
     */
    healthCheck(send: ResponseSender): void;

    /**
     * Stream a message and emit events to the frontend.
     *
     * Must emit stream_start, zero or more content events, and either
     * turn_complete, stream_cancelled, or stream_error as the final event.
     */
    streamMessage(
        sessionId: number,
        content: string,
        model: string | null,
        systemPrompt: string | null,
        send: ResponseSender,
        providerSessionId: string | null,
        enableThinking: boolean,
    ): Promise<void>;

    /**
     * Cancel an in-progress stream for the given session.
     * Idempotent — if no stream is active, emits stream_cancelled.
     */
    cancelStream(sessionId: number, send: ResponseSender): void;

    /**
     * Generate a short title summary for the given messages.
     * Emits a summary_result event on success, stream_error on failure.
     */
    generateSummary(
        sessionId: number,
        messages: MessageSummary[],
        send: ResponseSender,
    ): Promise<void>;

    /**
     * Resolve a pending tool result.
     * Called when Rust sends a tool_result request back on stdin.
     */
    resolveToolResult(result: ToolResultRequest): void;

    /**
     * Resolve a pending tool approval decision.
     * Called when Rust sends a tool_approval request back on stdin.
     */
    resolveToolApproval(result: ToolApprovalRequest): void;
}
