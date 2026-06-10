import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostsFilePath,
  shouldChmod,
  chooseEnvSource,
  missingHostEntries,
  windowsHostsInstructions,
  parseCommand,
  UsageError,
  HOST_ENTRIES,
} from './stack.mjs';

test('hostsFilePath returns the Windows path on win32', () => {
  assert.equal(hostsFilePath('win32'), 'C:\\Windows\\System32\\drivers\\etc\\hosts');
});

test('hostsFilePath returns /etc/hosts on unix', () => {
  assert.equal(hostsFilePath('darwin'), '/etc/hosts');
  assert.equal(hostsFilePath('linux'), '/etc/hosts');
});

test('shouldChmod is true on unix, false on windows', () => {
  assert.equal(shouldChmod('darwin'), true);
  assert.equal(shouldChmod('linux'), true);
  assert.equal(shouldChmod('win32'), false);
});

test('chooseEnvSource respects precedence', () => {
  assert.equal(
    chooseEnvSource({ envExists: true, localExists: true, templateExists: true }),
    'skip',
  );
  assert.equal(
    chooseEnvSource({ envExists: false, localExists: true, templateExists: true }),
    'env.local',
  );
  assert.equal(
    chooseEnvSource({ envExists: false, localExists: false, templateExists: true }),
    'env.template',
  );
  assert.equal(
    chooseEnvSource({ envExists: false, localExists: false, templateExists: false }),
    'none',
  );
});

test('missingHostEntries finds absent entries and ignores present ones', () => {
  assert.deepEqual(missingHostEntries(''), HOST_ENTRIES);
  assert.deepEqual(missingHostEntries('127.0.0.1 keycloak\n127.0.0.1 minio\n'), []);
  assert.deepEqual(missingHostEntries('127.0.0.1   keycloak\n'), [['127.0.0.1', 'minio']]);
});

test('missingHostEntries does not partial-match a longer hostname', () => {
  assert.deepEqual(missingHostEntries('127.0.0.1 keycloak2\n127.0.0.1 minio\n'), [
    ['127.0.0.1', 'keycloak'],
  ]);
});

test('windowsHostsInstructions includes the path and the missing lines', () => {
  const out = windowsHostsInstructions([['127.0.0.1', 'minio']], 'win32');
  assert.match(out, /System32\\drivers\\etc\\hosts/);
  assert.match(out, /127\.0\.0\.1 minio/);
});

test('parseCommand returns a valid command', () => {
  assert.equal(parseCommand(['node', 'stack.mjs', 'up']), 'up');
  assert.equal(parseCommand(['node', 'stack.mjs', 'rebuild-web']), 'rebuild-web');
});

test('parseCommand throws UsageError on unknown or missing command', () => {
  assert.throws(() => parseCommand(['node', 'stack.mjs', 'bogus']), UsageError);
  assert.throws(() => parseCommand(['node', 'stack.mjs']), UsageError);
});
