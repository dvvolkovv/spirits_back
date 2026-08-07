# Озвучка во Flutter — Фаза 3 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показать в мобильном приложении аудио-плеер для клипов, которые ассистент создаёт инструментом `generate_speech`.

**Architecture:** Бэкенд дописывает в текст ответа маркер `{{audio:id=<uuid>}}`. Мобилка извлекает id из сырого текста (до вырезания тегов), рисует под сообщением карточку на каждый клип, карточка тянет метаданные через `GET /webhook/speech/:id` и играет mp3 через `just_audio`. Всё зеркалит уже работающий путь SMM-карточек.

**Tech Stack:** Flutter, Dart SDK `^3.10.8`, `dio` (через `ApiClient`), `flutter_markdown_plus`, `just_audio` (добавляем), `flutter_test`, gen-l10n с шестью локалями.

**Спека:** `spirits_back/docs/superpowers/specs/2026-08-07-assistant-tts-phase3-flutter-design.md`

**Репозиторий:** `~/Downloads/linkeon_mobile` — отдельный git, ветка `main`. Бэкенд `spirits_back` и веб `spirits_front` в этой фазе НЕ трогаем.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `lib/models/speech.dart` | `SpeechClip` + чистая `extractAudioClipIds(text)` |
| `test/models/speech_test.dart` | тесты разбора маркера и парсинга модели |
| `lib/services/speech_service.dart` | `fetchClip(id)` → `GET /webhook/speech/:id` |
| `lib/config/api_config.dart` | +`speechClipUri(id)` (правка) |
| `lib/widgets/audio_clip_card.dart` | карточка плеера |
| `lib/widgets/chat_markdown.dart` | вызов извлечения + отрисовка карточек (правка) |
| `test/widgets/chat_markdown_audio_test.dart` | ключевой тест: из маркера родилась карточка |
| `lib/l10n/app_*.arb` | три новых ключа в шести локалях |
| `pubspec.yaml` | зависимость `just_audio` |

---

## Task 1: Разбор маркера и модель клипа

**Files:**
- Create: `lib/models/speech.dart`
- Test: `test/models/speech_test.dart`

- [ ] **Step 1: Написать падающий тест**

Создать `test/models/speech_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:linkeon_mobile/models/speech.dart';

void main() {
  group('extractAudioClipIds', () {
    const id = '3c027094-74c4-40de-a400-9eabd8691867';

    test('находит маркер в середине текста', () {
      expect(extractAudioClipIds('Готово {{audio:id=$id}} слушай'), [id]);
    });

    test('находит маркер в начале и в конце', () {
      expect(extractAudioClipIds('{{audio:id=$id}}'), [id]);
      expect(extractAudioClipIds('текст\n\n{{audio:id=$id}}'), [id]);
    });

    test('несколько маркеров возвращаются в порядке появления', () {
      const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      expect(
        extractAudioClipIds('{{audio:id=$id}}\n{{audio:id=$b}}'),
        [id, b],
      );
    });

    test('нет маркера — пустой список', () {
      expect(extractAudioClipIds('просто текст'), isEmpty);
    });

    test('мусорный id не распознаётся', () {
      expect(extractAudioClipIds('{{audio:id=abc}}'), isEmpty);
      expect(extractAudioClipIds('{{audio:id=${id.toUpperCase()}}}'), isEmpty);
      expect(extractAudioClipIds('{{audio:id=${id.substring(1)}}}'), isEmpty);
    });

    test('соседние маркеры SMM не захватываются', () {
      const t = '{{smm_video:id=$id}} {{smm_scenario:id=$id}}';
      expect(extractAudioClipIds(t), isEmpty);
    });
  });

  group('SpeechClip.fromJson', () {
    // Реальный ответ GET /webhook/speech/:id — снят курлом с прода 2026-08-07
    test('РЕАЛЬНЫЙ контракт эндпоинта', () {
      final c = SpeechClip.fromJson({
        'id': '3c027094-74c4-40de-a400-9eabd8691867',
        'url':
            'https://my.linkeon.io/smm-media/linkeon-assets/audio/9a2fcb9a.mp3',
        'durationSec': 2.4,
        'chars': 36,
        'voice': 'alena',
        'provider': 'yandex',
        'lang': 'ru',
        'createdAt': '2026-08-07T12:36:00.926Z',
      });
      expect(c.id, '3c027094-74c4-40de-a400-9eabd8691867');
      expect(c.url, contains('9a2fcb9a.mp3'));
      expect(c.durationSec, closeTo(2.4, 0.001));
      expect(c.voice, 'alena');
    });

    test('durationSec приходит целым числом — не падаем', () {
      final c = SpeechClip.fromJson({
        'id': 'x',
        'url': 'https://example.test/a.mp3',
        'durationSec': 3,
      });
      expect(c.durationSec, 3.0);
    });

    test('durationSec отсутствует — ноль, а не исключение', () {
      final c = SpeechClip.fromJson({'id': 'x', 'url': 'u'});
      expect(c.durationSec, 0);
    });
  });
}
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `cd ~/Downloads/linkeon_mobile && flutter test test/models/speech_test.dart`
Expected: FAIL — `Target of URI doesn't exist: 'package:linkeon_mobile/models/speech.dart'`

