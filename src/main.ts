import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { attachVoiceWs } from './voice/voice-ws';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const bodyParser = require('body-parser');
  // Коллбэки Changelly: тело нужно байт в байт (подпись считается по байтам),
  // поэтому raw монтируется ДО json — тот увидит req._body и парсить не станет.
  // Любой content-type: спека Changelly его не фиксирует.
  app.use(
    '/webhook/callbacks/changelly',
    bodyParser.raw({ type: () => true, limit: '256kb' }),
  );
  app.use(bodyParser.raw({ type: ['image/*'], limit: '10mb' }));
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
