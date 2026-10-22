/**
 * api-drift/node: Node-only helpers. File store, JSONL reporter, config
 * loading and the programmatic `runSnapshot` / `runCheck` behind the CLI
 * (use these from a GitHub Action or any script).
 */
export { fileStore } from './node/file-store';
export type { FileStore, FileStoreOptions } from './node/file-store';
export { jsonlReporter } from './node/jsonl';
export { readBaseline, writeBaseline, writeFileAtomic } from './node/baseline-io';
export {
  loadConfig,
  validateConfig,
  resolveEndpoints,
  substituteEnv,
  maskSecrets,
  configTemplate,
  libraryOptions,
  ConfigError,
  DEFAULT_CONFIG_FILE,
  DEFAULT_BASELINE_FILE,
} from './node/config';
export type { DriftConfig, EndpointConfig, LoadedConfig, ResolvedEndpoint } from './node/config';
export { parseJsonc } from './node/jsonc';
export { callEndpoint } from './node/http';
export type { CallResult, CallOptions, FetchLike } from './node/http';
export { runSnapshot, runCheck, countFields } from './node/runner';
export type { RunOptions, SnapshotResult, SnapshotEndpoint, CheckRunResult } from './node/runner';
export { supportsColor, supportsUnicode, terminalStyle } from './node/terminal';
export { main as runCli } from './cli/main';
export type { CliIO } from './cli/main';
// Convenience re-exports for scripts and GitHub Actions (also in `api-drift/report`).
export { buildReport, failsOn, renderText, renderMarkdown, renderJson } from './core/report';
export type { DriftReport, EndpointResult, FailOn, ReportSummary } from './core/report';
