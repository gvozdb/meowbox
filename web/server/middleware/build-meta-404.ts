import { existsSync } from 'fs';
import { join } from 'path';
import { createError, defineEventHandler, getRequestURL } from 'h3';

const BUILD_META_RE = /^\/_nuxt\/builds\/meta\/[A-Za-z0-9-]+\.json$/;

export default defineEventHandler((event) => {
  const pathname = getRequestURL(event).pathname;
  if (!BUILD_META_RE.test(pathname)) return;

  const publicPath = join(process.cwd(), '.output/public', pathname);
  if (!existsSync(publicPath)) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Build metadata not found',
    });
  }
});
