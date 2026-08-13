#!/usr/bin/env node
'use strict';

const {execFileSync} = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.ts', '.txt', '.yaml', '.yml',
]);
const forbiddenNames = [
  /(?:^|\/)AGENTS\.md$/i,
  /(?:^|\/)AGENTS\.dir(?:\/|$)/i,
  /(?:^|\/)CLAUDE\.md$/i,
  /(?:^|\/)\.(?:codex|claude|pi)(?:\/|$)/i,
];
// Join name fragments with an optional separator so spaced, underscored, and
// hyphenated spellings of a private name are all rejected, not only the
// separator-free form.
const flexible = (parts) => parts.join('[ _-]?');
const privateProjectTerms = [
  flexible(['sd', 'food', 'guide']),
  flexible(['mail', 'express']),
].join('|');
const privateProjectPhrases = [
  flexible([['News', 'letter'].join(''), 'Builder']),
  flexible([['Ep', 'och'].join(''), 'Times']),
].join('|');
const localModelTerms = [
  ['local', '-fast'].join(''),
  ['lm', '[ _-]?', 'studio'].join(''),
  ['ol', 'lama'].join(''),
  ['qw', 'en\\d'].join(''),
  ['ll', 'ama\\d'].join(''),
  ['mis', 'tral(?:\\d|:)'].join(''),
  ['gem', 'ma\\d'].join(''),
  ['deep', 'seek(?:\\d|:)'].join(''),
].join('|');
const contentChecks = [
  ['personal Unix home path', /\/(?:home|Users)\/[A-Za-z0-9._-]+\//g],
  ['personal Windows profile path', /[A-Za-z]:\\Users\\[^\\\r\n]+\\/g],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  // Lookarounds instead of \b: underscores are word characters, so \b would
  // accept private names embedded in snake_case identifiers.
  ['private-project vocabulary', new RegExp(`(?<![0-9a-z])(?:${privateProjectTerms})(?![0-9a-z])|(?:${privateProjectPhrases})`, 'giu')],
  ['private key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g],
  ['common API token', /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,})\b/g],
  ['recognizable local model identifier', new RegExp(`(?<![0-9a-z])(?:${localModelTerms})(?![0-9a-z])`, 'giu')],
];

function candidateFiles() {
  const output = execFileSync('git', [
    '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ]);
  return output.toString('utf8').split('\0').filter(Boolean).sort();
}

function isTextFile(filename) {
  const basename = path.basename(filename);
  return basename.startsWith('.') || textExtensions.has(path.extname(filename).toLowerCase()) ||
    ['LICENSE', 'NOTICE'].includes(basename);
}

function nonLoopbackIps(text) {
  const found = [];
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const value = match[0];
    const octets = value.split('.').map(Number);
    if (octets.some((part) => part > 255) || octets[0] === 127) continue;
    found.push(value);
  }
  return found;
}

async function main() {
  const files = candidateFiles();
  const failures = [];
  for (const filename of files) {
    if (forbiddenNames.some((pattern) => pattern.test(filename))) {
      failures.push(`${filename}: agent-work file must not be committed`);
      continue;
    }
    if (!isTextFile(filename)) continue;
    const content = await fsp.readFile(path.join(root, filename), 'utf8').catch(() => null);
    if (content === null || content.includes('\0')) continue;
    for (const [label, pattern] of contentChecks) {
      pattern.lastIndex = 0;
      const match = pattern.exec(content);
      if (match) failures.push(`${filename}: ${label}: ${JSON.stringify(match[0])}`);
    }
    const ips = nonLoopbackIps(content);
    if (ips.length) failures.push(`${filename}: non-loopback IP address: ${ips[0]}`);
  }
  if (failures.length) {
    process.stderr.write(`Public-file audit failed (${failures.length} finding${failures.length === 1 ? '' : 's'}):\n`);
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Public-file audit passed for ${files.length} Git candidate files. Loopback addresses are allowed because the authenticated bridge is intentionally local-only.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
