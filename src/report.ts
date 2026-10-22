/**
 * api-drift/report: browser-safe renderers. Turn changes and shapes into
 * terminal text (with optional ANSI colour), GitHub-flavoured markdown, JSON
 * reports and aligned trees. The CLI uses exactly these functions.
 */
export { buildReport, failsOn, renderText, renderMarkdown, renderJson, renderChanges } from './core/report';
export type { DriftReport, EndpointResult, EndpointStatus, FailOn, ReportSummary } from './core/report';
export { renderShapeTree, explainEntry } from './core/tree';
export type { TreeOptions } from './core/tree';
export { createStyle, plainStyle, visibleWidth, stripAnsi, padVisible } from './core/style';
export type { Style, StyleRole, Symbols } from './core/style';
export { describe } from './core/describe';
export type { DescribeOptions } from './core/describe';
