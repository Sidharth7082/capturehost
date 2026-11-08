import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from '../utils/env.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createLogger } from '../logger.js';
import { BackupService } from '../services/backup.js';
import { CaddyService } from '../services/caddy.js';
import { DockerService } from '../services/docker.js';
import { DoctorService } from '../services/doctor.js';

/**
 * Operator CLI: backups and the security doctor.
 *
 *   npm run backup:create
 *   npm run backup:list
 *   npm run backup:verify <file>
 *   npm run backup:restore <file>
 *   npm run doctor
 *
 * Restore refuses to run while the backend is listening, because replacing a
 * live database underneath a running process is how you get a corrupt one.
 */

loadEnvFile();
const config = loadConfig();
const logger = createLogger(config);

function openDb() {
  const db = openDatabase(config.dbPath);
  migrate(db);
  return db;
}

/** Is anything listening on the configured backend port? */
function backendIsRunning(): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = connect({ host: '127.0.0.1', port: config.port }, () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.on('error', () => resolvePort(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case 'backup:create': {
      const db = openDb();
      try {
        const backups = new BackupService({ db, config, logger });
        const result = await backups.create('manual');
        console.log(`created  ${result.filename}`);
        console.log(`size     ${formatBytes(result.sizeBytes)}`);
        console.log(`sha256   ${result.sha256}`);
        console.log(`integrity ${result.integrity}`);
      } finally {
        db.close();
      }
      return;
    }

    case 'backup:list': {
      const db = openDb();
      try {
        const backups = new BackupService({ db, config, logger });
        const rows = backups.list();

        if (rows.length === 0) {
          console.log('no backups yet');
          return;
        }

        console.log('created              kind       size      integrity  file');
        for (const row of rows) {
          console.log(
            [
              new Date(row.created_at).toISOString(),
              row.kind.padEnd(10),
              formatBytes(row.size_bytes).padEnd(9),
              row.integrity.padEnd(9),
              row.filename,
            ].join('  '),
          );
        }
      } finally {
        db.close();
      }
      return;
    }

    case 'backup:verify': {
      if (!argument) throw new Error('usage: npm run backup:verify <file>');
      const db = openDb();
      try {
        const backups = new BackupService({ db, config, logger });
        const result = backups.verify(resolve(argument));

        console.log(`file       ${argument}`);
        console.log(`ok         ${result.ok}`);
        console.log(`integrity  ${result.integrity}`);
        console.log(`tables     ${result.tables}`);
        console.log(`size       ${formatBytes(result.sizeBytes)}`);
        if (result.error) console.log(`error      ${result.error}`);

        process.exitCode = result.ok ? 0 : 1;
      } finally {
        db.close();
      }
      return;
    }

    case 'backup:restore': {
      if (!argument) throw new Error('usage: npm run backup:restore <file>');

      const file = resolve(argument);
      if (!existsSync(file)) throw new Error(`no such file: ${file}`);

      if (await backendIsRunning()) {
        throw new Error(
          `the backend is running on 127.0.0.1:${config.port}. Stop it first (systemctl stop capturehost, or Ctrl-C the dev server).`,
        );
      }

      const db = openDb();
      try {
        const backups = new BackupService({ db, config, logger });
        const result = backups.restore(file);

        console.log(`restored   ${result.restoredFrom}`);
        console.log(`tables     ${result.tables}`);
        console.log(`safety     ${result.safetyCopy}`);
        console.log('migrations applied; start the backend again with: npm run dev');
      } finally {
        // `restore` closes the handle and reopens internally; closing twice is
        // harmless but guard it so the CLI exits cleanly.
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
      return;
    }

    case 'doctor': {
      const db = openDb();
      try {
        const doctor = new DoctorService({
          db,
          config,
          logger,
          caddy: new CaddyService({ db, config, logger }),
          docker: new DockerService({ config, logger }),
        });

        const report = await doctor.run();
        const icon = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' } as const;

        for (const check of report.checks) {
          console.log(`${icon[check.status].padEnd(5)} ${check.title}`);
          console.log(`      ${check.detail}`);
          if (check.fix) console.log(`      fix: ${check.fix}`);
        }

        console.log(
          `\n${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skip} skipped`,
        );

        process.exitCode = report.summary.fail > 0 ? 1 : 0;
      } finally {
        db.close();
      }
      return;
    }

    default:
      console.log(
        [
          'usage:',
          '  npm run backup:create',
          '  npm run backup:list',
          '  npm run backup:verify <file>',
          '  npm run backup:restore <file>',
          '  npm run doctor',
        ].join('\n'),
      );
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
