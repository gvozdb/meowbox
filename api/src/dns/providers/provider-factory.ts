import { DnsProvider, DnsProviderType } from './dns-provider.interface';
import { CloudflareProvider } from './cloudflare.provider';
import { YandexCloudProvider } from './yandex-cloud.provider';
import { VkCloudProvider } from './vk-cloud.provider';
import { Yandex360Provider } from './yandex-360.provider';

const cf = new CloudflareProvider();
const yc = new YandexCloudProvider();
const vk = new VkCloudProvider();
const y360 = new Yandex360Provider();

export function getProvider(type: string): DnsProvider {
  switch (type as DnsProviderType) {
    case 'CLOUDFLARE': return cf;
    case 'YANDEX_CLOUD': return yc;
    case 'VK_CLOUD': return vk;
    case 'YANDEX_360': return y360;
    default:
      throw new Error(`Unknown DNS provider type: ${type}`);
  }
}
