import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { attachVoiceWs } from './voice/voice-ws';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const bodyParser = require('body-parser');

  // Проба без регистрации — тесный потолок тела ДЛЯ ЛЮБОГО Content-Type
  // (ревью A-final/F4): открытые ручки guest/* не защищены JWT, а без этой
  // группы анонимный запрос обходил бы тесный лимит через x-www-form-urlencoded
  // (общий парсер ниже — 50mb) или просто подделанным Content-Type вроде
  // image/* (общий raw ниже — 10mb, и раньше он стоял ПЕРЕД узким парсером
  // guest, так что ловил такой запрос первым). Группа обязана идти ПЕРВОЙ,
  // до всех глобальных парсеров: body-parser помечает тело req._body сразу
  // после разбора, и все парсеры ниже (в т.ч. общие) эту метку видят и
  // пропускают разбор повторно — поэтому для guest первым должен сработать
  // именно этот, тесный набор. Внутри группы: json/text → urlencoded →
  // raw-catch-all (на всё, что не подошло по Content-Type предыдущим двум).
  app.use('/webhook/guest', bodyParser.json({ limit: '64kb', type: ['application/json', 'text/*'] }));
  app.use('/webhook/guest', bodyParser.urlencoded({ limit: '64kb', extended: true }));
  app.use('/webhook/guest', bodyParser.raw({ type: () => true, limit: '64kb' }));

  app.use(bodyParser.raw({ type: ['image/*'], limit: '10mb' }));

  // Коллбэк «Приёма» — СЫРЫМ телом, и обязательно ДО глобального JSON ниже.
  // Подпись HMAC считается по тем самым байтам, что пришли; разобранный и
  // собранный обратно JSON её не пройдёт — изменится порядок ключей или пробелы.
  // Путь указан целиком с префиксом: setGlobalPrefix ниже на app.use не влияет.
  app.use('/webhook/priem/callback', bodyParser.raw({ type: '*/*', limit: '1mb' }));

  // Внутренние ручки голосового звонка — сырым телом, как и коллбэк «Приёма»:
  // HMAC считается по пришедшим байтам, пересобранный JSON подпись не пройдёт.
  app.use('/webhook/voice-call/internal', bodyParser.raw({ type: '*/*', limit: '1mb' }));

  app.use(bodyParser.json({ limit: '50mb', type: ['application/json', 'text/*'] }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  // /webhook is the global prefix for backwards-compat with n8n routes,
  // but /mcp is mounted at the root for the MCP bridge to file-agent.
  app.setGlobalPrefix('webhook', {
    exclude: [{ path: 'mcp', method: RequestMethod.ALL }],
  });

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Authorization,Content-Type,Accept',
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));

  // WebSocket-шлюз потоковой диктовки (SpeechKit) поверх того же HTTP-сервера.
  attachVoiceWs(app);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Backend running on port ${port}`);
}
bootstrap();
