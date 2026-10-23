import { afterEach, beforeEach, describe, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  const previousWorkersEnabled = process.env.WORKERS_ENABLED;

  beforeEach(async () => {
    process.env.WORKERS_ENABLED = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health/live (GET)', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  afterEach(async () => {
    await app.close();
    if (previousWorkersEnabled === undefined) delete process.env.WORKERS_ENABLED;
    else process.env.WORKERS_ENABLED = previousWorkersEnabled;
  });
});
