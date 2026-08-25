'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const HTTP_DECORATORS = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['All', 'ALL'],
  ['Head', 'HEAD'],
  ['Options', 'OPTIONS'],
]);

const SOCKET_LIFECYCLE_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'error',
  'newListener',
  'removeListener',
]);

function listFiles(root, predicate) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && predicate(absolute)) result.push(absolute);
    }
  };
  visit(root);
  return result.sort();
}

function decoratorsOf(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function expressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function decoratorCall(decorator) {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression)) {
    return {
      name: expressionName(expression.expression),
      arguments: [...expression.arguments],
    };
  }
  return { name: expressionName(expression), arguments: [] };
}

function literalValues(expression, constants) {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => literalValues(element, constants));
  }
  if (ts.isIdentifier(expression) && constants.has(expression.text)) {
    return constants.get(expression.text);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const pathProperty = expression.properties.find((property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'path') ||
        (ts.isStringLiteralLike(property.name) && property.name.text === 'path')),
    );
    return pathProperty && ts.isPropertyAssignment(pathProperty)
      ? literalValues(pathProperty.initializer, constants)
      : [];
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = literalValues(expression.left, constants);
    const right = literalValues(expression.right, constants);
    return left.flatMap((leftValue) => right.map((rightValue) => leftValue + rightValue));
  }
  return [];
}

function sourceConstants(sourceFile) {
  const constants = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const values = literalValues(declaration.initializer, constants);
      if (values.length > 0) constants.set(declaration.name.text, values);
    }
  }
  return constants;
}

function decoratorStrings(node, decoratorName, constants) {
  const values = [];
  for (const decorator of decoratorsOf(node)) {
    const call = decoratorCall(decorator);
    if (call.name !== decoratorName) continue;
    for (const argument of call.arguments) {
      values.push(...literalValues(argument, constants));
    }
  }
  return values;
}

function hasDecorator(node, decoratorName) {
  return decoratorsOf(node).some((decorator) => decoratorCall(decorator).name === decoratorName);
}

function normalizeRoute(...parts) {
  const segments = [];
  for (const part of parts) {
    const normalized = String(part ?? '').replace(/^\/+|\/+$/g, '');
    if (normalized) segments.push(normalized);
  }
  return `/api${segments.length > 0 ? `/${segments.join('/')}` : ''}`;
}

function methodName(member, sourceFile) {
  if (!member.name) return '<anonymous>';
  if (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) return member.name.text;
  return member.name.getText(sourceFile);
}

function relativeRepoPath(repositoryRoot, file) {
  return path.relative(repositoryRoot, file).split(path.sep).join('/');
}

function routeActionId(method, routeTemplate) {
  const route = routeTemplate
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment === '*') return 'wildcard';
      if (segment.startsWith(':')) return `by-${segment.slice(1).toLowerCase()}`;
      return segment.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'segment';
    })
    .join('.');
  return `http.${method.toLowerCase()}.${route || 'root'}`;
}

function discoverHttpActions(repositoryRoot) {
  const controllerFiles = listFiles(
    path.join(repositoryRoot, 'api', 'src'),
    (file) => file.endsWith('.controller.ts'),
  );
  const actions = [];
  for (const file of controllerFiles) {
    const sourceText = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const constants = sourceConstants(sourceFile);
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const controllerDecorator = decoratorsOf(statement)
        .map(decoratorCall)
        .find((decorator) => decorator.name === 'Controller');
      if (!controllerDecorator) continue;
      const controllerPaths = controllerDecorator.arguments.length === 0
        ? ['']
        : controllerDecorator.arguments.flatMap((argument) => literalValues(argument, constants));
      if (controllerPaths.length === 0) {
        throw new Error(`Unresolved @Controller path in ${relativeRepoPath(repositoryRoot, file)}`);
      }
      const classRoles = decoratorStrings(statement, 'Roles', constants);
      const classPublic = hasDecorator(statement, 'Public');
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const routeDecorators = decoratorsOf(member)
          .map(decoratorCall)
          .filter((decorator) => HTTP_DECORATORS.has(decorator.name));
        for (const routeDecorator of routeDecorators) {
          const method = HTTP_DECORATORS.get(routeDecorator.name);
          const methodPaths = routeDecorator.arguments.length === 0
            ? ['']
            : routeDecorator.arguments.flatMap((argument) => literalValues(argument, constants));
          if (methodPaths.length === 0) {
            throw new Error(
              `Unresolved @${routeDecorator.name} path in ${relativeRepoPath(repositoryRoot, file)}#${methodName(member, sourceFile)}`,
            );
          }
          const methodRoles = decoratorStrings(member, 'Roles', constants);
          const isPublic = classPublic || hasDecorator(member, 'Public');
          for (const controllerPath of controllerPaths) {
            for (const methodPath of methodPaths) {
              const routeTemplate = normalizeRoute(controllerPath, methodPath);
              actions.push({
                sourceKey: `http:${method}:${routeTemplate}`,
                actionId: routeActionId(method, routeTemplate),
                transport: { kind: 'http', method, routeTemplate },
                roles: isPublic
                  ? ['PUBLIC']
                  : methodRoles.length > 0
                    ? methodRoles
                    : classRoles.length > 0
                      ? classRoles
                      : ['AUTHENTICATED_ANY'],
                isPublic,
                codeOwner: {
                  file: relativeRepoPath(repositoryRoot, file),
                  symbol: `${statement.name?.text ?? '<anonymous>'}.${methodName(member, sourceFile)}`,
                },
              });
            }
          }
        }
      }
    }
  }
  return actions;
}

