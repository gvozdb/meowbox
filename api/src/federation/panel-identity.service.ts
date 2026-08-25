import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import {
  FederationManifestKey,
  generateFederationManifestKey,
  openFederationManifestPrivateKey,
} from './federation-key-material';

export type PanelInstallationRole = 'MASTER' | 'TARGET';

export interface LocalPanelIdentity {
  installationId: string;
  installationRole: PanelInstallationRole;
  manifestKid: string;
  manifestPublicKeySpki: string;
  manifestPrivateKeyEnc: string;
}

function installationRole(config: ConfigService): PanelInstallationRole {
  const configured = String(config.get('MEOWBOX_INSTALLATION_ROLE', 'MASTER')).toUpperCase();
  if (configured !== 'MASTER' && configured !== 'TARGET') {
    throw new Error('MEOWBOX_INSTALLATION_ROLE must be MASTER or TARGET');
  }
  return configured;
}

function assertCompleteIdentity(identity: {
  installationId: string;
  installationRole: string;
  manifestKid: string | null;
  manifestPublicKeySpki: string | null;
  manifestPrivateKeyEnc: string | null;
}): LocalPanelIdentity {
  if (
    (identity.installationRole !== 'MASTER' && identity.installationRole !== 'TARGET') ||
    !identity.manifestKid ||
    !identity.manifestPublicKeySpki ||
    !identity.manifestPrivateKeyEnc
  ) {
    throw new Error('Panel identity is incomplete or invalid');
  }
  openFederationManifestPrivateKey(identity.manifestPrivateKeyEnc, {
    installationId: identity.installationId,
    kid: identity.manifestKid,
  });
  return identity as LocalPanelIdentity;
}

@Injectable()
export class PanelIdentityService implements OnModuleInit {
  private cached: LocalPanelIdentity | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.getLocalIdentity();
  }

  async getLocalIdentity(): Promise<LocalPanelIdentity> {
    if (this.cached) return this.cached;

    const existing = await this.prisma.panelIdentity.findUnique({ where: { id: '_' } });
    if (existing) {
      const keyFields = [
        existing.manifestKid,
        existing.manifestPublicKeySpki,
        existing.manifestPrivateKeyEnc,
      ];
      const present = keyFields.filter(Boolean).length;
      if (present > 0 && present < keyFields.length) {
        throw new Error('Panel identity manifest key is partially initialized');
      }
      if (present === keyFields.length) {
        this.cached = assertCompleteIdentity(existing);
        return this.cached;
      }
    }

    const installationId = existing?.installationId ?? randomUUID();
    const manifestKey: FederationManifestKey =
      generateFederationManifestKey(installationId);
    if (existing) {
      await this.prisma.panelIdentity.updateMany({
        where: {
          id: '_',
          manifestKid: null,
          manifestPublicKeySpki: null,
          manifestPrivateKeyEnc: null,
        },
        data: {
          manifestKid: manifestKey.kid,
          manifestPublicKeySpki: manifestKey.publicKeySpki,
          manifestPrivateKeyEnc: manifestKey.encryptedPrivateKey,
        },
      });
    } else {
      try {
        await this.prisma.panelIdentity.create({
          data: {
            id: '_',
            installationId,
            installationRole: installationRole(this.config),
            manifestKid: manifestKey.kid,
            manifestPublicKeySpki: manifestKey.publicKeySpki,
            manifestPrivateKeyEnc: manifestKey.encryptedPrivateKey,
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }
    }
    const identity = await this.prisma.panelIdentity.findUniqueOrThrow({
      where: { id: '_' },
    });
    this.cached = assertCompleteIdentity(identity);
    return this.cached;
  }

  browserSafeIdentity(identity: LocalPanelIdentity): Readonly<{
    installationId: string;
    installationRole: PanelInstallationRole;
    manifestKid: string;
  }> {
    return {
      installationId: identity.installationId,
      installationRole: identity.installationRole,
      manifestKid: identity.manifestKid,
    };
  }
}
