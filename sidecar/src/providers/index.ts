/**
 * Provider factory for the OrqaStudio sidecar.
 *
 * Creates the appropriate Provider implementation based on the requested type.
 * New providers are registered here as additional switch cases.
 */

import type { Provider } from '../provider-interface.js';
import { ClaudeAgentProvider } from './claude-agent.js';

/**
 * Create a provider instance by type name.
 *
 * Defaults to 'claude-agent' if no type is specified.
 * Each call returns a new instance with its own isolated state.
 */
export function createProvider(type?: string): Provider {
    switch (type) {
        case 'claude-agent':
        default:
            return new ClaudeAgentProvider();
    }
}