- [ ] **Step 3: Написать реализацию**

Создать `lib/models/speech.dart`:

```dart
/// Клип озвучки, созданный ассистентом через инструмент `generate_speech`.
///
/// Приходит из `GET /webhook/speech/:id`. Длительность бэкенд оценивает по
/// числу символов — точную отдаёт уже плеер после загрузки файла.
class SpeechClip {
  final String id;
  final String url;
  final double durationSec;
  final String? voice;

  const SpeechClip({
    required this.id,
    required this.url,
    required this.durationSec,
    this.voice,
  });

  factory SpeechClip.fromJson(Map<String, dynamic> json) {
    final d = json['durationSec'];
    return SpeechClip(
      id: json['id']?.toString() ?? '',
      url: json['url']?.toString() ?? '',
      // Число приходит то int, то double — приводим оба случая.
      durationSec: d is num ? d.toDouble() : 0,
      voice: json['voice']?.toString(),
    );
  }
}

/// Маркер озвучки, который бэкенд дописывает в текст ответа ассистента.
///
/// Строго нижний регистр и ровно 36 символов uuid: тот же вид, что у
/// `extractSmmRefs` в `models/smm.dart`, и та же форма, что генерирует
/// бэкенд (`chat.service.ts`, блок инъекции маркеров).
final _audioClipRe = RegExp(r'\{\{audio:id=([a-f0-9-]{36})\}\}');

/// Достаёт id клипов из текста сообщения, в порядке появления.
///
/// ВЫЗЫВАТЬ ТОЛЬКО НА СЫРОМ ТЕКСТЕ, до `ChatMarkdown.stripCustomTags`:
/// та вырезает вообще все `{{...}}`, и на очищенном тексте список всегда
/// будет пустым — молча, без ошибки.
List<String> extractAudioClipIds(String text) =>
    _audioClipRe.allMatches(text).map((m) => m.group(1)!).toList();
```

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `flutter test test/models/speech_test.dart`
Expected: PASS, 9 тестов

- [ ] **Step 5: ОБЯЗАТЕЛЬНО — проверить тесты в обратную сторону**

Зелёный прогон сам по себе ничего не доказывает: в этом проекте уже были и ложно-зелёные тесты, и тест, переживший полное отключение проверяемой логики.

1. В регулярке заменить `{36}` на `+`. Прогнать.
   Expected: FAIL на «мусорный id не распознаётся» (короткий `abc` начнёт совпадать). Вернуть, убедиться что снова PASS.
2. В регулярке заменить `audio` на `[a-z_]+`. Прогнать.
   Expected: FAIL на «соседние маркеры SMM не захватываются». Вернуть.
3. Убрать приведение `d.toDouble()`, оставив `json['durationSec'] as double`. Прогнать.
   Expected: FAIL на «durationSec приходит целым числом». Вернуть.

Привести в отчёте фактический вывод всех трёх проверок.

- [ ] **Step 6: Коммит**

```bash
cd ~/Downloads/linkeon_mobile
git add lib/models/speech.dart test/models/speech_test.dart
git commit -m "feat(speech): модель клипа и разбор маркера озвучки"
```

---

## Task 2: Сервис клипа

**Files:**
- Create: `lib/services/speech_service.dart`
- Modify: `lib/config/api_config.dart`
- Test: `test/services/speech_service_test.dart`

- [ ] **Step 1: Добавить URI**

В `lib/config/api_config.dart`, рядом с остальными `static Uri ...Uri(...)`:

```dart
  /// `GET /webhook/speech/:id` — метаданные клипа озвучки.
  static Uri speechClipUri(String id) =>
      Uri.parse('$backendUrl/webhook/speech/$id');
```

- [ ] **Step 2: Написать падающий тест**

