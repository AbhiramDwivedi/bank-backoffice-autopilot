/**
 * Public API of the discovery agent.
 */
export { discover } from './discover.js';
export * from './types.js';

export { DEFAULT_MODEL } from './model.js';
export { createScriptedLlm, requestText, type ScriptedTurn } from './scripted-llm.js';

export { TOOL_DEFS, parseToolCall } from './tools.js';
export type { ToolCall, ToolName, ParseToolCallResult } from './tools.js';

export { systemPrompt, buildTurnContent, formatElementLine } from './prompt.js';
export type { SystemPromptOptions, TurnState, TurnObservation, HistoryEntry } from './prompt.js';

export { createRecorder, kebabFromGoal, shortStepName, findLeaks, toIdentifier, isPositional, RECORD_SCOPES } from './recorder.js';
export type { Recorder, RecorderOptions, RecordStepInput, RecordOutcomeInput, BuildMeta, BuildResult, ObservedLocation, ScopedTarget, ScopeOptions, TargetScope } from './recorder.js';

export { mergeOutcomes, bumpMinor, mapStepId } from './extend.js';
export type { ExtendRun } from './extend.js';
