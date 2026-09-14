import { assistantSignature, ownerGenitive } from './assistant-signature';

describe('ownerGenitive', () => {
  it('склоняет имена на -й', () => {
    expect(ownerGenitive('Дмитрий')).toBe('Дмитрия');
    expect(ownerGenitive('Сергей')).toBe('Сергея');
    expect(ownerGenitive('Николай')).toBe('Николая');
  });

  it('склоняет имена на мягкий знак', () => {
    expect(ownerGenitive('Игорь')).toBe('Игоря');
  });

  it('склоняет имена на -я', () => {
    expect(ownerGenitive('Илья')).toBe('Ильи');
    expect(ownerGenitive('Мария')).toBe('Марии');
    expect(ownerGenitive('Ксения')).toBe('Ксении');
  });

  it('склоняет имена на -а, различая шипящие и заднеязычные', () => {
    expect(ownerGenitive('Анна')).toBe('Анны');
    expect(ownerGenitive('Никита')).toBe('Никиты');
    expect(ownerGenitive('Ольга')).toBe('Ольги');
    expect(ownerGenitive('Саша')).toBe('Саши');
  });

  it('склоняет имена на согласную', () => {
    expect(ownerGenitive('Роман')).toBe('Романа');
    expect(ownerGenitive('Владимир')).toBe('Владимира');
    expect(ownerGenitive('Олег')).toBe('Олега');
  });

  it('не трогает имена на прочие гласные — они не склоняются', () => {
    // Нино, Дарко, Пабло: родительный совпадает с именительным.
    for (const n of ['Нино', 'Дарко', 'Пабло', 'Дэни']) {
      expect(ownerGenitive(n)).toBe(n);
    }
  });

  it('не трогает латиницу: склонять её нечем', () => {
    expect(ownerGenitive('Dmitry')).toBe('Dmitry');
    expect(ownerGenitive('Anna')).toBe('Anna');
  });

  it('не трогает имя из нескольких слов', () => {
    // «Дмитрий Волков» склонился бы верно, а «Мария Волкова» — нет: у женских
    // фамилий на -ова родительный «Волковой», и правило для имён его не даёт.
    // Ошибиться в фамилии участника хуже, чем оставить её в именительном.
    expect(ownerGenitive('Дмитрий Волков')).toBe('Дмитрий Волков');
  });

  it('пустое имя — заглушка в родительном', () => {
    expect(ownerGenitive('')).toBe('пользователя');
    expect(ownerGenitive(null)).toBe('пользователя');
    expect(ownerGenitive('   ')).toBe('пользователя');
  });

  it('заглушку не склоняет повторно', () => {
    // resolveOwnerName отдаёт «пользователя» вместо отсутствующего имени —
    // оно УЖЕ в родительном, и общее правило на -я сделало бы «пользователи».
    expect(ownerGenitive('пользователя')).toBe('пользователя');
  });
});

describe('assistantSignature', () => {
  it('собирает подпись с именем владельца в родительном', () => {
    expect(assistantSignature('Роман', 'Дмитрий')).toBe('Роман · ассистент Дмитрия');
  });

  it('без имени владельца подставляет заглушку', () => {
    expect(assistantSignature('Роман', null)).toBe('Роман · ассистент пользователя');
    expect(assistantSignature('Роман', 'пользователя')).toBe('Роман · ассистент пользователя');
  });
});
