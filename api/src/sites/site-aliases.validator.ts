import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  DOMAIN_MAX_LENGTH,
  DOMAIN_REGEX,
} from '../common/validators/site-names';

@ValidatorConstraint({ name: 'SiteAliases', async: false })
export class SiteAliasesValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value == null) return true;
    if (!Array.isArray(value) || value.length > 64) return false;
    return value.every((item) => {
      if (typeof item === 'string') {
        return item.length <= DOMAIN_MAX_LENGTH && DOMAIN_REGEX.test(item);
      }
      if (!item || typeof item !== 'object') return false;
      const alias = item as Record<string, unknown>;
      return (
        typeof alias.domain === 'string' &&
        alias.domain.length <= DOMAIN_MAX_LENGTH &&
        DOMAIN_REGEX.test(alias.domain) &&
        (!('redirect' in alias) || typeof alias.redirect === 'boolean')
      );
    });
  }

  defaultMessage(): string {
    return 'aliases must contain valid domain names and optional redirect flags';
  }
}
