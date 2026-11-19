// Run inside the stage 4 application image on a read-only connection before admitting traffic.
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookEndpoints } from '@nestjs/webhooks';
import { DataSource } from 'typeorm';
import { databaseOptions } from './dist/database/config.js';
import { NotificationsModule } from './dist/notifications/module.js';

class RecoveryChecks {}
Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: databaseOptions }),
    NotificationsModule.register(false),
  ],
})(RecoveryChecks);
const app = await NestFactory.createApplicationContext(RecoveryChecks, { logger: false });
try {
  const db = app.get(DataSource);
  if (await db.showMigrations()) throw new Error('Pending database migrations');
  const endpoints = app.get(WebhookEndpoints);
  for (const company of ['A', 'B']) {
    const [org] = await db.query('SELECT id FROM organizations WHERE name=$1', [
      'Company ' + company,
    ]);
    const subscriptions = await endpoints.list({ tenant: org.id });
    const [endpoint] = subscriptions;
    if (
      subscriptions.length !== 1 ||
      !endpoint.enabled ||
      endpoint.url !== process.env['WEBHOOK_URL_' + company]
    )
      throw new Error('Unexpected restored subscription for ' + company);
    let secret;
    try {
      secret = await endpoints.getSecret(endpoint.id);
    } catch {
      throw new Error('RECOVERY_KEY_MISMATCH');
    }
    if (!secret || secret !== process.env['WEBHOOK_SECRET_' + company])
      throw new Error('Restored signing secret does not match receiver ' + company);
  }
  console.log('0 pending migrations; verified both restored signing secrets');
} finally {
  await app.close();
}
