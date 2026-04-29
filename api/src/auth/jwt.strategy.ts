import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  sid?: string;
  scope?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    const secret = configService.getOrThrow<string>('JWT_ACCESS_SECRET');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload) {
    if (!payload.sub || !payload.role) {
      throw new UnauthorizedException('Invalid token payload');
    }
    // Защита от scope confusion: токены, выданные для одноразовых операций
    // (например download:export для скачивания бэкапа), НЕ должны работать
    // как обычные access-токены через Authorization: Bearer. Иначе любой
    // download-токен можно отправить на /sites/* и получить доступ.
    // Обычные access-токены поле `scope` не имеют.
    if (payload.scope) {
      throw new UnauthorizedException('Token scope is not valid for this endpoint');
    }

    // Возвращаем и `id`, и `sub` — исторически часть контроллеров читает `user.id`,
    // часть (audit interceptor и т.п.) — `user.sub`. Оставить один алиас =
    // сломать половину приложения, поэтому поддерживаем оба ключа.
    return {
      id: payload.sub,
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
      sid: payload.sid,
    };
  }
}
