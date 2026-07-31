import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { parseJsonObject } from '../common/json-array';
import { resolveApplicationRoot } from './domain-validation';

const MODX_PRESETS = new Set(['MODX_REVO', 'MODX_3']);

@Injectable()
export class DomainContextService {
  constructor(private readonly prisma: PrismaService) {}

  async requireOwnedSiteDomain(
    siteId: string,
    domainId: string,
    userId: string,
    role: string,
  ) {
    const domain = await this.prisma.siteDomain.findFirst({
      where: { id: domainId, siteId },
      include: {
        site: true,
        sslCertificate: true,
        databases: true,
      },
    });

    if (!domain) {
      throw new NotFoundException('Domain application not found');
    }
    if (role !== 'ADMIN' && domain.site.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    const applicationRoot = resolveApplicationRoot(
      domain.site.rootPath,
      domain.filesRelPath,
      { resolveSymlinks: true },
    );

    return {
      site: domain.site,
      domain,
      applicationRoot,
      phpEnabled: domain.phpVersion !== null,
      isModx: MODX_PRESETS.has(domain.preset),
      envVars: parseJsonObject<Record<string, string>>(domain.envVars, {}),
      primaryDatabase:
        domain.databases.find((database) => database.purpose === 'APP_PRIMARY') ??
        null,
    };
  }
}