Создать `test/services/speech_service_test.dart`:

```dart
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:linkeon_mobile/services/api_client.dart';
import 'package:linkeon_mobile/services/speech_service.dart';

/// `ApiClient` — обычный класс, поэтому наследуемся и переопределяем только
/// нужный метод. Сигнатура сверена с `lib/services/api_client.dart:129`:
/// `getUri(Uri uri, {bool skipAuth = false})`.
class _FakeApi extends ApiClient {
  final int status;
  final dynamic body;
  Uri? lastUri;
  _FakeApi({this.status = 200, this.body});

  @override
  Future<Response<dynamic>> getUri(Uri uri, {bool skipAuth = false}) async {
    lastUri = uri;
    return Response(
      requestOptions: RequestOptions(path: uri.toString()),
      statusCode: status,
      data: body,
    );
  }
}

void main() {
  group('SpeechService.fetchClip', () {
    test('парсит успешный ответ', () async {
      final api = _FakeApi(
        body: {
          'id': '3c027094-74c4-40de-a400-9eabd8691867',
          'url': 'https://example.test/a.mp3',
          'durationSec': 2.4,
          'voice': 'alena',
        },
      );
      final clip = await SpeechService(api: api).fetchClip('3c027094');
      expect(clip.url, 'https://example.test/a.mp3');
      expect(clip.voice, 'alena');
    });

    test('id подставляется в путь запроса', () async {
      final api = _FakeApi(body: {'id': 'x', 'url': 'u'});
      await SpeechService(api: api).fetchClip('my-clip-id');
      expect(api.lastUri.toString(), contains('/webhook/speech/my-clip-id'));
    });

    test('404 превращается в ApiException со статусом', () async {
      final api = _FakeApi(status: 404, body: {'message': 'not found'});
      expect(
        () => SpeechService(api: api).fetchClip('nope'),
        throwsA(
          isA<ApiException>().having((e) => e.statusCode, 'statusCode', 404),
        ),
      );
    });
  });
}
```

`ApiException` объявлен в том же `api_client.dart` (`ApiException(message, {statusCode})`), отдельного импорта не нужно.

- [ ] **Step 3: Запустить тест, убедиться что падает**

Run: `flutter test test/services/speech_service_test.dart`
Expected: FAIL — нет `speech_service.dart`

- [ ] **Step 4: Написать сервис**

Создать `lib/services/speech_service.dart`:

```dart
import '../config/api_config.dart';
import '../models/speech.dart';
import 'api_client.dart';

/// Клипы озвучки. Создаёт их ассистент инструментом `generate_speech`;
/// мобилка только читает метаданные по id из маркера в тексте ответа.
class SpeechService {
  final ApiClient _api;
  SpeechService({ApiClient? api}) : _api = api ?? ApiClient();

  /// `GET /webhook/speech/:id`. Бэкенд фильтрует по владельцу, поэтому на
  /// чужой клип придёт 404 — обрабатываем как обычную ошибку.
  Future<SpeechClip> fetchClip(String id) async {
    final resp = await _api.getUri(ApiConfig.speechClipUri(id));
    final code = resp.statusCode;
    if (code == null || code >= 400) {
      throw ApiException('speech clip fetch failed', statusCode: code);
    }
    return SpeechClip.fromJson(Map<String, dynamic>.from(resp.data as Map));
  }
}
```

- [ ] **Step 5: Запустить тест**

Run: `flutter test test/services/speech_service_test.dart`
Expected: PASS, 3 теста

- [ ] **Step 6: Обратная проверка**

Убрать проверку `code >= 400` (всегда парсить тело). Прогнать.
Expected: FAIL на «404 превращается в ApiException». Вернуть, убедиться что PASS.

- [ ] **Step 7: Коммит**

```bash
git add lib/services/speech_service.dart lib/config/api_config.dart test/services/speech_service_test.dart
git commit -m "feat(speech): сервис метаданных клипа"
```

---

## Task 3: Строки локализации

Делается ДО карточки: без ключей в `app_ru.arb` не появятся геттеры в `app_localizations.dart`, и карточка не пройдёт `flutter analyze`.

Учти: `flutter gen-l10n` при забытом ключе НЕ падает — он завершается кодом 0, пишет пропуск в `l10n-missing.json` и подставляет русский текст в чужую локаль. Единственная реальная проверка — `node tool/check_arb.mjs` (exit 1). Она добавлена в CI, но при локальной работе её надо звать руками.

