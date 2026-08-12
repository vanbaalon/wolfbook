#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { assessTelemetry, toMarkdown } = require('./researchEval');

function latestRun() {
    const dir = path.resolve(__dirname, '../../../../../.oberon/telemetry/runs');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (!files.length) throw new Error(`No telemetry runs found in ${dir}`);
    return path.join(dir, files[0]);
}

const args = process.argv.slice(2);
const input = path.resolve(args.find(a => !a.startsWith('--')) || latestRun());
const markdown = args.includes('--markdown');
const events = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); }
    catch (e) { throw new Error(`Invalid JSON at ${input}:${i + 1}: ${e.message}`); }
});
const report = assessTelemetry(events, { runId: path.basename(input, '.jsonl'), source: input });
process.stdout.write(markdown ? toMarkdown(report) + '\n' : JSON.stringify(report, null, 2) + '\n');

