import { routineMsg } from './routine-messages';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

describe('routineMsg', () => {
  it('отдаёт английские строки для en', () => {
    const m = routineMsg('en');

    expect(m.energyTitle).toBe('Energy of the day from Raya 🌅');
    expect(m.reminder).toBe('Reminder');
    expect(m.assistant).toBe('assistant');
  });

  it('отдаёт русские строки для ru', () => {
    expect(routineMsg('ru').energyTitle).toBe('Энергия дня от Райи 🌅');
  });

  it('откатывается на русский для неизвестного языка', () => {
    expect(routineMsg('uz')).toEqual(routineMsg('ru'));
  });

  // Сторож: упадёт, когда в SUPPORTED_LANGUAGES добавят язык, а строки забудут.
  it('покрывает все языки из SUPPORTED_LANGUAGES', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(routineMsg(lang).energyTitle).toBeTruthy();
      expect(routineMsg(lang).reminder).toBeTruthy();
      expect(routineMsg(lang).assistant).toBeTruthy();
      // Не откат на русский — именно свои строки для каждого языка.
      if (lang !== 'ru') expect(routineMsg(lang)).not.toEqual(routineMsg('ru'));
    }
  });
});