**Files:**
- Modify: `lib/l10n/app_ru.arb`, `app_en.arb`, `app_es.arb`, `app_de.arb`, `app_fr.arb`, `app_zh.arb`

- [ ] **Step 1: Добавить ключи в русский файл (источник правды)**

В `lib/l10n/app_ru.arb`:

```json
  "audioPlay": "Воспроизвести",
  "@audioPlay": { "description": "Подпись кнопки запуска озвучки в чате" },
  "audioPause": "Пауза",
  "@audioPause": { "description": "Подпись кнопки паузы озвучки в чате" },
  "audioLoadError": "Не удалось загрузить аудио",
  "@audioLoadError": { "description": "Сообщение вместо плеера, когда клип не загрузился" },
```

- [ ] **Step 2: Добавить переводы в пять остальных локалей**

Переводы по смыслу, не копии русского:

| Файл | audioPlay | audioPause | audioLoadError |
|---|---|---|---|
| `app_en.arb` | `Play` | `Pause` | `Couldn't load the audio` |
| `app_es.arb` | `Reproducir` | `Pausa` | `No se pudo cargar el audio` |
| `app_de.arb` | `Abspielen` | `Pause` | `Audio konnte nicht geladen werden` |
| `app_fr.arb` | `Lire` | `Pause` | `Impossible de charger l'audio` |
| `app_zh.arb` | `播放` | `暂停` | `音频加载失败` |

Блоки `@ключ` с описанием нужны только в `app_ru.arb` — в остальных локалях их не дублировать, как и у существующих ключей.

- [ ] **Step 3: Перегенерировать локализации и проверить сторожами**

```bash
flutter gen-l10n
node tool/check_arb.mjs
```
Expected: `l10n-missing.json` пустой или отсутствует; `check_arb.mjs` зелёный.

Если `check_arb.mjs` ругается на порядок ключей или формат — привести в соответствие, он и есть источник правил.

- [ ] **Step 4: Коммит**

```bash
git add lib/l10n/
git commit -m "feat(i18n): строки аудио-плеера в шести локалях"
```

---

## Task 4: Карточка плеера

**Files:**
- Modify: `pubspec.yaml`
- Create: `lib/widgets/audio_clip_card.dart`

- [ ] **Step 1: Добавить зависимость**

```bash
cd ~/Downloads/linkeon_mobile
flutter pub add just_audio
```

Версию не прописывать руками — резолвер подберёт совместимую с Dart SDK `^3.10.8`. После установки проверить, что `flutter pub get` проходит и `pubspec.lock` обновился.

- [ ] **Step 2: Написать карточку**

Создать `lib/widgets/audio_clip_card.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';

import '../l10n/app_localizations.dart';
import '../models/speech.dart';
import '../services/speech_service.dart';
import '../utils/error_text.dart';

/// Плеер одного клипа озвучки — рисуется под сообщением ассистента.
///
/// Метаданные грузятся по id из маркера `{{audio:id=...}}`; сам файл лежит
/// в MinIO и играется по прямой ссылке.
class AudioClipCard extends StatefulWidget {
  final String clipId;

  /// Подменяется в тестах, чтобы карточка не ходила в сеть.
  final SpeechService? service;

  const AudioClipCard({super.key, required this.clipId, this.service});

  @override
  State<AudioClipCard> createState() => _AudioClipCardState();
}

class _AudioClipCardState extends State<AudioClipCard> {
  late final SpeechService _service = widget.service ?? SpeechService();
  final _player = AudioPlayer();

  SpeechClip? _clip;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    // Никакого AppLocalizations.of(context) здесь и в _load: вызов
    // локализации из initState падает в проде, на это стоит сторож
    // tool/check_initstate_l10n.mjs. Все тексты берём в build.
    _load();
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final clip = await _service.fetchClip(widget.clipId);
      await _player.setUrl(clip.url);
      if (!mounted) return;
      setState(() {
        _clip = clip;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = humanError(e);
        _loading = false;
      });
    }
  }

  String _fmt(Duration d) {
    final m = d.inMinutes;
    final s = (d.inSeconds % 60).toString().padLeft(2, '0');
    return '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;

    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: SizedBox(
          height: 56,
          child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
        ),
      );
    }

    if (_error != null || _clip == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Icon(Icons.error_outline, size: 18, color: scheme.error),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                l.audioLoadError,
                style: TextStyle(color: scheme.error, fontSize: 13),
              ),
            ),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
        ),
        child: StreamBuilder<PlayerState>(
          stream: _player.playerStateStream,
          builder: (context, snap) {
            final playing = snap.data?.playing ?? false;
            return Row(
              children: [
                IconButton(
                  tooltip: playing ? l.audioPause : l.audioPlay,
                  icon: Icon(playing ? Icons.pause : Icons.play_arrow),
                  onPressed: () async {
                    if (playing) {
                      await _player.pause();
                    } else {
                      // Доиграв до конца, плеер стоит в конце — иначе
                      // повторное нажатие ничего не воспроизведёт.
                      if (_player.processingState ==
                          ProcessingState.completed) {
                        await _player.seek(Duration.zero);
                      }
                      await _player.play();
                    }
                  },
                ),
                Expanded(
                  child: StreamBuilder<Duration>(
                    stream: _player.positionStream,
                    builder: (context, posSnap) {
                      final pos = posSnap.data ?? Duration.zero;
                      final total =
                          _player.duration ??
                          Duration(
                            milliseconds: (_clip!.durationSec * 1000).round(),
                          );
                      final value = total.inMilliseconds == 0
                          ? 0.0
                          : (pos.inMilliseconds / total.inMilliseconds).clamp(
                              0.0,
                              1.0,
                            );
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          LinearProgressIndicator(value: value),
                          const SizedBox(height: 4),
                          Text(
                            '${_fmt(pos)} / ${_fmt(total)}',
                            style: const TextStyle(fontSize: 12),
                          ),
                        ],
                      );
                    },
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
```

