'use strict';

/**
 * Source inventory for RPP-010.  This deliberately uses the TypeScript AST
 * instead of loading Nest modules: booting an API module would require local
 * credentials, Prisma, and an agent connection, while decorators are a source
 * contract that can be inspected deterministically.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const API_SOURCE_ROOT = path.join(REPOSITORY_ROOT, 'api', 'src');
const AGENT_SOURCE_ROOT = path.join(REPOSITORY_ROOT, 'agent', 'src');
const UNKNOWN = 'UNKNOWN_REQUIRES_CHARACTERIZATION';

class RemotePanelInventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RemotePanelInventoryError';
  }
}

const toPosix = (value) => value.split(path.sep).join('/');
const relativeFile = (file) => toPosix(path.relative(REPOSITORY_ROOT, file));

const walkFiles = (root, predicate) => {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(absolute, predicate));
    else if (entry.isFile() && predicate(absolute)) result.push(absolute);
  }
  return result;
};

const parseSource = (file) => ts.createSourceFile(
  file,
  fs.readFileSync(file, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

const decoratorsOf = (node) => ts.canHaveDecorators(node) ? (ts.getDecorators(node) || []) : [];

const decoratorCall = (decorator) => {
  if (!ts.isCallExpression(decorator.expression)) return null;
  const expression = decorator.expression.expression;
  if (ts.isIdentifier(expression)) return { name: expression.text, call: decorator.expression };
  return null;
};

const decoratorsNamed = (node, name) => decoratorsOf(node)
  .map(decoratorCall)
  .filter((value) => value !== null && value.name === name);

const hasDecorator = (node, name) => decoratorsNamed(node, name).length > 0;

const literalString = (node, context) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  throw new RemotePanelInventoryError(`${context}: expected a static string literal, got ${node.getText()}`);
};

const literalStringList = (node, context) => {
  if (node === undefined) return [''];
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element, index) => literalStringList(element, `${context}[${index}]`));
  }
  return [literalString(node, context)];
};

const lineOf = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

const enclosingSymbol = (node) => {
  let current = node;
  let methodName = null;
  let className = null;
  while (current) {
    if (methodName === null && ts.isMethodDeclaration(current) && current.name) {
      methodName = current.name.getText();
    }
    if (className === null && ts.isClassDeclaration(current) && current.name) {
      className = current.name.text;
    }
    current = current.parent;
  }
  if (className && methodName) return `${className}.${methodName}`;
  if (className) return className;
  return 'SOURCE_SYMBOL_REQUIRES_CHARACTERIZATION';
};

const ownerAt = (file, sourceFile, node) => ({
  file: relativeFile(file),
  symbol: enclosingSymbol(node),
  line: lineOf(sourceFile, node),
});

const routeJoin = (prefix, suffix) => {
  const pieces = [prefix, suffix]
    .flatMap((part) => part.split('/'))
    .filter(Boolean);
  return `/${pieces.join('/')}`;
};

const discoverGlobalPrefix = () => {
  const file = path.join(API_SOURCE_ROOT, 'main.ts');
  const sourceFile = parseSource(file);
  const prefixes = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setGlobalPrefix') {
      prefixes.push(literalString(node.arguments[0], `${relativeFile(file)} setGlobalPrefix`));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (prefixes.length !== 1) {
    throw new RemotePanelInventoryError(`Expected one static app.setGlobalPrefix call, found ${prefixes.length}`);
  }
  return `/${prefixes[0].replace(/^\/+|\/+$/g, '')}`;
};

const roleValue = (expression, context) => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    const terminal = expression.name.text;
    if (['ADMIN', 'MANAGER', 'VIEWER'].includes(terminal)) return terminal;
  }
  throw new RemotePanelInventoryError(`${context}: role is not a supported static role expression`);
};

const rolesFrom = (node, context) => {
  const rolesDecorator = decoratorsNamed(node, 'Roles')[0];
  if (rolesDecorator === undefined) return undefined;
  return rolesDecorator.call.arguments.map((argument, index) => roleValue(argument, `${context} @Roles argument ${index}`));
};

const effectiveRoles = (classDeclaration, method, isPublic, context) => {
  if (isPublic) return ['PUBLIC'];
  const methodRoles = rolesFrom(method, `${context}.${method.name.getText()}`);
  const classRoles = rolesFrom(classDeclaration, context);
  const roles = methodRoles === undefined ? classRoles : methodRoles;
  // JwtAuthGuard is global and Public() is the bypass. RolesGuard then treats
  // absent/empty metadata as authenticated without a role restriction.
  return roles === undefined || roles.length === 0 ? ['AUTHENTICATED_ANY'] : [...roles].sort();
};

const hasIdempotencyHeader = (method) => method.parameters.some((parameter) => {
  const headers = decoratorsNamed(parameter, 'Headers')[0];
  return headers !== undefined && headers.call.arguments.length > 0 &&
    (ts.isStringLiteral(headers.call.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(headers.call.arguments[0])) &&
    headers.call.arguments[0].text.toLowerCase() === 'idempotency-key';
});

const hasFileInterceptor = (method) => decoratorsNamed(method, 'UseInterceptors').some((decorator) =>
  decorator.call.arguments.some((argument) => argument.getText().includes('FileInterceptor')),
);

const discoverHttpRoutes = () => {
  const globalPrefix = discoverGlobalPrefix();
  const routes = [];
  const controllerFiles = walkFiles(API_SOURCE_ROOT, (file) => file.endsWith('.controller.ts'));
  const HTTP_DECORATORS = new Map([
    ['Get', 'GET'], ['Post', 'POST'], ['Put', 'PUT'], ['Patch', 'PATCH'],
    ['Delete', 'DELETE'], ['All', 'ALL'], ['Head', 'HEAD'], ['Options', 'OPTIONS'],
  ]);

  for (const file of controllerFiles) {
    const sourceFile = parseSource(file);
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
      const controller = decoratorsNamed(statement, 'Controller')[0];
      if (controller === undefined) continue;
      if (controller.call.arguments.length > 1) {
        throw new RemotePanelInventoryError(`${relativeFile(file)} @Controller has more than one argument`);
      }
      const prefixes = controller.call.arguments.length === 0
        ? ['']
        : literalStringList(controller.call.arguments[0], `${relativeFile(file)} @Controller`);
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || member.name === undefined) continue;
        const routeDecorators = decoratorsOf(member)
          .map(decoratorCall)
          .filter((decorator) => decorator !== null && HTTP_DECORATORS.has(decorator.name));
        if (routeDecorators.length === 0) continue;
        const publicRoute = hasDecorator(member, 'Public') || hasDecorator(statement, 'Public');
        const roles = effectiveRoles(statement, member, publicRoute, `${relativeFile(file)}:${statement.name.text}`);
        for (const decorator of routeDecorators) {
          if (decorator.call.arguments.length > 1) {
            throw new RemotePanelInventoryError(`${relativeFile(file)} ${decorator.name} has more than one route argument`);
          }
          const suffixes = decorator.call.arguments.length === 0
            ? ['']
            : literalStringList(decorator.call.arguments[0], `${relativeFile(file)} @${decorator.name}`);
          for (const prefix of prefixes) {
            for (const suffix of suffixes) {
              const routeTemplate = routeJoin(globalPrefix, routeJoin(prefix, suffix));
              const method = HTTP_DECORATORS.get(decorator.name);
              const codeOwner = ownerAt(file, sourceFile, member);
              const sourceKey = [
                'http', codeOwner.file, statement.name.text, member.name.getText(), method, routeTemplate,
              ].join('|');
              routes.push({
                sourceKey,
                method,
                routeTemplate,
                roles,
                publicRoute,
                idempotencyDeclared: hasIdempotencyHeader(member),
                multipart: hasFileInterceptor(member),
                codeOwner: { file: codeOwner.file, symbol: codeOwner.symbol },
              });
            }
          }
        }
      }
    }
  }

  const duplicateRoutes = new Set();
  const seenRoutes = new Set();
  for (const route of routes) {
    const key = `${route.method}|${route.routeTemplate}`;
    if (seenRoutes.has(key)) duplicateRoutes.add(key);
    seenRoutes.add(key);
  }
  if (duplicateRoutes.size > 0) {
    throw new RemotePanelInventoryError(`Duplicate Nest method/route declarations: ${[...duplicateRoutes].join(', ')}`);
  }
  return routes.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
};

const staticValues = (expression, sourceFile, useNode, seen = new Set()) => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) && expression.expression.text === 'AGENT_JOB_EVENTS') {
    const events = {
      START: 'job:start',
      STARTED: 'job:started',
      HEARTBEAT: 'job:heartbeat',
      STATUS: 'job:status',
      RESULT: 'job:result',
      CANCEL: 'job:cancel',
    };
    const event = events[expression.name.text];
    if (event) return [event];
  }
  if (ts.isParenthesizedExpression(expression)) return staticValues(expression.expression, sourceFile, useNode, seen);
  if (ts.isConditionalExpression(expression)) {
    return [...new Set([
      ...staticValues(expression.whenTrue, sourceFile, useNode, seen),
      ...staticValues(expression.whenFalse, sourceFile, useNode, seen),
    ])].sort();
  }
  if (ts.isIdentifier(expression)) {
    const declaration = nearestVariableDeclaration(sourceFile, expression.text, useNode);
    if (declaration === null || declaration.initializer === undefined) {
      throw new RemotePanelInventoryError(`${relativeFile(sourceFile.fileName)} cannot resolve finite event variable ${expression.text}`);
    }
    const key = `${declaration.pos}:${expression.text}`;
    if (seen.has(key)) throw new RemotePanelInventoryError(`${relativeFile(sourceFile.fileName)} recursive event variable ${expression.text}`);
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    return staticValues(declaration.initializer, sourceFile, declaration, nextSeen);
  }
  throw new RemotePanelInventoryError(`${relativeFile(sourceFile.fileName)} event expression is not finite/static: ${expression.getText(sourceFile)}`);
};

const enclosingFunction = (node) => {
  let current = node;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
};

const nearestVariableDeclaration = (sourceFile, name, useNode) => {
  const candidates = [];
  const targetFunction = enclosingFunction(useNode);
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.pos < useNode.pos &&
      enclosingFunction(node) === targetFunction) {
      candidates.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  candidates.sort((a, b) => b.pos - a.pos);
  return candidates[0] || null;
};

const collectAiEventTypes = () => {
  const file = path.join(API_SOURCE_ROOT, 'ai', 'ai.service.ts');
  const sourceFile = parseSource(file);
  const values = new Set();
  const visit = (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'AiEvent') {
      const inspect = (typeNode) => {
        if (ts.isTypeLiteralNode(typeNode)) {
          for (const member of typeNode.members) {
            if (ts.isPropertySignature(member) && member.name?.getText() === 'type' && member.type && ts.isLiteralTypeNode(member.type) &&
              (ts.isStringLiteral(member.type.literal) || ts.isNoSubstitutionTemplateLiteral(member.type.literal))) {
              values.add(member.type.literal.text);
            }
          }
        } else if (ts.isUnionTypeNode(typeNode)) {
          typeNode.types.forEach(inspect);
        }
      };
      inspect(node.type);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (values.size === 0) throw new RemotePanelInventoryError('AiEvent has no static event types');
  return [...values].sort();
};

const socketKey = (channel, event) => `socketio|${channel}|${event}`;
const socketBindingKey = (channel, binding, event) => `socketio|${channel}|${binding}|${event}`;

const eventOwner = (file, sourceFile, node) => {
  const owner = ownerAt(file, sourceFile, node);
  return { file: owner.file, symbol: owner.symbol };
};

const receiverName = (expression) => expression.getText().replace(/\s+/g, '');

const isInsideOnAnyRelay = (node) => {
  let current = node.parent;
  while (current) {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'onAny') {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const discoverSocketEvents = () => {
  const actions = new Map();
  const unsafeFindings = new Map();
  const add = (channel, direction, event, binding, file, sourceFile, node) => {
    const sourceKey = socketKey(channel, event);
    const existing = actions.get(sourceKey) || { sourceKey, channel, direction, event, codeOwners: [], sourceBindings: new Set() };
    const owner = eventOwner(file, sourceFile, node);
    if (!existing.codeOwners.some((candidate) => candidate.file === owner.file && candidate.symbol === owner.symbol)) {
      existing.codeOwners.push(owner);
    }
    existing.sourceBindings.add(socketBindingKey(channel, binding, event));
    actions.set(sourceKey, existing);
  };
  const addUnsafe = (sourceKey, file, sourceFile, node) => {
    unsafeFindings.set(sourceKey, {
      sourceKey,
      codeOwner: eventOwner(file, sourceFile, node),
    });
  };

  // API service calls are the current API -> agent RPC catalogue.  Every
  // expression must reduce to finite literals, otherwise this inventory fails
  // rather than silently omitting a remotely reachable command.
  for (const file of walkFiles(API_SOURCE_ROOT, (candidate) => candidate.endsWith('.ts'))) {
    const sourceFile = parseSource(file);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['emitToAgent', 'emitToAgentAsync'].includes(node.expression.name.text)) {
        if (node.arguments.length === 0) throw new RemotePanelInventoryError(`${relativeFile(file)} agent relay call has no event`);
        for (const event of staticValues(node.arguments[0], sourceFile, node)) {
          add('agent-rpc', 'api_to_agent', event, 'api-emitter', file, sourceFile, node);
        }
      }
      if (relativeFile(file) === 'api/src/gateway/agent-relay.service.ts' &&
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'on' && receiverName(node.expression.expression) === 'socket' &&
        node.arguments.length > 0) {
        for (const event of staticValues(node.arguments[0], sourceFile, node)) {
          add('agent-telemetry', 'agent_to_api', event, 'api-handler', file, sourceFile, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // Agent command handlers are the other side of the same logical RPC channel.
  const agentServiceFile = path.join(AGENT_SOURCE_ROOT, 'agent.service.ts');
  const agentService = parseSource(agentServiceFile);
  const visitAgentService = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'safeOn') {
      if (node.arguments.length < 2) throw new RemotePanelInventoryError('safeOn call has no event argument');
      for (const event of staticValues(node.arguments[1], agentService, node)) {
        add('agent-rpc', 'api_to_agent', event, 'agent-handler', agentServiceFile, agentService, node);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'emitOrQueue') {
      if (node.arguments.length === 0) throw new RemotePanelInventoryError('emitOrQueue call has no event argument');
      for (const event of staticValues(node.arguments[0], agentService, node)) {
        add('agent-telemetry', 'agent_to_api', event, 'agent-emitter', agentServiceFile, agentService, node);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'on') {
      const receiver = receiverName(node.expression.expression);
      if (receiver === 'this.socket' && node.arguments.length > 0) {
        for (const event of staticValues(node.arguments[0], agentService, node)) {
          add('agent-lifecycle', 'transport_lifecycle', event, 'agent-client-listener', agentServiceFile, agentService, node);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'emit') {
      const receiver = receiverName(node.expression.expression);
      if (receiver === 'this.socket' && node.arguments.length > 0 &&
        (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
        add('agent-telemetry', 'agent_to_api', node.arguments[0].text, 'agent-emitter', agentServiceFile, agentService, node);
      }
    }
    ts.forEachChild(node, visitAgentService);
  };
  visitAgentService(agentService);

  const agentJobRuntimeFile = path.join(AGENT_SOURCE_ROOT, 'agent-job.runtime.ts');
  const agentJobRuntime = parseSource(agentJobRuntimeFile);
  const visitAgentJobRuntime = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.arguments.length > 0) {
      const method = node.expression.name.text;
      const receiver = receiverName(node.expression.expression);
      if (method === 'on' && receiver === 'socket') {
        for (const event of staticValues(node.arguments[0], agentJobRuntime, node)) {
          add('agent-rpc', 'api_to_agent', event, 'agent-job-handler', agentJobRuntimeFile, agentJobRuntime, node);
        }
      }
      if (method === 'emit' && receiver.startsWith('this.socket')) {
        for (const event of staticValues(node.arguments[0], agentJobRuntime, node)) {
          add('agent-telemetry', 'agent_to_api', event, 'agent-job-emitter', agentJobRuntimeFile, agentJobRuntime, node);
        }
      }
    }
    ts.forEachChild(node, visitAgentJobRuntime);
  };
  visitAgentJobRuntime(agentJobRuntime);

  const runItemFile = path.join(AGENT_SOURCE_ROOT, 'migration', 'hostpanel', 'run-item.ts');
  const runItem = parseSource(runItemFile);
  const visitRunItem = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'emit' &&
      receiverName(node.expression.expression) === 'ctx.socket?' && node.arguments.length > 0) {
      for (const event of staticValues(node.arguments[0], runItem, node)) {
        add('agent-telemetry', 'agent_to_api', event, 'agent-emitter', runItemFile, runItem, node);
      }
    }
    ts.forEachChild(node, visitRunItem);
  };
  visitRunItem(runItem);

  const gatewayFile = path.join(API_SOURCE_ROOT, 'gateway', 'agent.gateway.ts');
  const gateway = parseSource(gatewayFile);
  const aiEventTypes = collectAiEventTypes();
  const visitGateway = (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      ts.forEachChild(node, visitGateway);
      return;
    }
    const method = node.expression.name.text;
    const receiver = receiverName(node.expression.expression);
    if (method === 'onAny') {
      if (receiver === 'client') addUnsafe('socketio|proxy-relay|browser-to-target-on-any', gatewayFile, gateway, node);
      if (receiver === 'upstream') addUnsafe('socketio|proxy-relay|target-to-browser-on-any', gatewayFile, gateway, node);
    }
    if ((method === 'on' || method === 'once') && node.arguments.length > 0) {
      if (receiver === 'client') {
        for (const event of staticValues(node.arguments[0], gateway, node)) add('browser-command', 'browser_to_api', event, 'browser-handler', gatewayFile, gateway, node);
      } else if (receiver === 'agent') {
        for (const event of staticValues(node.arguments[0], gateway, node)) {
          const channel = event === 'disconnect' ? 'agent-lifecycle' : 'agent-telemetry';
          const direction = event === 'disconnect' ? 'transport_lifecycle' : 'agent_to_api';
          add(channel, direction, event, 'api-handler', gatewayFile, gateway, node);
        }
      } else if (receiver === 'upstream') {
        for (const event of staticValues(node.arguments[0], gateway, node)) add('proxy-lifecycle', 'transport_lifecycle', event, 'upstream-handler', gatewayFile, gateway, node);
      }
    }
    if (method === 'emit' && node.arguments.length > 0) {
      const eventArgument = node.arguments[0];
      if (receiver === 'agent') {
        for (const event of staticValues(eventArgument, gateway, node)) add('agent-rpc', 'api_to_agent', event, 'api-emitter', gatewayFile, gateway, node);
      } else if (receiver !== 'upstream' &&
        (receiver === 'client' || receiver.startsWith('this.server') || receiver.startsWith('agent.broadcast'))) {
        if (isInsideOnAnyRelay(node)) {
          // The enclosing onAny is recorded as a deny-only legacy finding.
        } else if (ts.isTemplateExpression(eventArgument) && eventArgument.getText(gateway) === '`ai:${event.type}`') {
          for (const type of aiEventTypes) add('browser-notification', 'api_to_browser', `ai:${type}`, 'api-emitter', gatewayFile, gateway, node);
        } else {
          for (const event of staticValues(eventArgument, gateway, node)) add('browser-notification', 'api_to_browser', event, 'api-emitter', gatewayFile, gateway, node);
        }
      }
    }
    ts.forEachChild(node, visitGateway);
  };
  visitGateway(gateway);

  return {
    actions: [...actions.values()].map((entry) => ({
      ...entry,
      codeOwners: entry.codeOwners.sort((a, b) => `${a.file}|${a.symbol}`.localeCompare(`${b.file}|${b.symbol}`)),
      sourceBindings: [...entry.sourceBindings].sort(),
    })).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
    legacyUnsafeFindings: [...unsafeFindings.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
  };
};

// These controllers are source-owned by the singleton control plane rather
// than by a selected panel.  Do not infer this from a URL prefix: notably,
// ProxyController also owns the current `/api/servers` registry endpoints.
const MASTER_CONTROLLER_FILES = new Set([
  'api/src/auth/auth.controller.ts',
  'api/src/auth/basic-auth.controller.ts',
  'api/src/auth/basic-auth-internal.controller.ts',
  'api/src/auth/setup.controller.ts',
  'api/src/federation/federation-master-enrollment.controller.ts',
  'api/src/federation/federation-rollout.controller.ts',
  'api/src/federation/remote-context.controller.ts',
  'api/src/panel-access/panel-access-cutover.controller.ts',
  'api/src/panel-update/panel-update.controller.ts',
  'api/src/proxy/proxy.controller.ts',
  'api/src/proxy/federation-trust-lifecycle.controller.ts',
  'api/src/vpn/federated-vpn-subscription.controller.ts',
  'api/src/webhooks/webhook-management.controller.ts',
]);

const MASTER_MIGRATION_SYMBOLS = new Set([
  // MigrationController labels these two handlers as the main-server
  // orchestrator and its persisted orchestration status.
  'MigrationController.startMigration',
  'MigrationController.getStatus',
]);

const MASTER_CONTROLLER_SYMBOLS = new Set([
  'PanelSettingsController.getAppearance',
  'PanelSettingsController.setAppearance',
]);

const classifyHttpOwner = (route) => {
  if (
    MASTER_CONTROLLER_FILES.has(route.codeOwner.file) ||
    MASTER_CONTROLLER_SYMBOLS.has(route.codeOwner.symbol)
  ) return 'master';
  if (route.codeOwner.file === 'api/src/migration/migration.controller.ts') {
    return MASTER_MIGRATION_SYMBOLS.has(route.codeOwner.symbol) ? 'master' : 'direct';
  }
  if (route.publicRoute) return 'public';
  return 'target';
};

const traceabilityForHttp = (route) => {
  const routeTemplate = route.routeTemplate;
  const traceability = { cf: [], a: ['A19'], sp: [], im: [], bn: [] };
  if (routeTemplate.startsWith('/api/auth/') || routeTemplate.startsWith('/api/setup/')) {
    traceability.cf.push('CF2', 'CF3');
    traceability.im.push('IM4');
  }
  if (routeTemplate.startsWith('/api/auth/basic-auth')) traceability.im.push('IM5');
  if (routeTemplate.startsWith('/api/dashboard/') || routeTemplate === '/api/system/metrics') traceability.sp.push('SP1');
  if (routeTemplate.startsWith('/api/migration/')) {
    traceability.sp.push('SP7');
    traceability.im.push('IM3');
  }
  if (
    routeTemplate.startsWith('/api/admin/update') ||
    routeTemplate.startsWith('/api/federation/v1/target-update') ||
    routeTemplate.endsWith('/update-status')
  ) {
    traceability.cf.push('CF19', 'CF20');
    traceability.sp.push('SP8');
  }
  if (routeTemplate === '/api/health/:siteId/pings') traceability.bn.push('BN1');
  if (routeTemplate === '/api/deploy/webhook/:domain') {
    traceability.cf.push('CF10');
    traceability.bn.push('BN2');
  }
  if (
    routeTemplate.startsWith('/api/public/v1/webhooks/') ||
    routeTemplate.includes('/webhook-routes') ||
    routeTemplate.includes('/webhook-deliveries') ||
    routeTemplate.startsWith('/api/federation/v1/webhooks/')
  ) traceability.cf.push('CF10');
  if (
    routeTemplate.startsWith('/api/vpn/sub/') ||
    routeTemplate.startsWith('/api/public/v1/vpn/subscriptions/') ||
    routeTemplate.includes('/vpn-subscriptions') ||
    routeTemplate.startsWith('/api/federation/v1/vpn/fragments/')
  ) traceability.cf.push('CF8');
  if (routeTemplate.includes('adminer-ticket') || routeTemplate.includes('manticore-ticket')) traceability.cf.push('CF7');
  if (routeTemplate.includes('/modx/admin-login') || routeTemplate.startsWith('/api/public/v1/modx/login')) {
    traceability.cf.push('CF10');
    traceability.sp.push('SP5');
  }
  if (routeTemplate.startsWith('/api/backup-exports/') || routeTemplate.includes('/download')) traceability.cf.push('CF9', 'CF18');
  if (routeTemplate.startsWith('/api/panel-access/')) traceability.cf.push('CF13', 'CF21');
  if (routeTemplate.includes('/panel-access/cutovers')) traceability.cf.push('CF13', 'CF21');
  if (routeTemplate.startsWith('/api/proxy/')) traceability.cf.push('CF4', 'CF5', 'CF10', 'CF16', 'CF18', 'CF19', 'CF21');
  return Object.fromEntries(Object.entries(traceability).map(([key, values]) => [key, [...new Set(values)].sort()]));
};

const traceabilityForSocket = (entry) => {
  const traceability = { cf: [], a: ['A19'], sp: [], im: [], bn: [] };
  if (entry.channel === 'browser-command' || entry.channel === 'browser-notification' || entry.channel === 'proxy-lifecycle') {
    traceability.cf.push('CF5', 'CF15');
  }
  if (entry.event.startsWith('ai:')) traceability.cf.push('CF6');
  if (entry.channel === 'agent-rpc' || entry.channel === 'agent-telemetry') traceability.cf.push('CF16', 'CF17');
  if (entry.event.startsWith('migrate:hostpanel:')) {
    traceability.sp.push('SP3', 'SP7');
    traceability.im.push('IM3');
  }
  return Object.fromEntries(Object.entries(traceability).map(([key, values]) => [key, [...new Set(values)].sort()]));
};

const actionIdPart = (value) => value
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .replace(/^-+|-+$/g, '')
  .toLowerCase() || 'root';

const currentRelayTimeout = () => ({
  timeoutMs: 30_000,
  source: 'ProxyService.LEGACY_REQUEST_TIMEOUT_MS',
});

const requestMediaForHttp = (route) => {
  if (
    route.method === 'PUT' &&
    route.routeTemplate === '/api/public/v1/transfers/:id/upload'
  ) return ['application/octet-stream'];
  return route.multipart ? ['multipart/form-data'] : ['application/json'];
};

const responseMediaForHttp = (route) => {
  if ((route.method === 'GET' || route.method === 'HEAD') && /(?:\/download|\/content|\/stream)(?:\/|$)/.test(route.routeTemplate)) {
    return ['application/octet-stream'];
  }
  if (
    route.routeTemplate.startsWith('/api/vpn/sub/') ||
    route.routeTemplate.startsWith('/api/public/v1/vpn/subscriptions/')
  ) return ['text/plain'];
  return ['application/json'];
};

const DURABLE_OPERATION_ROUTES = new Set([
  'POST /api/federation/v1/target-update',
  'POST /api/backup-exports/staged',
  'POST /api/backups/trigger',
  'POST /api/backups/:id/restore',
  'DELETE /api/backups/:id',
  'POST /api/backups/panel-data/:id/run',
  'POST /api/backups/server-paths/:id/run',
  'POST /api/backups/site-schedules/:id/run',
  'POST /api/sites/:siteId/restic-checks',
  'POST /api/sites/:siteId/restic-snapshots/:snapshotId/restore',
  'POST /api/country-block/refresh-db',
  'POST /api/country-block/sync',
  'POST /api/dns/providers',
  'POST /api/dns/providers/:id/test',
  'POST /api/dns/providers/:id/sync',
  'POST /api/dns/zones/:id/refresh',
  'POST /api/dns/zones/:id/templates',
  'POST /api/firewall/presets/:name/apply',
  'POST /api/firewall/sync',
  'POST /api/panel-access/federation-cutovers',
  'POST /api/php/install',
  'DELETE /api/php/uninstall/:version',
  'POST /api/php/:version/extensions/install',
  'POST /api/system/updates/check',
  'POST /api/system/updates/install',
  'POST /api/system/updates/upgrade-all',
  'POST /api/services/:key/install',
  'DELETE /api/services/:key',
  'POST /api/services/:key/restart',
  'POST /api/sites/:siteId/services/:key/enable',
  'DELETE /api/sites/:siteId/services/:key',
  'POST /api/sites/:siteId/services/:key/start',
  'POST /api/sites/:siteId/services/:key/stop',
  'PATCH /api/sites/:siteId/services/:key',
  'POST /api/sites/:siteId/domains/:domainId/ssl/issue',
  'POST /api/sites/:siteId/domains/:domainId/ssl/revoke',
  'POST /api/storage-locations/:id/test',
  'POST /api/storage/:siteId/top-files/scan',
  'POST /api/vpn/install/:protocol',
  'DELETE /api/vpn/install/:protocol',
  'POST /api/vpn/sni-health-check',
  'POST /api/sites/:siteId/domains/:domainId/node/quick-commands/:id/run',
  'POST /api/sites/:siteId/domains/:domainId/deploy',
  'POST /api/sites/:siteId/domains/:domainId/deploys/:id/rollback',
  'POST /api/sites/:siteId/domains/:domainId/application/retry',
  'PUT /api/sites/:siteId/domains/:domainId/php-pool-config',
  'POST /api/sites/:siteId/domains/:domainId/modx/admin-password',
  'POST /api/sites/:siteId/domains/:domainId/modx/update',
  'POST /api/sites/:siteId/domains/:domainId/modx/doctor/scan',
  'POST /api/sites/:siteId/domains/:domainId/modx/cleanup-setup',
  'POST /api/sites/:siteId/domains/:domainId/permissions/normalize',
  'DELETE /api/sites/:siteId/domains/:domainId/databases/:id',
  'POST /api/sites/:siteId/domains/:domainId/databases/:id/export',
  'POST /api/sites/:siteId/domains/:domainId/databases/:id/import',
  'POST /api/sites/:siteId/domains/:domainId/databases',
  'POST /api/sites/:siteId/domains/:domainId/databases/:id/reset-password',
  'POST /api/sites/:siteId/domains/:domainId/files/upload-commit',
  'POST /api/sites/:siteId/restic-diff/file',
  'POST /api/sites/:siteId/restic-diff/file-live',
  'POST /api/sites/:siteId/restic-diff/live',
  'POST /api/sites/:siteId/restic-diff/snapshots',
  'POST /api/backups/:id/tree/query',
  'POST /api/sites/:siteId/restic-snapshots/query',
  'POST /api/sites/:siteId/restic-snapshots/:snapshotId/tree/query',
  'POST /api/admin/migrate-hostpanel/:id/items/:itemId/force-retry',
  'POST /api/sites',
  'POST /api/sites/:id/duplicate',
  'POST /api/sites/nginx/rebuild-all',
  'DELETE /api/sites/:id',
  'POST /api/sites/:id/domains',
  'PUT /api/sites/:id/domains/:domainId',
  'DELETE /api/sites/:id/domains/:domainId',
  'POST /api/sites/:id/domains/:domainId/make-primary',
  'PUT /api/sites/:id/domains/:domainId/aliases',
  'PUT /api/sites/:id/domains/:domainId/nginx/settings',
  'PUT /api/sites/:id/domains/:domainId/nginx/custom',
]);

const STAGED_ARTIFACT_ROUTES = new Set([
  'POST /api/backup-exports/:id/delivery',
  'POST /api/backups/:id/download-session',
  'POST /api/sites/:siteId/domains/:domainId/databases/:id/import-session',
  'POST /api/sites/:siteId/domains/:domainId/databases/:id/exports/:operationId/delivery',
  'POST /api/sites/:siteId/domains/:domainId/files/download-session',
  'POST /api/sites/:siteId/domains/:domainId/files/upload-session',
]);

const executionModeForHttp = (route, owner) => {
  if (owner === 'public') return 'PUBLIC_ENDPOINT';
  if (
    route.routeTemplate.includes('adminer-ticket') ||
    route.routeTemplate.includes('manticore-ticket') ||
    route.routeTemplate.includes('/modx/admin-login')
  ) {
    return 'APP_HANDOFF';
  }
  if (route.method === 'GET' && /(?:\/download|\/content|\/stream)(?:\/|$)/.test(route.routeTemplate)) {
    return 'GENERATED_STREAM';
  }
  if (STAGED_ARTIFACT_ROUTES.has(`${route.method} ${route.routeTemplate}`)) {
    return 'STAGED_ARTIFACT';
  }
  if (DURABLE_OPERATION_ROUTES.has(`${route.method} ${route.routeTemplate}`)) {
    return 'OPERATION';
  }
  return 'INTERACTIVE';
};

const socketRoles = (entry) => {
  if (entry.channel === 'agent-rpc' || entry.channel === 'agent-telemetry' || entry.channel === 'agent-lifecycle') {
    return ['SERVICE'];
  }
  if (entry.channel === 'proxy-lifecycle') return ['ADMIN'];
  return ['ADMIN', 'MANAGER', 'VIEWER'];
};

const verification = {
  test: 'T-TRACE-001',
  metric: {
    name: 'unclassified-source-declarations',
    comparator: 'EQ',
    threshold: 0,
    unit: 'declarations',
  },
};

const matrixEntriesFromSurface = (surface) => {
  const http = surface.http.map((route) => {
    const actionId = `http.${route.method.toLowerCase()}.${actionIdPart(route.routeTemplate.slice('/api/'.length))}`;
    const owner = classifyHttpOwner(route);
    const timeout = currentRelayTimeout(route.routeTemplate);
    const readOnly = route.method === 'GET' || route.method === 'HEAD' || route.method === 'OPTIONS';
    return {
      actionId,
      transport: { kind: 'http', method: route.method, routeTemplate: route.routeTemplate },
      owner,
      authorization: {
        roles: route.roles,
        permissions: [actionId],
      },
      request: {
        schema: route.multipart
          ? `${route.codeOwner.symbol}.multipart-request`
          : `${route.codeOwner.symbol}.request`,
        media: requestMediaForHttp(route),
      },
      response: {
        schema: `${route.codeOwner.symbol}.response`,
        media: responseMediaForHttp(route),
      },
      execution: { mode: executionModeForHttp(route, owner) },
      idempotency: route.idempotencyDeclared
        ? { policy: 'DECLARED', currentBehavior: 'IDEMPOTENCY_KEY_DECLARED_IN_CONTROLLER_SIGNATURE' }
        : {
            policy: 'NOT_DECLARED',
            currentBehavior: readOnly ? 'READ_ONLY_REQUEST' : 'CONTROLLER_HAS_NO_IDEMPOTENCY_KEY',
          },
      cancellation: {
        policy: route.routeTemplate.includes('/cancel') ? 'SUPPORTED' : 'UNSUPPORTED',
        currentBehavior: route.routeTemplate.includes('/cancel')
          ? 'EXPLICIT_CONTROLLER_CANCEL_ROUTE'
          : 'NO_CONTROLLER_CANCELLATION_CONTRACT',
      },
      deadline: {
        connectMs: 5_000,
        headersMs: 15_000,
        idleMs: executionModeForHttp(route, owner) === 'GENERATED_STREAM' ? 60_000 : 30_000,
        operationMs: timeout.timeoutMs,
        currentTimeoutMs: timeout.timeoutMs,
        currentTimeoutSource: timeout.source,
      },
      capability: `${actionId}.v1`,
      legacy: {
        behavior: owner === 'target'
          ? 'CURRENT_GENERIC_STATIC_BEARER_RELAY_NOT_ACTIVATED_FOR_V1'
          : 'CONTROL_OR_PUBLIC_SURFACE_NOT_DELEGATED',
        remoteActivation: 'DENY',
      },
      codeOwner: route.codeOwner,
      sourceKey: route.sourceKey,
      sourceBindings: [route.sourceKey],
      traceability: traceabilityForHttp(route),
      verification,
    };
  });
  const socket = surface.socket.actions.map((entry) => {
    const actionId = `ws.${entry.channel}.${actionIdPart(entry.event)}`;
    const cancel = entry.event.includes('cancel');
    return {
      actionId,
      transport: { kind: 'socket.io', channel: entry.channel, event: entry.event, direction: entry.direction },
      owner: entry.channel === 'proxy-lifecycle' ? 'master' : 'target',
      authorization: { roles: socketRoles(entry), permissions: [actionId] },
      request: { schema: `${actionId}.payload`, media: ['application/json'] },
      response: { schema: `${actionId}.payload`, media: ['application/json'] },
      execution: { mode: 'INTERACTIVE' },
      idempotency: {
        policy: 'NOT_DECLARED',
        currentBehavior: 'CURRENT_SOCKET_EVENT_HAS_NO_DURABLE_IDEMPOTENCY_CONTRACT',
      },
      cancellation: {
        policy: cancel ? 'SUPPORTED' : 'UNSUPPORTED',
        currentBehavior: cancel ? 'EXPLICIT_CANCEL_EVENT' : 'NO_TYPED_CANCELLATION_CONTRACT',
      },
      deadline: {
        connectMs: 5_000,
        headersMs: 10_000,
        idleMs: 30_000,
        operationMs: 30_000,
        currentTimeoutMs: 30_000,
        currentTimeoutSource: 'AgentGateway.current-event-ack-budget',
      },
      capability: `${actionId}.v1`,
      legacy: {
        behavior: 'CURRENT_UNTYPED_SOCKET_EVENT_NOT_ACTIVATED_FOR_V1',
        remoteActivation: 'DENY',
      },
      codeOwner: entry.codeOwners[0],
      sourceKey: entry.sourceKey,
      sourceBindings: entry.sourceBindings,
      traceability: traceabilityForSocket(entry),
      verification,
    };
  });
  const entries = [...http, ...socket];
  const duplicates = new Set();
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.actionId)) duplicates.add(entry.actionId);
    seen.add(entry.actionId);
  }
  if (duplicates.size > 0) throw new RemotePanelInventoryError(`Generated duplicate action IDs: ${[...duplicates].join(', ')}`);
  return entries.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
};

const legacyFindingsFromSurface = (surface) => surface.socket.legacyUnsafeFindings.map((finding) => ({
  findingId: `ws.proxy.relay.${actionIdPart(finding.sourceKey.split('|').at(-1))}`,
  transport: { kind: 'socket.io', channel: 'proxy-relay', event: '*', direction: 'relay_bidirectional' },
  codeOwner: finding.codeOwner,
  sourceKey: finding.sourceKey,
  behavior: 'CURRENT_GENERIC_ON_ANY_PROXY_RELAY_UNCHARACTERIZED',
  remoteActivation: 'DENY',
  verification: {
    test: 'T-ACT-001 remote-panel action inventory',
    metric: { name: 'unclassified-source-declarations', comparator: 'EQ', threshold: 0, unit: 'declarations' },
  },
}));

const matrixDocumentFromSurface = (surface) => ({
  schemaVersion: 'meowbox.remote-panel-parity.action-matrix/v1',
  actions: matrixEntriesFromSurface(surface),
  legacyUnsafeFindings: legacyFindingsFromSurface(surface),
});

const discoverCurrentSurface = () => {
  const http = discoverHttpRoutes();
  const socket = discoverSocketEvents();
  return { http, socket };
};

module.exports = {
  RemotePanelInventoryError,
  discoverCurrentSurface,
  matrixEntriesFromSurface,
  legacyFindingsFromSurface,
  matrixDocumentFromSurface,
};

if (require.main === module) {
  const surface = discoverCurrentSurface();
  const mode = process.argv[2];
  if (mode === '--summary') {
    const byMethod = Object.fromEntries(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'HEAD', 'OPTIONS']
      .map((method) => [method, surface.http.filter((route) => route.method === method).length])
      .filter(([, count]) => count > 0));
    const byChannel = Object.fromEntries([...new Set(surface.socket.actions.map((entry) => entry.channel))]
      .sort()
      .map((channel) => [channel, surface.socket.actions.filter((entry) => entry.channel === channel).length]));
    process.stdout.write(`${JSON.stringify({ http: { total: surface.http.length, byMethod }, socket: { total: surface.socket.actions.length, byChannel, unsafeFindings: surface.socket.legacyUnsafeFindings.length } }, null, 2)}\n`);
  } else if (mode === '--entries') {
    process.stdout.write(`${JSON.stringify({ actions: matrixEntriesFromSurface(surface), legacyUnsafeFindings: legacyFindingsFromSurface(surface) }, null, 2)}\n`);
  } else if (mode === '--document') {
    process.stdout.write(`${JSON.stringify(matrixDocumentFromSurface(surface))}\n`);
  } else {
    process.stdout.write('Usage: node api/test/remote-panel-parity-inventory.js --summary|--entries|--document\n');
  }
}
