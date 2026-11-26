import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NodeAdapter } from '@nestjs/platform-node';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppController } from '../src/app.controller.js';
import { AppService } from '../src/app.service.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = moduleFixture.createNestApplication(new NodeAdapter());
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect('Content-Type', 'text/html; charset=utf-8')
      .expect(200, 'Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});
