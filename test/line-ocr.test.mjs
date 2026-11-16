import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  canonicalOcrText,
  fingerprintLineRegion,
  findOcrLabel,
  findUniqueOcrLabel,
  normalizeOcrResult,
  purepngDimensions,
  recognizeLineImage,
} from '../src/extensions/line-ocr.mjs';

const execFile = promisify(execFileCallback);
const WINDOWS_POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

test('normalizes OCR geometry into the original PNG pixel space', () => {
  const result = normalizeOcrResult({
    success: true,
    width: 640,
    height: 360,
    language: 'zh-Hant-TW',
    ocrScaleFactor: 2,
    lines: [{
      text: '設定',
      words: [{ text: '設定', x: 24, y: 40, width: 80, height: 32 }],
      x: 24,
      y: 40,
      width: 80,
      height: 32,
    }],
  });

  assert.deepEqual(result, {
    width: 640,
    height: 360,
    language: 'zh-Hant-TW',
    coordinateSpace: 'input-png-pixels',
    scaleFactor: 1,
    ocrScaleFactor: 2,
    lines: [{
      text: '設定',
      words: [{ text: '設定', x: 24, y: 40, width: 80, height: 32 }],
      x: 24,
      y: 40,
      width: 80,
      height: 32,
    }],
  });
});

test('rejects OCR geometry that is not relative to the supplied screenshot', () => {
  assert.throws(
    () => normalizeOcrResult({
      success: true,
      width: 100,
      height: 100,
      language: 'en-US',
      lines: [{
        text: 'Outside',
        words: [{ text: 'Outside', x: 95, y: 10, width: 20, height: 10 }],
        x: 95,
        y: 10,
        width: 20,
        height: 10,
      }],
    }),
    { code: 'LINE_OCR_PROTOCOL_ERROR' },
  );
  for (const x of [-2, 98]) {
    assert.throws(() => normalizeOcrResult({
      success: true, width: 100, height: 33, language: 'zh-Hant-TW',
      lines: [{text:'Margin',x,y:5,width:4,height:10,
        words:[{text:'Margin',x,y:5,width:4,height:10}]}],
    }), {code:'LINE_OCR_PROTOCOL_ERROR'},
    'margin-only or crossing OCR geometry must fail instead of being clipped');
  }
});

test('matches only exact canonical multiline labels and preserves emoji', () => {
  const ocr = {
    lines: [
      { text: '開啟  設定', x: 12, y: 20, width: 120, height: 30 },
      { text: 'LINE 😀', x: 12, y: 58, width: 110, height: 30 },
    ],
  };

  assert.equal(canonicalOcrText('  開啟\n設定  😀 '), '開啟設定 😀');
  assert.equal(canonicalOcrText('中 文 測 試'), '中文測試');
  const match = findOcrLabel(ocr, ['開啟 設定\nLINE 😀']);
  assert.deepEqual(match, {
    label: '開啟 設定\nLINE 😀',
    text: '開啟  設定\nLINE 😀',
    lines: ocr.lines,
    x: 12,
    y: 20,
    width: 120,
    height: 68,
  });
  assert.equal(findOcrLabel(ocr, ['開啟']), null);
  assert.equal(findOcrLabel(ocr, ['line 😀']), null);
});

test('refuses to turn repeated exact labels into a guessed OCR target', () => {
  const ocr = {
    lines: [
      { text: '設定', x: 10, y: 20, width: 50, height: 20 },
      { text: '設定', x: 10, y: 80, width: 50, height: 20 },
    ],
  };

  assert.throws(
    () => findUniqueOcrLabel(ocr, ['設定']),
    (error) => error?.code === 'LINE_OCR_LABEL_AMBIGUOUS' && error.details?.matchCount === 2,
  );
});

test('rejects non-PNG image content before starting PowerShell', async () => {
  if (process.platform !== 'win32') {
    assert.throws(() => purepngDimensions({ type: 'image', mimeType: 'image/png', data: Buffer.from('not a png').toString('base64') }), { code: 'LINE_OCR_INVALID_IMAGE' });
    await assert.rejects(recognizeLineImage({ type: 'image', mimeType: 'image/png', data: '' }), { code: 'LINE_OCR_RUNTIME_UNAVAILABLE' });
    return;
  }
  await assert.rejects(
    recognizeLineImage({ type: 'image', mimeType: 'image/png', data: Buffer.from('not a png').toString('base64') }),
    { code: 'LINE_OCR_INVALID_IMAGE' },
  );
  await assert.rejects(
    recognizeLineImage({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
    }, { maxBytes: 7 }),
    { code: 'LINE_OCR_IMAGE_TOO_LARGE' },
  );
});

