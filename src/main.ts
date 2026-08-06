import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { attachVoiceWs } from './voice/voice-ws';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const bodyParser = require('body-parser');
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
