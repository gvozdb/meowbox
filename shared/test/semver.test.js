'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compareReleaseSemver,
  isReleaseSemver,
  parseReleaseSemver,
} = require('../dist');

test('T-LEG-002 release semver comparison handles prerelease precedence', () => {
  assert.equal(compareReleaseSemver('v1.0.0', '1.0.0-beta.9'), 1);
  assert.equal(compareReleaseSemver('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareReleaseSemver('1.0.0-beta.2', '1.0.0-beta.alpha'), -1);
  assert.equal(compareReleaseSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(compareReleaseSemver('1.0.0+build.2', '1.0.0+build.1'), 0);
});

test('T-LEG-002 invalid release versions fail closed', () => {
  assert.equal(isReleaseSemver('unknown'), false);
  assert.equal(isReleaseSemver('1.0'), false);
  assert.equal(parseReleaseSemver('01.0.0'), null);
  assert.throws(() => compareReleaseSemver('unknown', '1.0.0'), TypeError);
});
