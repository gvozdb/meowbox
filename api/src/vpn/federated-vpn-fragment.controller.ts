import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { FederatedVpnFragmentService } from './federated-vpn-fragment.service';

@Controller('federation/v1/vpn/fragments')
export class FederatedVpnFragmentController {
  constructor(private readonly fragments: FederatedVpnFragmentService) {}

  @Get(':vpnUserId')
  @Roles('SERVICE')
  async getFragment(@Param('vpnUserId', ParseUUIDPipe) vpnUserId: string) {
    return {
      success: true,
      data: await this.fragments.create(vpnUserId),
    };
  }
}
