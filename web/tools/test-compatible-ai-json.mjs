import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function loadTs(name) {
  const source = await readFile(new URL('../src/' + name, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

const { buildCompatibleAiPrompt, parseCompatibleAiJson, exportCompatibleToAiJson } = await loadTs('compatibleAiJson.ts')

const examCtx = { paper: 'A4', page: 1, sides: 2, statistics: false, anonymous: false, candidateLength: 9, nextQuestionNumber: 1 }
const examPrompt = buildCompatibleAiPrompt(examCtx)
assert.match(examPrompt, /客观题/)
assert.match(examPrompt, /主观题/)
assert.match(examPrompt, /norm1000/)

const statsCtx = { paper: 'A4', page: 1, sides: 1, statistics: true, anonymous: true, candidateLength: 0, nextQuestionNumber: 1 }
const statsPrompt = buildCompatibleAiPrompt(statsCtx)
assert.match(statsPrompt, /无需识别准考证号/)
assert.match(statsPrompt, /统计项目/)

// Parse noisy markdown-fenced JSON with batch choices, subjective multi-region, norm1000 coordinates, and box_2d
const aiReply = `好的，识别结果如下：
\`\`\`json
{
  "coord_unit": "norm1000",
  "anchors": [
    { "x": 30, "y": 20, "width": 25, "height": 18 },
    { "box_2d": [20, 945, 38, 970] }
  ],
  "candidate": { "length": 8, "direction": "vertical", "box": { "x": 600, "y": 100, "width": 320, "height": 220 } },
  "absent": { "x": 540, "y": 110, "width": 25, "height": 18 },
  "choices": [
    { "numbers": "1-3", "type": "single", "options": 4, "points": 3, "box": { "x": 80, "y": 360, "width": 200, "height": 60 } },
    { "number": 4, "type": "multiple", "options": 4, "points": 4, "cells": [
      { "x": 80, "y": 430, "width": 35, "height": 18 },
      { "x": 130, "y": 430, "width": 35, "height": 18 },
      { "x": 180, "y": 430, "width": 35, "height": 18 },
      { "x": 230, "y": 430, "width": 35, "height": 18 }
    ] }
  ],
  "subjective": [
    { "number": 16, "points": 12, "regions": [{ "x": 60, "y": 500, "width": 880, "height": 180 }, { "x": 60, "y": 700, "width": 880, "height": 150 }] }
  ],
}
\`\`\`
请粘贴导入。`

const parsed = parseCompatibleAiJson(aiReply, examCtx)
assert.equal(parsed.anchors.length, 2)
assert.equal(parsed.candidateLength, 8)
assert.equal(parsed.candidate.length, 8)
assert.equal(parsed.candidate[0].length, 10)
assert.ok(parsed.absent && parsed.absent.x > 100)
assert.equal(parsed.choices.length, 4)
assert.deepEqual(parsed.choices.map(c => c.number), [1, 2, 3, 4])
assert.equal(parsed.choices[3].type, 'multiple')
assert.equal(parsed.subjective.length, 1)
assert.equal(parsed.subjective[0].regions.length, 2)

// Statistics mode ignores subjective and supports up to 26 options across multiple rows
const statsReply = JSON.stringify({
  coord_unit: 'norm1000',
  choices: [
    { number: 1, title: '最喜欢的课程', type: 'multiple', options: 16, rows: 2, box: { x: 80, y: 200, width: 840, height: 80 } },
  ],
  subjective: [{ number: 2, points: 10, regions: [{ x: 80, y: 400, width: 840, height: 200 }] }],
})
const parsedStats = parseCompatibleAiJson(statsReply, statsCtx)
assert.equal(parsedStats.choices.length, 1)
assert.equal(parsedStats.choices[0].options, 16)
assert.equal(parsedStats.choices[0].cells.length, 16)
assert.equal(parsedStats.subjective.length, 0)
assert.equal(parsedStats.warnings.length, 1)

// Export roundtrip produces valid JSON parseable back cleanly
const exported = exportCompatibleToAiJson({
  paper: 'A4',
  external_sheet: {
    version: 1,
    mode: 'blank',
    pages: { '1': { anchors: parsed.anchors.map(a => ({ ...a, pattern: '' })), candidate: parsed.candidate, absent: parsed.absent } },
  },
  questions: [
    { id: 'q1', number: 1, type: 'single', options: 4, points: 3, answer: [], regions: [{ page: 1, ...parsed.choices[0].region }], external_options: parsed.choices[0].cells },
    { id: 'q16', number: 16, type: 'subjective', options: 0, points: 12, answer: [], regions: parsed.subjective[0].regions.map(r => ({ page: 1, ...r })) },
  ],
}, 1)
const roundtrip = parseCompatibleAiJson(exported, examCtx)
assert.equal(roundtrip.choices.length, 1)
assert.equal(roundtrip.subjective.length, 1)
assert.equal(roundtrip.candidate.length, 8)
console.log('Compatible AI prompt and JSON parser passed: exam/statistics prompts, norm1000/box_2d parsing, batch choices, multi-region subjective and roundtrip export')