- [ ] **Step 3: Проверить сборку и сторожа**

```bash
flutter analyze lib/widgets/audio_clip_card.dart
node tool/check_initstate_l10n.mjs
```
Expected: analyze без ошибок; сторож зелёный (локализация в `initState` не вызывается).

- [ ] **Step 4: Проверить сторожа в обратную сторону**

Временно добавить в `_load()` первой строкой `final _ = AppLocalizations.of(context);` и прогнать `node tool/check_initstate_l10n.mjs`.
Expected: сторож краснеет. Убрать строку, убедиться что снова зелёный.

Это доказывает, что сторож действительно защищает, а не просто существует.

- [ ] **Step 5: Коммит**

```bash
git add pubspec.yaml pubspec.lock lib/widgets/audio_clip_card.dart
git commit -m "feat(speech): карточка аудио-плеера"
```

---

## Task 5: Подключение к чату

Это ключевая задача: без неё маркер молча вырезается `stripCustomTags`, и пользователь не узнаёт, что к ответу прилагалось аудио.

**Files:**
- Modify: `lib/widgets/chat_markdown.dart:41-51`
- Test: `test/widgets/chat_markdown_audio_test.dart`

- [ ] **Step 1: Написать падающий тест**

Создать `test/widgets/chat_markdown_audio_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:linkeon_mobile/l10n/app_localizations.dart';
import 'package:linkeon_mobile/widgets/audio_clip_card.dart';
import 'package:linkeon_mobile/widgets/chat_markdown.dart';

// Сеть здесь не мокается намеренно: карточка сама переходит в состояние
// ошибки, если метаданные не загрузились, но САМ ВИДЖЕТ при этом создаётся —
// а тест проверяет именно факт «из маркера родилась карточка».

Widget _wrap(Widget child) => MaterialApp(
  localizationsDelegates: const [
    AppLocalizations.delegate,
    GlobalMaterialLocalizations.delegate,
    GlobalWidgetsLocalizations.delegate,
    GlobalCupertinoLocalizations.delegate,
  ],
  supportedLocales: AppLocalizations.supportedLocales,
  locale: const Locale('ru'),
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

void main() {
  const id = '3c027094-74c4-40de-a400-9eabd8691867';

  testWidgets('маркер озвучки превращается в карточку плеера', (tester) async {
    await tester.pumpWidget(
      _wrap(ChatMarkdown(text: 'Озвучил фразу\n\n{{audio:id=$id}}')),
    );
    await tester.pump();

    expect(find.byType(AudioClipCard), findsOneWidget);
  });

  testWidgets('сырой маркер не остаётся видимым текстом', (tester) async {
    await tester.pumpWidget(
      _wrap(ChatMarkdown(text: 'Озвучил фразу\n\n{{audio:id=$id}}')),
    );
    await tester.pump();

    expect(find.textContaining('{{audio'), findsNothing);
  });

  testWidgets('без маркера карточки нет', (tester) async {
    await tester.pumpWidget(_wrap(const ChatMarkdown(text: 'просто ответ')));
    await tester.pump();

    expect(find.byType(AudioClipCard), findsNothing);
  });
}
```

