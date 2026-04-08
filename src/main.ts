import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const bodyParser = require('body-parser');
  // Raw body for avatar uploads (image/*)
  app.use(bodyParser.raw({ type: 'image/*', limit: '10mb' }));
  // JSON for everything else
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  app.setGlobalPrefix('webhook');

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Authorization,Content-Type,Accept',
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Backend running on port ${port}`);
}
bootstrap();
