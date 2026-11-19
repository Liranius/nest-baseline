import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions } from './config.js';
import { hashPassword } from '../security/password.js';

const action = process.argv[2];
if (action !== 'migrate' && action !== 'seed') throw new Error('Expected migrate or seed');
const db = await new DataSource(databaseOptions()).initialize();
try {
  if (action === 'migrate') {
    const applied = await db.runMigrations();
    console.log('Migrations applied:', applied.length);
  } else {
    const accounts = [
      [
        '10000000-0000-4000-8000-000000000001',
        'employee-a',
        'employee',
        '20000000-0000-4000-8000-000000000001',
        'SEED_PASSWORD_A',
      ],
      [
        '10000000-0000-4000-8000-000000000002',
        'employee-b',
        'employee',
        '20000000-0000-4000-8000-000000000002',
        'SEED_PASSWORD_B',
      ],
      ['10000000-0000-4000-8000-000000000003', 'lab-admin', 'admin', null, 'SEED_PASSWORD_ADMIN'],
    ] as const;
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO organizations VALUES
        ('20000000-0000-4000-8000-000000000001','Company A'), ('20000000-0000-4000-8000-000000000002','Company B')
        ON CONFLICT (id) DO NOTHING`);
      await tx.query(`INSERT INTO equipment VALUES
        ('30000000-0000-4000-8000-000000000001','Microscope'), ('30000000-0000-4000-8000-000000000002','Spectrometer')
        ON CONFLICT (id) DO NOTHING`);
      for (const [id, login, role, org, variable] of accounts) {
        const password = process.env[variable];
        if (!password || password.length < 12 || password.length > 256)
          throw new Error(variable + ' must contain 12 to 256 characters');
        await tx.query(
          'INSERT INTO accounts (id,login,role,organization_id,password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
          [id, login, role, org, await hashPassword(password)],
        );
      }
    });
    console.log('Seed completed');
  }
} finally {
  await db.destroy();
}
