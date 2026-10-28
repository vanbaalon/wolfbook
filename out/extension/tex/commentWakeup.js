'use strict';

// The agent installs its own native wake-up. Wolfbook never guesses a chat ID,
// launches a second model process, or sends a prompt to another conversation.
function commentAgent(agent = 'auto', clientName = '') {
    if (!['auto', 'codex', 'claude-code', 'other'].includes(agent))
        throw Error('agent must be auto, codex, claude-code, or other.');
    if (agent !== 'auto') return agent;
    const name = String(clientName || '').toLowerCase();
    if (/^claude[-_ ]?code(?:$|[-_/ ])/.test(name)) return 'claude-code';
    if (/^codex(?:$|[-_/ ])/.test(name)) return 'codex';
    return 'other';
}

function commentWakeup(listener) {
    const agent = listener.agent || 'other';
    const poll = {action:'next', file:listener.file, listener_id:listener.id, wait_seconds:0};
    // Put paths in JSON, never executable shell text. Comment contents are read
    // at delivery time, rather than embedded in a scheduled prompt snapshot.
    const prompt = 'WPaper collaboration: check this exact comment listener once using paper_listenComments '
        + JSON.stringify(poll) + '. Process only its reader comments with small guarded paper edits, verify:true, '
        + 'then ack delivery_id and successful operation_id. The reader mini-editor has priority: on user-editing '
        + 'or conflicts, preserve the comment and retry on a later wake-up; do not spin or overwrite. '
        + 'On waiting, end this scheduled check quietly. On stopped or unknown/expired listener, cancel ONLY '
        + 'this comment scheduler using its saved job ID (if lost, use CronList and match this exact file/listener prompt); '
        + 'do not restart the listener automatically or delete other jobs. '
        + 'On a request you cannot safely complete, preserve it and report the reason once. '
        + 'Do not work on unrelated files or start another agent.';
    const continuous = {tool:'paper_listenComments', arguments:{...poll,wait_seconds:45}};
    const common = {agent, client_setup_required:true, server_installs_scheduler:false,
        poll, continuous_wait:continuous,
        safety:'Listening and waking hold no source, editor, compiler, or kernel lock. Comments are consumed only after a verified edit.'};
    if (agent === 'claude-code') return {...common, strategy:'claude-cron',
        setup:{tool:'CronCreate', arguments:{cron:'* * * * *',prompt,recurring:true}},
        next:'If CronCreate is available, install this one file-bound recurring job in the current session and retain its returned job ID before ending the turn. Otherwise keep using continuous_wait. Never claim a scheduler is installed until the native tool succeeds.',
        stop:'Call paper_listenComments stop and CronDelete for ONLY this listener\'s saved job ID. If lost, use CronList to match this exact file/listener prompt; never delete unrelated jobs. A stopped/expired listener cancels its own job and must not silently restart.',
        limitations:'The session must remain running; scheduled prompts run when idle, with minute granularity and possible jitter. Native scheduling can be unavailable or expire.'};
    if (agent === 'codex') return {...common, strategy:'codex-wait',
        next:'Use continuous_wait while listening is active; waiting is not completion. If the current client exposes a native wake/sleep tool, use it without ending the listening task. An existing user-authorized Goal can continue the task across idle turns. Create a Goal only when the user explicitly requests a Goal; an ordinary listen request does not authorize creating one.',
        goal_prompt:`Keep listening for reader comments on ${JSON.stringify(listener.file)}, handle them with guarded verified WPaper edits, and continue until the user stops collaboration.`,
        stop:'Stop this listener when the user stops collaboration; respect the client\'s Goal and wake-up cancellation controls.',
        limitations:'A native wait resumes an active task. Automatic continuation after a finished turn requires an active Goal or another wake mechanism actually provided by this client; a passive MCP listener alone cannot do it.'};
    return {...common, strategy:'continuous-wait',
        next:'Keep using continuous_wait while listening is active. If the client provides a native scheduler, install one in this conversation using the file-bound scheduled_prompt; retain its job ID and cancel it on stop. Do not claim idle wake-up support without a successful native setup.',
        scheduled_prompt:prompt,
        stop:'Stop this listener and cancel only its native scheduler, if installed.'};
}

module.exports = {commentAgent, commentWakeup};
