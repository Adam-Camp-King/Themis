/**
 * @bounded/core — public API.
 *
 * Import types with `import type` to avoid runtime cost; import guards as
 * values.
 *
 *   import type { IPolicyDecision, IRequestor, IAction } from '@bounded/core';
 *   import { isDeny, isRedirect } from '@bounded/core';
 */

export * from './types.js';
export * from './guards.js';
