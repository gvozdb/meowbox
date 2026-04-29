import { DnsRecordInput } from '../providers/dns-provider.interface';

export type MailTemplate = 'YANDEX_MAIL' | 'YANDEX_360' | 'VK_MAIL';

export const MAIL_TEMPLATES: readonly MailTemplate[] = ['YANDEX_MAIL', 'YANDEX_360', 'VK_MAIL'] as const;

export interface MailTemplateExtras {
  /** Публичный ключ DKIM (без префикса "v=DKIM1; k=rsa; p="). */
  dkim?: string;
  /** Имя селектора DKIM (default: "mail" / "mailru"). */
  dkimSelector?: string;
}

const DEFAULT_TTL = 3600;

export function yandexMailTemplate(extras: MailTemplateExtras = {}): DnsRecordInput[] {
  const recs: DnsRecordInput[] = [
    { type: 'MX', name: '@', content: 'mx.yandex.net.', ttl: DEFAULT_TTL, priority: 10 },
    { type: 'TXT', name: '@', content: 'v=spf1 redirect=_spf.yandex.net', ttl: DEFAULT_TTL },
    { type: 'CNAME', name: 'mail', content: 'domain.mail.yandex.net.', ttl: DEFAULT_TTL },
    { type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none;', ttl: DEFAULT_TTL },
  ];
  if (extras.dkim) {
    const sel = extras.dkimSelector || 'mail';
    recs.push({
      type: 'TXT',
      name: `${sel}._domainkey`,
      content: `v=DKIM1; k=rsa; t=s; p=${extras.dkim}`,
      ttl: DEFAULT_TTL,
    });
  }
  return recs;
}

export function yandex360Template(extras: MailTemplateExtras = {}): DnsRecordInput[] {
  const base = yandexMailTemplate(extras);
  base.push({
    type: 'CNAME',
    name: '_domainconnect',
    content: '_domainconnect.connect.domains.yandex.net.',
    ttl: DEFAULT_TTL,
  });
  return base;
}

export function vkMailTemplate(extras: MailTemplateExtras = {}): DnsRecordInput[] {
  const recs: DnsRecordInput[] = [
    { type: 'MX', name: '@', content: 'emx.mail.ru.', ttl: DEFAULT_TTL, priority: 10 },
    { type: 'TXT', name: '@', content: 'v=spf1 redirect=_spf.mail.ru', ttl: DEFAULT_TTL },
    { type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none;', ttl: DEFAULT_TTL },
  ];
  if (extras.dkim) {
    const sel = extras.dkimSelector || 'mailru';
    recs.push({
      type: 'TXT',
      name: `${sel}._domainkey`,
      content: `v=DKIM1; k=rsa; t=s; p=${extras.dkim}`,
      ttl: DEFAULT_TTL,
    });
  }
  return recs;
}

export function getMailTemplate(template: MailTemplate, extras: MailTemplateExtras = {}): DnsRecordInput[] {
  switch (template) {
    case 'YANDEX_MAIL': return yandexMailTemplate(extras);
    case 'YANDEX_360': return yandex360Template(extras);
    case 'VK_MAIL': return vkMailTemplate(extras);
    default: throw new Error(`Unknown mail template: ${template}`);
  }
}
