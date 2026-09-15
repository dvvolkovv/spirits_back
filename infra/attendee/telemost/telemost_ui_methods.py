"""
Вход бота во встречу Яндекс Телемоста: работа с интерфейсом страницы.

Разметка разведана спайком 14.09.2026 (`infra/attendee/telemost-spike.mjs`):
экран до входа — «Ваше имя на встрече», поле имени и зелёная кнопка
«Подключиться»; после входа внизу панель с «Участники» и «Чат».

Селекторы держим ТЕРПИМЫМИ: по видимому тексту и по нескольким признакам
сразу, а не по классам. Классы у Телемоста собраны сборщиком и меняются от
выката к выкату, а подпись кнопки — нет. Тот же урок нам стоил двух живых
встреч на Google Meet, где поиск микрофона был прибит к тегу `button`, а
кнопка оказалась `div`.
"""

import logging
import time

from selenium.common.exceptions import ElementNotInteractableException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from bots.web_bot_adapter.ui_methods import (
    UiCouldNotClickElementException,
    UiCouldNotJoinMeetingWaitingForHostException,
    UiCouldNotLocateElementException,
    UiMeetingNotFoundException,
    UiRetryableExpectedException,
)

logger = logging.getLogger(__name__)

# Сколько ждём, пока страница встречи вообще появится.
PAGE_LOAD_TIMEOUT_SECONDS = 60

# Сколько ждём панель встречи после нажатия «Подключиться». Комната ожидания у
# Телемоста бывает, и хозяин может думать: минута — это минимум, дальше решает
# наш собственный таймер ожидания впуска.
JOINED_TIMEOUT_SECONDS = 60


