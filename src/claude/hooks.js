import { pathToFileURL } from 'node:url';
import { editedFilePath, handlePostEdit, handleStop, readOrientation, recordFileEdit, triggerBackgroundSync, underPlexer } from './edit-hooks.js';
import { pinnedHits, pointerCovers, pointersOverlap } from './pin.js';
import { MIN_PROMPT_CHARS, LEADING_SLASH_COMMANDS_RE, READ_ONLY_SLASH_RE, stripLeadingSlashCommands, isSyntheticOrMetaPrompt, cleanPromptBoilerplate, detectPromptIntent } from '../hosts/engine/prompt/intent.js';
import { buildCorpusVocab } from '../hosts/engine/prompt/vocab.js';
import { distillPromptQueries } from '../hosts/engine/prompt/distill.js';
import { HOOK_BUDGETS } from '../hosts/engine/prompt/budget.js';
import { computeCoEditPointers, lastFileScopeHint } from '../hosts/engine/prompt/search.js';
import { finalizePinnedPromptContext } from '../hosts/engine/prompt/pin.js';

export {
    MIN_PROMPT_CHARS, LEADING_SLASH_COMMANDS_RE, READ_ONLY_SLASH_RE,
    stripLeadingSlashCommands, isSyntheticOrMetaPrompt, buildCorpusVocab,
    cleanPromptBoilerplate, detectPromptIntent, distillPromptQueries,
    HOOK_BUDGETS, computeCoEditPointers, lastFileScopeHint,
    underPlexer, editedFilePath, recordFileEdit, readOrientation,
    handlePostEdit, triggerBackgroundSync, handleStop,
};

export function queryPromptContext(dir, prompt, opts = {}) {
    return finalizePinnedPromptContext(dir, prompt, opts, { pinnedHits, pointerCovers, pointersOverlap });
}

export async function handleHook(event, input = undefined, opts = {}) {
    const url = new URL(['..', 'hosts', 'engine', 'dispatcher.js'].join('/'), import.meta.url).href;
    const { dispatchHostEvent } = await import(url);
    return dispatchHostEvent(event, input, opts);
}

export async function main(event = process.argv[2]) {
    return handleHook(event);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