test('fingerprints only an explicit source-pixel header crop', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'line-fingerprint-test-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const baselinePath = path.join(directory, 'baseline.png');
  const bodyChangedPath = path.join(directory, 'body-changed.png');
  const headerChangedPath = path.join(directory, 'header-changed.png');
  await createFingerprintPng(baselinePath, { header: 'Example (6)', body: 'first body text' });
  await createFingerprintPng(bodyChangedPath, { header: 'Example (6)', body: 'different body text' });
  await createFingerprintPng(headerChangedPath, { header: 'Example (7)', body: 'first body text' });

  const baseline = await pngContent(baselinePath);
  const bodyChanged = await pngContent(bodyChangedPath);
  const headerChanged = await pngContent(headerChangedPath);
  const region = { x: 0, y: 0, width: 360, height: 80 };

  assert.deepEqual(purepngDimensions(baseline), { width: 360, height: 180 });
  const first = await fingerprintLineRegion(baseline, region);
  const bodyOnly = await fingerprintLineRegion(bodyChanged, region);
  const headerOnly = await fingerprintLineRegion(headerChanged, region);
  assert.deepEqual(Object.keys(first).sort(), ['height', 'region', 'sha256', 'width']);
  assert.deepEqual(first.region, region);
  assert.equal(first.width, region.width);
  assert.equal(first.height, region.height);
  assert.equal(first.sha256, bodyOnly.sha256, 'body pixels outside the crop must not affect the header fingerprint');
  assert.notEqual(first.sha256, headerOnly.sha256, 'a changed header must change the header fingerprint');

  const withImage = await fingerprintLineRegion(baseline, region, { includeImage: true });
  assert.equal(withImage.sha256, first.sha256);
  assert.deepEqual(purepngDimensions(withImage.image), { width: region.width, height: region.height });
  assert.ok(Buffer.byteLength(withImage.image.data, 'base64') < Buffer.byteLength(baseline.data, 'base64'), 'returned image must be the smaller crop, not the full input PNG');

  await assert.rejects(
    fingerprintLineRegion(baseline, { x: 0, y: 0, width: 361, height: 80 }),
    { code: 'LINE_OCR_INVALID_REGION' },
  );
  await assert.rejects(
    fingerprintLineRegion(baseline, { x: 0.5, y: 0, width: 360, height: 80 }),
    { code: 'LINE_OCR_INVALID_REGION' },
  );
});

