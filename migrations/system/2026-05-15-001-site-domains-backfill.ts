import type { SystemMigration } from './_types';

/**
 * Backfill мульти-доменной модели сайтов.
 *
 * Для каждого существующего сайта создаёт ровно один основной домен
 * (SiteDomain, isPrimary=true, position=0), копируя в него
 * domain / aliases / appPort / httpsRedirect и все layered nginx-настройки
 * сайта. `filesRelPath` основного домена = null (наследует Site.filesRelPath —
 * общий дефолт сайта).
 *
 * Перепривязывает существующие ssl_certificates к этому основному домену
 * (`domain_id`): в новой модели сертификат принадлежит домену, а не сайту.
 *
 * Идемпотентность:
 *  - сайт, у которого уже есть SiteDomain, не дублируется;
 *  - сертификат с уже выставленным `domainId` пропускается;
 *  - аномалия «домены есть, но ни один не isPrimary» чинится (первый по
 *    position помечается главным).
 *
 * ВАЖНО: запускается ПОСЛЕ prisma-миграции 14_site_multi_domain (она создаёт
 * таблицу site_domains и колонку ssl_certificates.domain_id).
 */
const migration: SystemMigration = {
  id: '2026-05-15-001-site-domains-backfill',
  description: 'Backfill: каждый сайт → 1 основной домен (SiteDomain), repoint ssl_certificates на домен',

  async up(ctx) {
    const sites = await ctx.prisma.site.findMany();
    ctx.log(`Сайтов к обработке: ${sites.length}`);

    let createdDomains = 0;
    let fixedPrimary = 0;
    let linkedCerts = 0;

    for (const site of sites) {
      // -----------------------------------------------------------------
      // 1. Основной домен.
      // -----------------------------------------------------------------
      let primary = await ctx.prisma.siteDomain.findFirst({
        where: { siteId: site.id, isPrimary: true },
      });

      if (!primary) {
        // Аномалия: домены у сайта есть, но ни один не помечен primary.
        const orphan = await ctx.prisma.siteDomain.findFirst({
          where: { siteId: site.id },
          orderBy: { position: 'asc' },
        });

        if (orphan) {
          if (ctx.dryRun) {
            ctx.log(`[dry-run] site ${site.name}: пометил бы ${orphan.domain} как главный`);
          } else {
            primary = await ctx.prisma.siteDomain.update({
              where: { id: orphan.id },
              data: { isPrimary: true, position: 0 },
            });
            fixedPrimary++;
            ctx.log(`site ${site.name}: домены есть без primary — главным помечен ${orphan.domain}`);
          }
        } else if (ctx.dryRun) {
          ctx.log(`[dry-run] site ${site.name}: создал бы основной домен ${site.domain}`);
        } else {
          primary = await ctx.prisma.siteDomain.create({
            data: {
              siteId: site.id,
              domain: site.domain,
              isPrimary: true,
              position: 0,
              aliases: site.aliases || '[]',
              // null → наследует Site.filesRelPath (общий дефолт сайта).
              filesRelPath: null,
              appPort: site.appPort,
              httpsRedirect: site.httpsRedirect,
              nginxClientMaxBodySize: site.nginxClientMaxBodySize,
              nginxFastcgiReadTimeout: site.nginxFastcgiReadTimeout,
              nginxFastcgiSendTimeout: site.nginxFastcgiSendTimeout,
              nginxFastcgiConnectTimeout: site.nginxFastcgiConnectTimeout,
              nginxFastcgiBufferSizeKb: site.nginxFastcgiBufferSizeKb,
              nginxFastcgiBufferCount: site.nginxFastcgiBufferCount,
              nginxHttp2: site.nginxHttp2,
              nginxHsts: site.nginxHsts,
              nginxGzip: site.nginxGzip,
              nginxRateLimitEnabled: site.nginxRateLimitEnabled,
              nginxRateLimitRps: site.nginxRateLimitRps,
              nginxRateLimitBurst: site.nginxRateLimitBurst,
              nginxCustomConfig: site.nginxCustomConfig,
            },
          });
          createdDomains++;
          ctx.log(`site ${site.name}: создан основной домен ${site.domain}`);
        }
      }

      // -----------------------------------------------------------------
      // 2. Перепривязка сертификата к основному домену.
      // До этой миграции у сайта мог быть максимум один сертификат
      // (ssl_certificates.site_id был UNIQUE).
      // -----------------------------------------------------------------
      const cert = await ctx.prisma.sslCertificate.findFirst({
        where: { siteId: site.id, domainId: null },
      });
      if (cert) {
        if (ctx.dryRun) {
          ctx.log(`[dry-run] site ${site.name}: cert ${cert.id} привязал бы к основному домену`);
        } else if (primary) {
          await ctx.prisma.sslCertificate.update({
            where: { id: cert.id },
            data: { domainId: primary.id },
          });
          linkedCerts++;
          ctx.log(`site ${site.name}: cert ${cert.id} привязан к ${primary.domain}`);
        }
      }
    }

    ctx.log(
      `Готово: создано доменов ${createdDomains}, починено primary ${fixedPrimary}, ` +
      `привязано сертификатов ${linkedCerts}`,
    );
  },
};

export default migration;
