/**
 * Provider facade — creates the default provider and re-exports its methods.
 *
 * index.ts imports from here for backwards-compatible dispatch. New code
 * should use the Provider interface from provider-interface.ts and the
 * factory from providers/index.ts directly.
 */

import { createProvider } from './providers/index.js';

const provider = createProvider();

export const streamMessage = provider.streamMessage.bind(provider);
export const cancelStream = provider.cancelStream.bind(provider);
export const generateSummary = provider.generateSummary.bind(provider);
export const healthCheck = provider.healthCheck.bind(provider);
export const resolveToolResult = provider.resolveToolResult.bind(provider);
export const resolveToolApproval = provider.resolveToolApproval.bind(provider);
