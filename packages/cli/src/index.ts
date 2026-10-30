// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * themis-policy-cli — the `themis` command and the library behind it, so
 * another CLI (Solid#'s `solid`) can embed the same lint and report.
 */

export { lintContracts, contractsFromJson, type LintFinding, type LintInput } from './lint.js';
export {
  buildReport, formatReport, parseAuditLines, RISKY_IMPACTS,
  type IntentReport, type ActionRow, type ReportOptions,
} from './report.js';
export { main, nodeIo, type Io } from './cli.js';