test('runs Windows.Media.Ocr against a generated local business-neutral PNG', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'line-ocr-test-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const pngPath = path.join(directory, 'ocr-demo.png');
  await createSyntheticPng(pngPath);
  const imageContent = {
    type: 'image',
    mimeType: 'image/png',
    data: (await fs.readFile(pngPath)).toString('base64'),
  };

  let result;
  try {
    result = await recognizeLineImage(imageContent, { timeoutMs: 20_000 });
  } catch (error) {
    if (['LINE_OCR_RUNTIME_UNAVAILABLE', 'LINE_OCR_LANGUAGE_UNAVAILABLE'].includes(error?.code)) {
      t.skip(`${error.code}: ${error.message}`);
      return;
    }
    throw error;
  }

  assert.equal(result.width, 800);
  assert.equal(result.height, 260);
  assert.equal(result.coordinateSpace, 'input-png-pixels');
  assert.equal(result.scaleFactor, 1);
  assert.equal(result.ocrScaleFactor, 2);
  assert.match(result.language, /^(zh-Hant|en)/i);
  const expectedLabel = /^zh-Hant/i.test(result.language) ? /測試/u : /OCRDEMO/iu;
  const recognizedText = result.lines.map((line) => line.text).join('\n');
  assert.ok(canonicalOcrText(recognizedText).length > 0, 'expected OCR to return text from the generated PNG');
  assert.match(recognizedText.replace(/\s+/gu, ''), expectedLabel, 'expected OCR to read the sample label in its selected language');
  assert.doesNotMatch(recognizedText, /\uFFFD/u, 'PowerShell JSON output must stay UTF-8 instead of producing replacement characters');
  const explicitZero=await recognizeLineImage(imageContent,{paddingPixels:0,timeoutMs:20_000});
  assert.deepEqual(explicitZero,result,'paddingPixels:0 keeps the existing OCR result');
  for (const line of result.lines) {
    assert.ok(line.x >= 0 && line.y >= 0);
    assert.ok(line.x + line.width <= result.width + 0.001);
    assert.ok(line.y + line.height <= result.height + 0.001);
  }
  const padded=await recognizeLineImage(imageContent,{paddingPixels:16,timeoutMs:20_000});
  assert.equal(padded.width,800);
  assert.equal(padded.height,260);
  assert.equal(padded.coordinateSpace,'input-png-pixels');
  assert.equal(padded.scaleFactor,1);
  assert.equal(padded.language, result.language);
  assert.match(padded.lines.map(line=>line.text).join('').replace(/\s+/gu,''), expectedLabel);
  for(const line of padded.lines){
    assert.ok(line.x>=0 && line.y>=0 && line.x+line.width<=800.001
      && line.y+line.height<=260.001,'padding is removed without clipping original geometry');
  }
  await assert.rejects(recognizeLineImage(imageContent,{paddingPixels:33}),
    {code:'LINE_OCR_INVALID_ARGUMENT'});
  await assert.rejects(recognizeLineImage(imageContent,{paddingPixels:0.5}),
    {code:'LINE_OCR_INVALID_ARGUMENT'});
  await assert.rejects(recognizeLineImage(imageContent,{paddingPixels:16,maxDimension:820}),
    {code:'LINE_OCR_IMAGE_TOO_LARGE'});
  await assert.rejects(
    recognizeLineImage(imageContent, { maxDimension: 100, timeoutMs: 20_000 }),
    { code: 'LINE_OCR_IMAGE_TOO_LARGE' },
  );
});

async function createSyntheticPng(pngPath) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    '$bitmap = New-Object System.Drawing.Bitmap 800, 260',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$englishFont = New-Object System.Drawing.Font "Segoe UI", 42, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)',
    '$chineseFont = New-Object System.Drawing.Font "Microsoft JhengHei", 72, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)',
    'try {',
    '  $graphics.Clear([System.Drawing.Color]::White)',
    '  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
    '  $graphics.DrawString("LINE OCR DEMO", $englishFont, [System.Drawing.Brushes]::Black, 36, 28)',
    '  $graphics.DrawString("中文測試", $chineseFont, [System.Drawing.Brushes]::Black, 36, 112)',
    '  $bitmap.Save($env:LINE_OCR_TEST_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)',
    '} finally { $chineseFont.Dispose(); $englishFont.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }',
  ].join('; ');
  await execFile(WINDOWS_POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    windowsHide: true,
    timeout: 10_000,
    env: { ...process.env, LINE_OCR_TEST_OUTPUT: pngPath },
  });
}

async function pngContent(pngPath) {
  return {
    type: 'image',
    mimeType: 'image/png',
    data: (await fs.readFile(pngPath)).toString('base64'),
  };
}

async function createFingerprintPng(pngPath, { header, body }) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    '$bitmap = New-Object System.Drawing.Bitmap 360, 180',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$headerFont = New-Object System.Drawing.Font "Segoe UI", 28, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)',
    '$bodyFont = New-Object System.Drawing.Font "Segoe UI", 24, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)',
    'try {',
    '  $graphics.Clear([System.Drawing.Color]::White)',
    '  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
    '  $graphics.DrawString($env:LINE_FINGERPRINT_TEST_HEADER, $headerFont, [System.Drawing.Brushes]::Black, 20, 20)',
    '  $graphics.DrawString($env:LINE_FINGERPRINT_TEST_BODY, $bodyFont, [System.Drawing.Brushes]::Black, 20, 112)',
    '  $bitmap.Save($env:LINE_FINGERPRINT_TEST_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)',
    '} finally { $bodyFont.Dispose(); $headerFont.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }',
  ].join('; ');
  await execFile(WINDOWS_POWERSHELL, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    windowsHide: true,
    timeout: 10_000,
    env: {
      ...process.env,
      LINE_FINGERPRINT_TEST_OUTPUT: pngPath,
      LINE_FINGERPRINT_TEST_HEADER: header,
      LINE_FINGERPRINT_TEST_BODY: body,
    },
  });
}