Если прогон падает на незавершённых таймерах `just_audio` — прокинуть заглушку: добавить в `ChatMarkdown` необязательный параметр `SpeechService? speechService`, передавать его в `AudioClipCard(clipId: id, service: speechService)`, а в тесте подсунуть класс, реализующий `SpeechService` с одним методом `fetchClip`. Не отключать тест и не подменять его проверкой регулярки: смысл именно в сквозной связке «текст → виджет», регулярка уже покрыта в Task 1.

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `flutter test test/widgets/chat_markdown_audio_test.dart`
Expected: FAIL — `AudioClipCard` не найден: маркер сейчас просто вырезается.

- [ ] **Step 3: Подключить извлечение**

В `lib/widgets/chat_markdown.dart`, в методе `build`, рядом с существующим `extractSmmRefs`:

```dart
    // Маркеры вытаскиваем ДО stripCustomTags: она вырезает вообще все
    // {{...}}, и на очищенном тексте оба списка всегда были бы пустыми.
    final refs = extractSmmRefs(text);
    final audioIds = extractAudioClipIds(text);
    if (refs.isEmpty && audioIds.isEmpty) return _markdown(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _markdown(context),
        for (final id in audioIds) AudioClipCard(clipId: id),
        for (final ref in refs) SmmRefCard(reference: ref),
      ],
    );
```

Добавить импорты `../models/speech.dart` и `audio_clip_card.dart`.

Порядок важен: плеер идёт сразу за текстом, SMM-карточки ниже — озвучка относится к самой реплике, а карточки роликов это отдельные сущности.

- [ ] **Step 4: Запустить тест**

Run: `flutter test test/widgets/chat_markdown_audio_test.dart`
Expected: PASS, 3 теста

- [ ] **Step 5: Обратные проверки**

1. Убрать `for (final id in audioIds) AudioClipCard(clipId: id),`. Прогнать.
   Expected: FAIL на «маркер превращается в карточку». Вернуть.
2. Перенести `extractAudioClipIds(text)` на `extractAudioClipIds(stripCustomTags(text))`. Прогнать.
   Expected: FAIL на том же тесте — это и есть ловушка порядка из спеки. Вернуть.
3. Прогнать существующие тесты SMM: `flutter test test/widgets/`.
   Expected: карточки SMM продолжают работать, регрессии нет.

Привести фактический вывод всех трёх.

- [ ] **Step 6: Коммит**

```bash
git add lib/widgets/chat_markdown.dart test/widgets/chat_markdown_audio_test.dart
git commit -m "feat(chat): показывать плеер озвучки под сообщением"
```

---

## Task 6: Финальная проверка

- [ ] **Step 1: Полный прогон**

```bash
cd ~/Downloads/linkeon_mobile
flutter analyze
flutter test
node tool/check_arb.mjs
node tool/check_initstate_l10n.mjs
```
Expected: analyze без ошибок; все тесты зелёные; оба сторожа зелёные.

Если что-то падало ДО начала работы — зафиксировать отдельно и не приписывать себе.

- [ ] **Step 2: Проверка на живом бэкенде**

Бэкенд уже в проде, маркеры приходят в ответах. Собрать приложение и вручную:

1. попросить Романа «озвучь фразу: проверка связи»;
2. убедиться, что под ответом появилась карточка и звук играет;
3. выйти из чата и вернуться — карточка должна остаться (маркер лежит в истории на сервере);
4. включить бесшумный режим на iOS и проверить, слышно ли звук. Если нет — нужна настройка аудио-сессии, зафиксировать как отдельную задачу, в эту фазу она не входит.

Если собрать приложение нельзя — честно сказать, что проверено только автотестами, и не выдавать статическую проверку за живую.

- [ ] **Step 3: Финальный коммит и пуш**

```bash
git status --short   # чужого быть не должно
git push origin main
```

---

## Definition of Done

- [ ] Маркер `{{audio:id=...}}` в ответе ассистента рисует карточку плеера
- [ ] Звук играет, прогресс идёт, пауза и повторное воспроизведение работают
- [ ] Битый клип показывает локализованное сообщение, а не мёртвую кнопку
- [ ] Сырой маркер нигде не виден пользователю
- [ ] Три строки переведены во всех шести локалях, оба сторожа зелёные
- [ ] Каждый тест проверен ломкой в обратную сторону
- [ ] SMM-карточки продолжают работать
