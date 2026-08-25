import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { LegacyRegistryFileService } from './legacy-registry-file.service';
import {
  encryptLegacyToken,
  legacyRegistryDigest,
  parseLegacyRegistry,
  renderLegacyRegistry,
} from './legacy-registry';
import { RemoteRegistryService } from './remote-registry.service';

export interface RegistryImportResult {
  generation: number;
  sourceDigest: string;
  imported: number;
}

@Injectable()
export class RegistryImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly legacyFile: LegacyRegistryFileService,
    private readonly registry: RemoteRegistryService,
  ) {}

  async importAuthoritativeJson(): Promise<RegistryImportResult> {
    await this.registry.assertControlPlane();
    if (await this.registry.authority() !== 'JSON') {
      throw new ConflictException('Legacy JSON is not authoritative');
    }
    const content = await this.legacyFile.read();
    const records = parseLegacyRegistry(content);
    const sourceDigest = legacyRegistryDigest(content);
    const latest = await this.prisma.registryProjectionJournal.findFirst({
      orderBy: { registryGeneration: 'desc' },
    });
    if (latest?.state === 'IMPORTED' && latest.sourceDigest === sourceDigest) {
      return {
        generation: latest.registryGeneration,
        sourceDigest,
        imported: records.length,
      };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const generation = await this.registry.nextGeneration(tx);
        for (const record of records) {
          const existing = await tx.remoteServer.findUnique({ where: { id: record.id } });
          if (existing?.mutationFrozenAt) throw new ConflictException('Remote registry is frozen');
          await tx.remoteServer.upsert({
            where: { id: record.id },
            create: {
              id: record.id,
              displayName: record.name,
              registryGeneration: generation,
              activationMode: 'LEGACY_UPGRADE_ONLY',
              topologyMode: 'PUBLIC',
              transportState: 'UNKNOWN',
              trustState: 'UNENROLLED',
              capabilityState: 'UNKNOWN',
              browserState: 'UNKNOWN',
              reasonCode: 'LEGACY_UPGRADE_REQUIRED',
              legacyEnabled: true,
              legacyUrl: record.url,
              legacyTokenEnc: encryptLegacyToken(record.id, record.token),
            },
            update: {
              displayName: record.name,
              registryGeneration: generation,
              legacyEnabled: true,
              legacyUrl: record.url,
              legacyTokenEnc: encryptLegacyToken(record.id, record.token),
            },
          });
        }
        await tx.registryProjectionJournal.create({
          data: {
            registryGeneration: generation,
            sourceDigest,
            state: 'IMPORTED',
          },
        });
        return { generation, sourceDigest, imported: records.length };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Legacy registry conflicts with an existing server identity');
      }
      throw error;
    }
  }

  async cutoverToDb(expectedSourceDigest: string): Promise<void> {
    await this.registry.assertControlPlane();
    if (await this.registry.authority() !== 'JSON') {
      throw new ConflictException('Legacy JSON is not authoritative');
    }
    const latest = await this.prisma.registryProjectionJournal.findFirst({
      orderBy: { registryGeneration: 'desc' },
    });
    if (!latest || latest.state !== 'IMPORTED' || latest.sourceDigest !== expectedSourceDigest) {
      throw new ConflictException('Registry import checkpoint does not match cutover request');
    }
    const source = await this.legacyFile.read();
    if (legacyRegistryDigest(source) !== expectedSourceDigest) {
      throw new ConflictException('Legacy registry changed after import');
    }
    const sourceRecords = parseLegacyRegistry(source);
    const projection = await this.registry.renderDbProjection();
    const projectedRecords = parseLegacyRegistry(projection);
    if (
      renderLegacyRegistry(sourceRecords) !== renderLegacyRegistry(projectedRecords)
    ) {
      throw new ConflictException('DB shadow registry does not exactly match authoritative JSON');
    }
    try {
      await this.legacyFile.writeMode600(projection);
      await this.prisma.registryProjectionJournal.update({
        where: { id: latest.id },
        data: {
          state: 'COMMITTED',
          projectionDigest: legacyRegistryDigest(projection),
          committedAt: new Date(),
        },
      });
    } catch (error) {
      await this.registry.freezeProjection(latest.id, 'CUTOVER_PROJECTION_FAILED');
      throw error;
    }
  }
}
