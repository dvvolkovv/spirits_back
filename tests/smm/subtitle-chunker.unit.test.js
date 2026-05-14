const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { chunkSubtitles } = require(
  path.join(__dirname, '..', '..', 'worker', 'dist', 'tts', 'subtitle-chunker'),
);

module.exports = {
  'chunker: single short phrase → 1 chunk': () => {
    const out = chunkSubtitles('Привет, как дела?', 0, 2);
    if (out.length !== 1) throw new Error(`Expected 1 chunk, got ${out.length}`);
    if (out[0].text !== 'Привет, как дела?') throw new Error(`text mismatch: ${out[0].text}`);
    if (out[0].tStart !== 0) throw new Error(`tStart=${out[0].tStart}`);
    if (out[0].tEnd !== 2) throw new Error(`tEnd=${out[0].tEnd}`);
  },

  'chunker: long phrase splits on punctuation': () => {
    const out = chunkSubtitles(
      'Я хорошо понимаю твою тревогу. Это сейчас типичная история. Попробуй три простых шага.',
      0, 9,
    );
    if (out.length < 3) throw new Error(`Expected >=3 chunks, got ${out.length}`);
    for (let i = 1; i < out.length; i++) {
      if (out[i].tStart < out[i-1].tEnd - 0.01) {
        throw new Error(`overlap at ${i}: ${out[i-1].tEnd} → ${out[i].tStart}`);
      }
    }
    if (Math.abs(out[0].tStart - 0) > 0.01) throw new Error('first tStart not 0');
    if (Math.abs(out[out.length-1].tEnd - 9) > 0.01) throw new Error('last tEnd not 9');
  },

  'chunker: long phrase without punctuation chunks by word count': () => {
    const out = chunkSubtitles(
      'один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать',
      0, 6,
    );
    if (out.length < 2) throw new Error(`Expected >=2 chunks, got ${out.length}`);
    for (const c of out) {
      const words = c.text.split(/\s+/);
      if (words.length > 5) throw new Error(`chunk too long (${words.length} words): "${c.text}"`);
    }
  },

  'chunker: distributes duration proportionally to chunk length': () => {
    const out = chunkSubtitles('Раз. И ещё много слов в этом длинном предложении.', 0, 10);
    if (out.length < 2) throw new Error(`Expected >=2 chunks`);
    const shortDur = out[0].tEnd - out[0].tStart;
    const longDur = out[out.length-1].tEnd - out[out.length-1].tStart;
    if (shortDur >= longDur) throw new Error(`expected short < long: ${shortDur} vs ${longDur}`);
  },

  'chunker: empty string → 0 chunks': () => {
    const out = chunkSubtitles('', 0, 2);
    if (out.length !== 0) throw new Error(`Expected 0 chunks, got ${out.length}`);
  },
};
