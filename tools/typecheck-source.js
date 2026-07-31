#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const projectRoot = resolve(__dirname, '..');
const tempBase = join(projectRoot, 'api', 'node_modules', '.cache');
mkdirSync(tempBase, { recursive: true });
const tempPrefix = join(tempBase, 'meowbox-source-typecheck-');
const tempRoot = mkdtempSync(tempPrefix);

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function writeConfig(name, project, paths) {
  const configPath = join(tempRoot, `${name}.json`);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        extends: join(projectRoot, project, 'tsconfig.json'),
        compilerOptions: {
          noEmit: true,
          incremental: false,
          baseUrl: projectRoot,
          paths,
        },
        include: [join(projectRoot, project, 'src/**/*')],
        exclude: [
          join(projectRoot, project, 'node_modules'),
          join(projectRoot, project, 'dist'),
        ],
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return configPath;
}

try {
  const sharedTypes = join(tempRoot, 'shared');
  run(
    join(projectRoot, 'shared', 'node_modules', '.bin', 'tsc'),
    [
      '-p',
      join(projectRoot, 'shared', 'tsconfig.json'),
      '--emitDeclarationOnly',
      '--declaration',
      '--declarationMap',
      'false',
      '--outDir',
      sharedTypes,
      '--incremental',
      'false',
      '--pretty',
      'false',
    ],
    projectRoot,
  );

  const prismaClient = join(tempRoot, 'prisma-client');
  const schema = readFileSync(
    join(projectRoot, 'api', 'prisma', 'schema.prisma'),
    'utf8',
  );
  const generatedSchema = schema.replace(
    'generator client {\n',
    `generator client {\n  output = ${JSON.stringify(prismaClient)}\n`,
  );
  if (generatedSchema === schema) {
    throw new Error('Prisma client generator block was not found');
  }
  const schemaPath = join(tempRoot, 'schema.prisma');
  writeFileSync(schemaPath, generatedSchema, { flag: 'wx', mode: 0o600 });
  run(
    join(projectRoot, 'api', 'node_modules', '.bin', 'prisma'),
    ['generate', '--schema', schemaPath],
    join(projectRoot, 'api'),
    {
      ...process.env,
      DATABASE_URL: pathToFileURL(join(tempRoot, 'typecheck.db')).href,
    },
  );

  const sharedPath = join(sharedTypes, 'index.d.ts');
  const agentConfig = writeConfig('agent.json', 'agent', {
    '@meowbox/shared': [sharedPath],
  });
  run(
    join(projectRoot, 'agent', 'node_modules', '.bin', 'tsc'),
    ['-p', agentConfig, '--pretty', 'false'],
    projectRoot,
  );

  const apiConfig = writeConfig('api.json', 'api', {
    '@meowbox/shared': [sharedPath],
    '@prisma/client': [prismaClient],
  });
  run(
    join(projectRoot, 'api', 'node_modules', '.bin', 'tsc'),
    ['-p', apiConfig, '--pretty', 'false'],
    projectRoot,
  );
} finally {
  if (!resolve(tempRoot).startsWith(resolve(tempPrefix))) {
    throw new Error(`Refusing to clean unexpected path: ${tempRoot}`);
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
