const flag = (name: string): boolean => String(process.env[name] || '').toLowerCase() === 'true';

/** Рубильник конвейера. Включать последним — после канала в short_settings (спека, «Среды и выкат»). */
export const shortsEnabled = (): boolean => flag('SHORTS_ENABLED');
/** Воскресное наполнение очереди и запуск роликов к слотам. На стенде выключен: ролик стартует из админки. */
export const autoTopicsEnabled = (): boolean => flag('SHORTS_AUTO_TOPICS');
/** Стенд: пометка «СТЕНД» в сообщениях владельцу. */
export const isStand = (): boolean => flag('SHORTS_STAND');
