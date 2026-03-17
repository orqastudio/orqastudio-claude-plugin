/**
 * OrqaStudio Agent SDK Sidecar — Main Entry Point
 *
 * Reads NDJSON requests from stdin, dispatches to the appropriate handler,
 * and writes NDJSON responses to stdout. This is the real sidecar that
 * replaces the test echo sidecar (test-sidecar/echo.cjs) for production use.
 *
 * Protocol:
 *   stdin  -> one SidecarRequest JSON object per line
 *   stdout <- one SidecarResponse JSON object per line
 *   stderr <- debug/diagnostic output (inherited by Tauri)
 */

import * as readline from 'node:readline';
import { parseRequest, serializeResponse } from './protocol.js';
import type { SidecarResponse } from './protocol.js';
import {
    streamMessage,
    cancelStream,
    generateSummary,
    healthCheck,
    resolveToolResult,
    resolveToolApproval,
} from './provider.js';

/**
 * Write a SidecarResponse to stdout as NDJSON.
 */
function sendResponse(response: SidecarResponse): void {
    process.stdout.write(serializeResponse(response));
}

/**
 * Handle a parsed SidecarRequest by dispatching to the appropriate handler.
 */
async function handleRequest(line: string): Promise<void> {
    let request;
    try {
        request = parseRequest(line);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({
            type: 'stream_error',
            code: 'parse_error',
            message: `Failed to parse request: ${message}`,
            recoverable: false,
        });
        return;
    }

    switch (request.type) {
        case 'health_check':
            healthCheck(sendResponse);
            break;

        case 'send_message':
            await streamMessage(
                request.session_id,
                request.content,
                request.model,
                request.system_prompt,
                sendResponse,
                request.provider_session_id,
                request.enable_thinking,
            );
            break;

        case 'cancel_stream':
            cancelStream(request.session_id, sendResponse);
            break;

        case 'generate_summary':
            await generateSummary(
                request.session_id,
                request.messages,
                sendResponse,
            );
            break;

        case 'tool_result':
            resolveToolResult(request);
            break;

        case 'tool_approval':
            resolveToolApproval(request);
            break;
    }
}

// ── Main ──

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line: string) => {
    // Fire-and-forget: each request is handled independently.
    // Errors within handleRequest are caught and emitted as stream_error.
    handleRequest(line).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({
            type: 'stream_error',
            code: 'internal_error',
            message: `Unhandled error: ${message}`,
            recoverable: false,
        });
    });
});

// Graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Log startup to stderr (not stdout, which is reserved for NDJSON protocol)
process.stderr.write('orqa-studio-sidecar: started, waiting for NDJSON input on stdin\n');