class TelemostUIMethods:
    # ── Мелкие помощники ────────────────────────────────────────────────────
    #
    # Те же, что у адаптера Meet. Общей базы для них у моста нет: каждый
    # адаптер держит свою копию, и наша ничем не лучше — повторяем, чтобы не
    # зависеть от чужого файла, который апстрим вправе переписать.

    def locate_element(self, step, condition, wait_time_seconds=60):
        try:
            return WebDriverWait(self.driver, wait_time_seconds).until(condition)
        except Exception as e:
            logger.warning(f"Телемост: не нашли элемент на шаге {step} ({type(e).__name__})")
            raise UiCouldNotLocateElementException(f"Телемост: элемент не найден на шаге {step}", step, e)

    def click_element(self, element, step):
        try:
            element.click()
        except ElementNotInteractableException as e:
            # Кликаем скриптом: у Телемоста кнопки бывают перекрыты overlay-ем
            # ровно в момент появления.
            logger.warning(f"Телемост: элемент не кликается на шаге {step}, пробуем скриптом")
            try:
                self.driver.execute_script("arguments[0].click();", element)
            except Exception as inner:
                raise UiCouldNotClickElementException("Телемост: клик не прошёл", step, inner) from e
        except Exception as e:
            raise UiCouldNotClickElementException("Телемост: клик не прошёл", step, e)


    def _xpath_with_text(self, text):
        """Любой кликабельный элемент с такой подписью.

        Без привязки к тегу: кнопка у Телемоста может оказаться и `div` с
        `role="button"` — ровно как микрофон в Meet.
        """
        return (
            f'//*[self::button or @role="button"][contains(normalize-space(.), "{text}")]'
        )

    def _find_optional(self, xpath, timeout=3):
        try:
            return self.locate_element(
                step="telemost_optional",
                condition=EC.presence_of_element_located((By.XPATH, xpath)),
                wait_time_seconds=timeout,
            )
        except Exception:
            return None

    # ── Шаги входа ──────────────────────────────────────────────────────────

    def check_if_meeting_is_found(self):
        """Ссылка ведёт в никуда — это не сбой, а ответ, и он должен быть внятным."""
        body = self.driver.find_element(By.TAG_NAME, "body").text or ""
        for marker in ("Встреча завершена", "Встреча не найдена", "Ссылка недействительна"):
            if marker in body:
                raise UiMeetingNotFoundException(f"Телемост: {marker}", "check_if_meeting_is_found")

    def fill_out_name_input(self):
        """Имя бота на экране до входа.

        Поле одно, но подписи у него в разных сборках разные, поэтому берём
        первое текстовое поле на экране. Пустое имя Телемост принимает, но
        участники увидят «Гость» — а нам нужно, чтобы человек понимал, кто
        пришёл.
        """
        name_input = self.locate_element(
            step="name_input",
            condition=EC.presence_of_element_located(
                (By.XPATH, '//input[@type="text" or contains(@placeholder, "мя")]')
            ),
            wait_time_seconds=PAGE_LOAD_TIMEOUT_SECONDS,
        )
        name_input.clear()
        name_input.send_keys(self.display_name)
        logger.info("Телемост: имя введено")

    def click_join_button(self):
        join_button = self.locate_element(
            step="join_button",
            condition=EC.element_to_be_clickable((By.XPATH, self._xpath_with_text("Подключиться"))),
            wait_time_seconds=PAGE_LOAD_TIMEOUT_SECONDS,
        )
        self.click_element(join_button, "join_button")
        logger.info("Телемост: нажата «Подключиться»")

    def wait_until_in_meeting(self):
        """Дождаться, что мы ВНУТРИ встречи, а не на экране ожидания.

        Признак — панель встречи: кнопки «Участники» и «Чат». Проверять по
        исчезновению кнопки «Подключиться» нельзя: на экране ожидания её тоже
        нет, и бот считал бы себя вошедшим, сидя в прихожей.
        """
        deadline = time.monotonic() + JOINED_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if self._find_optional(self._xpath_with_text("Участники"), timeout=2):
                logger.info("Телемост: панель встречи на месте — мы внутри")
                return
            body = (self.driver.find_element(By.TAG_NAME, "body").text or "")
            if "Дождитесь" in body or "ожидания" in body:
                # Нас держат в комнате ожидания. Это не ошибка: хозяин ещё не
                # нажал «Впустить». Отдаём наверх ожидаемое исключение — мост
                # сам решит, ждать дальше или сдаться по своему таймеру.
                raise UiCouldNotJoinMeetingWaitingForHostException(
                    "Телемост: ждём, пока впустят", "wait_until_in_meeting"
                )
            time.sleep(2)
        raise UiCouldNotLocateElementException(
            "Телемост: панель встречи так и не появилась", "wait_until_in_meeting"
        )

    def turn_off_media_inputs(self):
        """Камеру выключаем, микрофон НЕ трогаем.

        Микрофон боту нужен включённым: через него идёт голос ассистента, и
        подменённую дорожку Телемост принимает как есть (проверено спайком —
        тон был слышен без единого клика). Камеру, наоборот, выключаем: бот
        показывал бы чёрный прямоугольник и зря тратил бы полосу.
        """
        camera = self._find_optional('//*[@role="button"][contains(@aria-label, "камер")]', timeout=3)
        if camera is None:
            logger.info("Телемост: кнопки камеры не нашлось — оставляем как есть")
            return
        try:
            self.click_element(camera, "camera_off")
            logger.info("Телемост: камера выключена")
        except Exception as e:
            logger.warning(f"Телемост: камеру выключить не вышло: {e}")

    def open_chat_panel(self):
        """Открыть панель чата и оставить открытой.

        Без этого лента сообщений в кадре мессенджера просто не отрисована:
        кадр есть, наш сценарий в нём работает (в логе `chat_frame_ready`), а
        читать нечего. Живой прогон 15.09.2026 дал ровно такую картину.

        Панель никому не мешает: экран бота не видит никто, запись мы не
        ведём. Ошибку глотаем — без чтения чата встреча всё равно состоится.
        """
        button = self._find_optional(
            '//*[@data-testid="chat-alt-button"]'
            f' | {self._xpath_with_text("Чат")}',
            timeout=10,
        )
        if button is None:
            logger.info("Телемост: кнопки чата не нашлось — чат читать не будем")
            return
        try:
            self.click_element(button, "open_chat")
            logger.info("Телемост: панель чата открыта")
        except Exception as e:
            logger.warning(f"Телемост: панель чата не открылась: {e}")

    # ── Точка входа, которую зовёт мост ─────────────────────────────────────

    def attempt_to_join_meeting(self):
        # CSP страницы отключаем ДО перехода, иначе вебсокет нагрузки к мосту
        # блокируется браузером и бот остаётся немым в обе стороны.
        #
        # У Телемоста заголовок строгий: `default-src 'none'` с точным списком
        # доменов Яндекса. Наша нагрузка живёт в той же странице, и её
        # `new WebSocket("ws://localhost:…")` под это правило не попадает —
        # соединение не открывается вовсе, молча. Живой заход 14.09.2026: бот
        # вошёл во встречу, панель на месте, а от страницы к мосту не приехало
        # ни одного сообщения.
        #
        # Meet, Zoom и Teams обходятся без этого — их политика мягче.
        try:
            self.driver.execute_cdp_cmd("Page.setBypassCSP", {"enabled": True})
            logger.info("Телемост: CSP страницы отключён для нагрузки")
        except Exception as e:
            logger.warning(f"Телемост: не удалось отключить CSP: {e}")

        self.driver.get(self.meeting_url)
        self.driver.execute_cdp_cmd(
            "Browser.grantPermissions",
            {
                "origin": self.meeting_url,
                "permissions": ["audioCapture", "videoCapture"],
            },
        )
        self.check_if_meeting_is_found()
        self.fill_out_name_input()
        self.turn_off_media_inputs()
        self.click_join_button()
        self.wait_until_in_meeting()
        self.open_chat_panel()
        self.ready_to_show_bot_image()

    def click_leave_button(self):
        """Выход из встречи.

        Кнопка подписана не текстом, а иконкой, поэтому ищем по подписи для
        незрячих; если не нашли — не беда: мост всё равно закроет браузер.
        Тихо уйти хуже, чем уйти некрасиво, только в одном случае — если
        встреча продолжит считать бота участником, а это решает сервер по
        разрыву соединения.
        """
        leave = self._find_optional(
            '//*[self::button or @role="button"][contains(@aria-label, "Выйти")'
            ' or contains(@aria-label, "Завершить") or contains(@title, "Выйти")]',
            timeout=5,
        )
        if leave is None:
            logger.info("Телемост: кнопки выхода не нашлось — закроем браузер")
            return
        try:
            self.click_element(leave, "leave_button")
            logger.info("Телемост: нажата кнопка выхода")
        except Exception as e:
            logger.warning(f"Телемост: выйти по кнопке не вышло: {e}")


__all__ = ["TelemostUIMethods", "UiRetryableExpectedException"]
