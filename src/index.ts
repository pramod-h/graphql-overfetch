/**
 * Programmatic API for graphql-overfetch.
 *
 *   import { scan } from 'graphql-overfetch';
 *   const { analysis } = scan({ cwd: process.cwd() });
 */
export { scan } from './core/scan';
export type { ScanResult } from './core/scan';
export { FAIL_ON_CHECKS, parseFailOn, evaluateFailOn } from './core/fail-on';
export type { FailOnCheck, FailOnResult } from './core/fail-on';
export { runAnalysis } from './analyzers';
export { analyzeOverfetch } from './analyzers/overfetch';
export { analyzeUnrequestedReads } from './analyzers/unrequested-reads';
export { mapComponents } from './analyzers/component-map';
export { buildModel, extractDefinitions } from './parsers/operations';
export { detectProject } from './parsers/project';
export { loadSchema } from './parsers/schema';
export { toJson } from './reporters/json';
export * from './types';
