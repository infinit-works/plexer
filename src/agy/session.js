import { join } from 'node:path';
import {
    agyLastRepoPath,
    agyTempDir,
    readAgyLastRepo,
    readJson,
    writeAgyLastRepo,
    writeJsonAtomic,
} from '../util/state.js';

export { agyTempDir, agyLastRepoPath, readAgyLastRepo, writeAgyLastRepo };

export function emptyAgySession() {
    return {
        transcriptOffset: 0,
        transcriptSize: 0,
        lastUserPrompt: null,
        lastUserStep: -1,
        lastInjectedStep: -1,
        lastInitialNumSteps: null,
        lastTouchedPath: null,
        lastEditedFile: null,
        lastReadRelFile: null,
        orientedDirs: [],
        pendingBlastRadius: null,
        pendingPlanHandoff: null,
        pendingPlanSpans: [],
        pendingMidLoopFile: null,
        midLoopHintEmitted: false,
        turn0Matched: false,
        lastQuery: null,
        perAgentQuery: {},
        injectedPointers: [],
        seenSpans: {},
        fileSliceCounts: {},
        lastFileReadEnd: {},
        emittedBlastFiles: [],
        emittedSwarmCollisions: [],
        swarmForkChecked: false,
        isOrchestratorModel: false,
        orchestratorPhase: null,
        pendingPlanAwaitApproval: false,
        lastCheckpointStep: null,
        hasDirectUserInput: false,
        subagentSenderId: null,
        lastBlockedReadKey: null,
        lastBlockedSearchKey: null,
        editSeq: 0,
        lastGitDiffKey: null,
        lastGitDiffEditSeq: -1,
        seenSearchKeys: [],
        preEditToolTurns: 0,
        lastPreEditToolAtMs: 0,
        isEditPrompt: false,
        editTargetFiles: [],
        preEditInvocations: 0,
        editedInPrompt: false,
        exploreGuardEmitted: false,
        exploreGuardStage: 0,
        nudges: 0,
        lastRetrievalText: null,
    };
}

export function agySessionPath(sessionId) {
    const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(agyTempDir(), `plexer-agy-${safeId}.json`);
}

export function readAgySession(sessionId) {
    return { ...emptyAgySession(), ...(readJson(agySessionPath(sessionId)) ?? {}) };
}

export function writeAgySession(sessionId, state) {
    try {
        writeJsonAtomic(agySessionPath(sessionId), state);
    }
    catch { /* best-effort */ }
}