function enclosingMethodName(node, sourceFile) {
  let current = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) {
      return methodName(current, sourceFile);
    }
    current = current.parent;
  }
  return '<module>';
}

function socketActionId(direction, event) {
  const normalized = event === '*'
    ? 'wildcard'
    : event.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return `ws.${direction.replaceAll('_', '-')}.${normalized || 'event'}`;
}

function inferSocketDirection(file, enclosingMethod, receiver, callName, event) {
  const isAgentSource = file.includes(`${path.sep}agent${path.sep}src${path.sep}`);
  if (enclosingMethod === 'startProxyMode' && event?.startsWith('proxy:')) {
    return 'transport_lifecycle';
  }
  if (callName.startsWith('emitToAgent')) return 'api_to_agent';
  if (isAgentSource) return callName === 'on' || callName === 'once' ? 'api_to_agent' : 'agent_to_api';
  if (/agent/i.test(enclosingMethod) || /agent/i.test(receiver)) {
    return callName === 'on' || callName === 'once' ? 'agent_to_api' : 'api_to_agent';
  }
  return callName === 'on' || callName === 'once' ? 'browser_to_api' : 'api_to_browser';
}

function socketChannel(direction) {
  switch (direction) {
    case 'api_to_agent': return 'agent-rpc';
    case 'agent_to_api': return 'agent-telemetry';
    case 'browser_to_api': return 'browser-command';
    case 'api_to_browser': return 'browser-notification';
    case 'transport_lifecycle': return 'proxy-lifecycle';
    default: throw new Error(`Unsupported Socket.IO direction ${direction}`);
  }
}

function discoverSocketActions(repositoryRoot) {
  const files = [
    path.join(repositoryRoot, 'api', 'src', 'gateway', 'agent.gateway.ts'),
    path.join(repositoryRoot, 'api', 'src', 'gateway', 'agent-relay.service.ts'),
    path.join(repositoryRoot, 'agent', 'src', 'agent.service.ts'),
    path.join(repositoryRoot, 'agent', 'src', 'main.ts'),
  ].filter(fs.existsSync);
  const bySourceKey = new Map();
  const legacyUnsafeFindings = [];
  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callName = node.expression.name.text;
        const receiver = node.expression.expression.getText(sourceFile);
        const isListener = ['on', 'once', 'onAny'].includes(callName);
        const isEmitter = callName === 'emit' || callName.startsWith('emitToAgent');
        const socketReceiver = /(?:^|\b)(?:client|socket|agentSocket|upstream|server)(?:\b|\.)/.test(receiver) ||
          receiver.includes('this.relay') || receiver.includes('this.server');
        if ((isListener || isEmitter) && socketReceiver) {
          const event = callName === 'onAny'
            ? '*'
            : node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
              ? node.arguments[0].text
              : null;
          if (callName === 'onAny') {
            const enclosingMethod = enclosingMethodName(node, sourceFile);
            const receiverName = receiver.includes('upstream') ? 'upstream' : 'client';
            legacyUnsafeFindings.push({
              findingId: `legacy.proxy-relay.${receiverName}-on-any`,
              transport: {
                kind: 'socket.io',
                channel: 'proxy-relay',
                event: '*',
                direction: 'relay_bidirectional',
              },
              codeOwner: {
                file: relativeRepoPath(repositoryRoot, file),
                symbol: enclosingMethod,
              },
              sourceKey: `socket:legacy-proxy-relay:${receiverName}:*`,
            });
          } else if (event && !SOCKET_LIFECYCLE_EVENTS.has(event)) {
            const enclosingMethod = enclosingMethodName(node, sourceFile);
            const direction = inferSocketDirection(file, enclosingMethod, receiver, callName, event);
            const channel = socketChannel(direction);
            const sourceKey = `socket:${direction}:${event}`;
            if (!bySourceKey.has(sourceKey)) {
              bySourceKey.set(sourceKey, {
                sourceKey,
                actionId: socketActionId(direction, event),
                transport: { kind: 'socket.io', channel, event, direction },
                roles: ['UNKNOWN_REQUIRES_CHARACTERIZATION'],
                isPublic: false,
                codeOwner: {
                  file: relativeRepoPath(repositoryRoot, file),
                  symbol: enclosingMethod,
                },
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return {
    actions: [...bySourceKey.values()],
    legacyUnsafeFindings,
  };
}

function assertUniqueInventory(actions) {
  const sourceKeys = new Set();
  const actionIds = new Set();
  for (const action of actions) {
    if (sourceKeys.has(action.sourceKey)) {
      throw new Error(`Duplicate source action ${action.sourceKey}`);
    }
    if (actionIds.has(action.actionId)) {
      throw new Error(`Duplicate action id ${action.actionId}`);
    }
    sourceKeys.add(action.sourceKey);
    actionIds.add(action.actionId);
  }
}

function discoverFederationSourceInventory(repositoryRoot) {
  const socket = discoverSocketActions(repositoryRoot);
  const actions = [
    ...discoverHttpActions(repositoryRoot),
    ...socket.actions,
  ].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  assertUniqueInventory(actions);
  assertUniqueInventory(socket.legacyUnsafeFindings.map((finding) => ({
    sourceKey: finding.sourceKey,
    actionId: finding.findingId,
  })));
  return {
    actions,
    legacyUnsafeFindings: socket.legacyUnsafeFindings.sort((left, right) =>
      left.sourceKey.localeCompare(right.sourceKey)),
  };
}

module.exports = {
  discoverFederationSourceInventory,
  discoverHttpActions,
  discoverSocketActions,
};
