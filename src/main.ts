import { NestFactory } from '@nestjs/core';
import { ConsoleLogger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new ConsoleLogger({ json: true }) });
  app.enableShutdownHooks();
  const document = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Jungle Wagering Processor')
    .setDescription('API para carteiras, apostas e reconciliação financeira.')
    .setVersion('1.0.0')
    .build());
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
