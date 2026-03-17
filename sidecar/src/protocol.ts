/**
 * NDJSON protocol types matching the Rust sidecar types.
 *
 * These types mirror src-tauri/src/sidecar/types.rs exactly.
 * The sidecar reads SidecarRequest from stdin and writes
 * SidecarResponse to stdout, one JSON object per line.
 */

// ── Request Types ──

export interface SendMessageRequest {
    type: 'send_message';
    session_id: number;
    content: string;
    model: string | null;
    system_prompt: string | null;
    provider_session_id: string | null;
    enable_thinking: boolean;
}

export interface CancelStreamRequest {
    type: 'cancel_stream';
    session_id: number;
}

export interface HealthCheckRequest {
    type: 'health_check';
}

export interface GenerateSummaryRequest {
    type: 'generate_summary';
    session_id: number;
    messages: MessageSummary[];
}

export interface MessageSummary {
    role: string;
    content: string;
}

/**
 * Rust sends a tool execution result back to the sidecar.
 * This is the response to a ToolExecuteResponse the sidecar sent earlier.
 */
export interface ToolResultRequest {
    type: 'tool_result';
    tool_call_id: string;
    output: string;
    is_error: boolean;
}

/**
 * Rust sends a tool approval decision back to the sidecar.
 * This is the response to a ToolApprovalRequestResponse the sidecar sent earlier.
 */
export interface ToolApprovalRequest {
    type: 'tool_approval';
    tool_call_id: string;
    approved: boolean;
    reason: string | null;
}

export type SidecarRequest =
    | SendMessageRequest
    | CancelStreamRequest
    | HealthCheckRequest
    | GenerateSummaryRequest
    | ToolResultRequest
    | ToolApprovalRequest;

// ── Response Types ──

export interface StreamStartResponse {
    type: 'stream_start';
    message_id: number;
    resolved_model: string | null;
}

export interface TextDeltaResponse {
    type: 'text_delta';
    content: string;
}

export interface ThinkingDeltaResponse {
    type: 'thinking_delta';
    content: string;
}

export interface ToolUseStartResponse {
    type: 'tool_use_start';
    tool_call_id: string;
    tool_name: string;
}

export interface ToolInputDeltaResponse {
    type: 'tool_input_delta';
    tool_call_id: string;
    content: string;
}

export interface ToolResultResponse {
    type: 'tool_result';
    tool_call_id: string;
    tool_name: string;
    result: string;
    is_error: boolean;
}

export interface BlockCompleteResponse {
    type: 'block_complete';
    block_index: number;
    content_type: string;
}

export interface TurnCompleteResponse {
    type: 'turn_complete';
    input_tokens: number;
    output_tokens: number;
}

export interface StreamErrorResponse {
    type: 'stream_error';
    code: string;
    message: string;
    recoverable: boolean;
}

export interface StreamCancelledResponse {
    type: 'stream_cancelled';
}

export interface HealthOkResponse {
    type: 'health_ok';
    version: string;
}

export interface SummaryResultResponse {
    type: 'summary_result';
    session_id: number;
    summary: string;
}

/**
 * Sidecar asks Rust to execute a tool on its behalf.
 * The Agent SDK MCP server routes tool calls through this mechanism
 * so that Rust (and the Tauri frontend) control tool execution.
 */
export interface ToolExecuteResponse {
    type: 'tool_execute';
    tool_call_id: string;
    tool_name: string;
    input: string;
}

/**
 * Sidecar asks Rust/UI whether a tool invocation should be approved.
 * The Agent SDK canUseTool callback routes through this mechanism
 * so that the user can approve or deny tool calls from the UI.
 */
export interface ToolApprovalRequestResponse {
    type: 'tool_approval_request';
    tool_call_id: string;
    tool_name: string;
    input: string;
}

/**
 * Sidecar notifies Rust that the provider session UUID has been captured.
 * Rust persists this to SQLite so the mapping survives app restarts.
 */
export interface SessionInitializedResponse {
    type: 'session_initialized';
    session_id: number;
    provider_session_id: string;
}

export type SidecarResponse =
    | StreamStartResponse
    | TextDeltaResponse
    | ThinkingDeltaResponse
    | ToolUseStartResponse
    | ToolInputDeltaResponse
    | ToolResultResponse
    | BlockCompleteResponse
    | TurnCompleteResponse
    | StreamErrorResponse
    | StreamCancelledResponse
    | HealthOkResponse
    | SummaryResultResponse
    | ToolExecuteResponse
    | ToolApprovalRequestResponse
    | SessionInitializedResponse;

// ── Protocol Helpers ──

/**
 * Parse an NDJSON line into a SidecarRequest.
 * Throws if the line is not valid JSON or does not match a known request type.
 */
export function parseRequest(line: string): SidecarRequest {
    const parsed = JSON.parse(line.trim()) as SidecarRequest;

    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
        throw new Error('Invalid request: missing "type" field');
    }

    const validTypes = [
        'send_message', 'cancel_stream', 'health_check', 'generate_summary',
        'tool_result', 'tool_approval',
    ];
    if (!validTypes.includes(parsed.type)) {
        throw new Error(`Unknown request type: ${parsed.type}`);
    }

    return parsed;
}

/**
 * Serialize a SidecarResponse to an NDJSON line (compact JSON + newline).
 */
export function serializeResponse(response: SidecarResponse): string {
    return JSON.stringify(response) + '\n';
}
