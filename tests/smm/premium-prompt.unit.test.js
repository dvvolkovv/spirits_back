const path = require('path');
const { buildPremiumPromptSection } = require(
  path.join(__dirname, '..', '..', 'dist', 'smm', 'producer', 'smm-producer.prompt'),
);

module.exports = {
  'premium-prompt: surreal содержит ключевые слова morphing/scale': () => {
    const s = buildPremiumPromptSection('surreal');
    if (!/morphing/i.test(s) || !/scale/i.test(s)) throw new Error(`surreal:\n${s}`);
    if (!/type:\s*['"]kling['"]/i.test(s)) throw new Error('должна быть инструкция type:kling');
  },
  'premium-prompt: pov содержит first-person/handheld': () => {
    const s = buildPremiumPromptSection('pov');
    if (!/first.person|handheld/i.test(s)) throw new Error(`pov:\n${s}`);
  },
  'premium-prompt: cinematic содержит dolly/slow camera/dramatic': () => {
    const s = buildPremiumPromptSection('cinematic');
    if (!/dolly|slow camera|dramatic/i.test(s)) throw new Error(`cinematic:\n${s}`);
  },
  'premium-prompt: null возвращает пустую строку (классика)': () => {
    const s = buildPremiumPromptSection(null);
    if (s !== '') throw new Error(`expected '', got: ${s}`);
  },
};
