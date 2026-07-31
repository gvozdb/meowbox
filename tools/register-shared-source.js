'use strict';

const Module = require('node:module');
const path = require('node:path');

const sharedSource = path.resolve(__dirname, '../shared/src/index.ts');
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveMeowboxSource(
  request,
  parent,
  isMain,
  options,
) {
  if (request === '@meowbox/shared') {
    return sharedSource;
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};
