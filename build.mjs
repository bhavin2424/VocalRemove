import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Concatenation order is dependency order.
 *
 * The output has to be a classic script, not a module: Chrome refuses to load
 * `<script type="module">` from a file:// page, which is exactly how this build
 * is meant to be opened. So the ES module syntax is stripped and everything
 * shares one function scope instead.
 */
const SOURCES = [
  'src/dsp/fft.js',
  'src/dsp/stft.js',
  'src/dsp/separate.js',
  'src/dsp/analyze.js',
  'src/dsp/phasevocoder.js',
  'src/dsp/wav.js',
  'src/app/audio.js',
  'src/app/waveform.js',
  'src/app/player.js',
  'src/app/main.js',
];

function stripModuleSyntax(code) {
  return code
    .replace(/^import[^;]*;\s*$/gm, '')
    .replace(/^export (function\*|function|class|const|let)\b/gm, '$1');
}

const script = SOURCES.map((relative) => {
  const code = stripModuleSyntax(readFileSync(join(root, relative), 'utf8')).trim();
  return `/* ===== ${relative} ===== */\n${code}`;
}).join('\n\n');

const leftovers = script.match(/^\s*(import|export)\b.*$/gm);
if (leftovers) {
  console.error('Module syntax survived the strip:\n' + leftovers.join('\n'));
  process.exit(1);
}

const styles = readFileSync(join(root, 'src/app/styles.css'), 'utf8').trim();
const page = readFileSync(join(root, 'src/app/index.html'), 'utf8')
  .replace('{{STYLES}}', () => styles)
  .replace('{{SCRIPT}}', () => `(function () {\n'use strict';\n\n${script}\n\n})();`);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist/vocal-remover.html');
writeFileSync(out, page);

/*
 * The same page again as docs/index.html, which is what GitHub Pages serves
 * when a repository publishes from the /docs folder. Building both from one
 * source means the hosted copy can never drift from the downloadable one.
 */
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs/index.html'), page);
writeFileSync(join(root, 'docs/.nojekyll'), '');

console.log(`built ${out} (${(page.length / 1024).toFixed(0)} KB, no dependencies)`);
console.log('also wrote docs/index.html for GitHub Pages');
